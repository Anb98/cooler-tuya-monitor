# cooler-tuya-api

A small thermostatic daemon that automatically turns a **Tuya smart plug**
ON/OFF to drive a cooling fan, based on **CPU** and **HDD** temperatures. It
is built for home servers / NAS boxes where a fan is plugged into a Tuya
smart socket instead of being wired directly to the motherboard.

The fan turns **ON** as soon as the CPU or any monitored disk crosses its
"high" temperature threshold, and only turns **OFF** once *all* monitored
sources have stayed below their "low" threshold continuously for a
configurable dwell period. This avoids short-cycling the fan and — most
importantly — the system is designed to **fail safe**: any sensor read
failure, Tuya communication problem, or uncertain state is treated as "keep
the fan ON" rather than risking silent overheating.

## What it does

- Polls CPU temperature from a Linux sysfs thermal zone.
- Polls HDD temperature via `smartctl` (SMART attribute 194) for one or more
  disks.
- Runs a pure hysteresis state machine: trigger threshold, OFF dwell timer,
  minimum-ON anti-short-cycle guard, hard critical-temperature safety
  override, and a sticky manual override.
- Drives a Tuya smart plug over the local LAN (no cloud dependency at
  runtime).
- Optionally exposes a small HTTP API (`/health`, `/status`, `/fan/on`,
  `/fan/off`, `/fan/auto`) for manual control and observability.
- Supports `DRY_RUN` mode to validate behavior via logs without ever
  actuating the plug.

## Prerequisites

- A Tuya-compatible smart plug that the fan is plugged into, reachable on
  your local network, with **local key** access (no cloud API calls are made
  at runtime — only local UDP/TCP to the plug).
- Docker (recommended deployment) **or** Node.js 24+ if running directly on
  the host.
- A host where `smartctl` can read your disks (the Docker image installs
  `smartmontools` for you). Running in Docker requires raw device access to
  the disks you want to monitor (see the Docker section below).
- Linux with a readable CPU thermal zone under
  `/sys/class/thermal/thermal_zone*/temp` (true for virtually all Linux
  single-board computers, NAS boxes, and standard x86 servers).

## Getting your Tuya `deviceId` and `localKey`

This project talks to your plug **locally** (LAN), not through Tuya's cloud
API, so you only need to extract the device's `id`, `key` (local key), and
`ip` once. The values do not change unless you reset/repair the device or
the manufacturer's firmware rotates the key.

1. **Create a Tuya IoT Platform account and project** (free tier is
   enough):
   - Go to <https://iot.tuya.com/> and sign up / log in.
   - Create a **Cloud Project** (Development → Create Cloud Project).
     Choose any industry/development method; it doesn't matter for local
     control.
   - Under your project, go to **Service API** and subscribe to:
     - `IoT Core`
     - `Authorization`
   - Go to **Devices → Link Tuya App Account**, and link the Tuya Smart /
     Smart Life app account that your plug is already paired with (scan the
     QR code from the app: *Me → (top-right icon) → Link Tuya App Account*
     in the Cloud panel, then scan it with your phone app).
   - Once linked, your plug should appear under **Devices → Device List**.

2. **Extract the local key using `tuya-cli`** (recommended, easiest path):

   ```bash
   npx @tuyapi/cli wizard
   ```

   The wizard will:
   - Ask for your Cloud Project's API credentials (**Access ID/Client ID**
     and **Access Secret/Client Secret**, found on the project's
     **Overview** tab).
   - Ask for a **virtual ID**: the Device ID of any device linked to your
     project. Copy it from **Devices → Device List** in the Cloud panel, or
     find it in the app under *device → ✏️ (edit) → Device Information →
     Virtual ID*.
   - Fetch every device linked to your app account and print each device's
     `id` (this is `TUYA_DEVICE_ID`) and `key` (this is `TUYA_LOCAL_KEY`).

   Example output:

   ```text
   [ { name: 'Cooling Fan Plug',
       id: 'ebXXXXXXXXXXXXXXXXXX',
       key: '0123456789abcdef' } ]
   ```

   If the wizard fails, see
   [Troubleshooting](#troubleshooting-there-was-an-issue-fetching-that-device)
   below.

3. **Find the plug's local IP address** (`TUYA_IP`): check your router's
   DHCP client list, or scan the LAN with
   [tinytuya](https://github.com/jasonacox/tinytuya) from any machine on
   the same network segment as the plug:

   ```bash
   pip install tinytuya
   python -m tinytuya scan
   ```

   The scan reports each Tuya device's **IP**, **ID**, and **protocol
   version**. (Tuya devices also listen on TCP port 6668, so
   `nmap -p 6668 --open 192.168.1.0/24` works as a quick alternative.) A
   static DHCP reservation is strongly recommended so the IP doesn't
   change.

4. **Confirm the protocol version** (`TUYA_VERSION`): the `tinytuya` scan
   above reports it per device (commonly `3.3` or `3.4` for modern
   firmware). If unsure, `3.3` is the most common default — the client will
   report a clear comms error in the logs if the version is wrong, which is
   safe to iterate on.

### Troubleshooting: "There was an issue fetching that device"

The wizard prints this generic message for *any* cloud API failure — it
does not tell you which one. Re-run it with debug output to see the real
error(s):

```bash
DEBUG=1 npx @tuyapi/cli wizard
```

The wizard tries the `eu`, `us`, `cn`, and `in` data centers in parallel
and, with `DEBUG` set, prints one underlying error per region. Match what
you see:

| Underlying error | Cause / fix |
|---|---|
| `sign invalid` | Wrong Access ID / Secret — re-copy them from the project's **Overview** tab, watching for stray whitespace. |
| `permission deny` | The device isn't visible to this project: the app account isn't linked, it's linked in a **different data center**, or the virtual ID is wrong. |
| `28841107: ... The data center is suspended` | The project's **IoT Core trial has lapsed**. When it expires, *every* data center returns this — regardless of which one the project is actually homed in — so don't chase data-center settings first. [Extend the trial](#extending-the-iot-core-trial) (free), then retry. |
| `No permissions. This API is not subscribed` / trial expired | Missing or expired **Service API** subscription. In the Cloud project, open **Service API** and subscribe to (or extend the free trial of) `IoT Core` and `Authorization Token Management`. |
| `cross-region access is not allowed` | The project's data center doesn't match your app account's region — edit the project and enable the correct data center. |

Checklist if it still fails:

- **Data center is the usual culprit.** The device list is *per data
  center*: in **Devices → Device List**, switch the data-center tabs until
  you find the one where your linked devices actually appear. That data
  center must match the region your Tuya Smart / Smart Life account is
  registered in. You can enable additional data centers by editing the
  Cloud project.
- **The wizard only knows the four classic data centers** (`eu`, `us`,
  `cn`, `in`). Projects homed in **Eastern America** or **Western Europe**
  are unreachable by it — enable a classic data center, or use
  [tinytuya's wizard](https://github.com/jasonacox/tinytuya)
  (`python -m tinytuya wizard`) instead, which supports all data centers
  and produces the same `id`/`key` values.
- **The virtual ID must belong to the linked account.** The simplest
  reliable source is the Cloud panel itself: **Devices → Device List →
  Device ID**. If the device isn't listed there, the wizard can't fetch it
  either — fix the account link / data center first.

#### Extending the IoT Core trial

The IoT Core service is subscription-based; the free trial is short-lived
and must be periodically extended (still free). When it lapses, every
cloud call fails with `28841107: the data center is suspended` and the
wizard prints its generic fetch error.

To extend it: **Cloud → Cloud Services → IoT Core → My Subscriptions →
Extend Trial Period**. Pick the longest extension period offered so you
don't have to repeat this soon. The short review form is straightforward,
and honest hobbyist answers are routinely approved:

- **Developer Identity**: Individual Developer (personal,
  non-commercial).
- **Estimated Number of Connected Devices**: your real, small number
  (e.g. "fewer than 20").
- **Project Overview**: a couple of honest sentences, e.g. *"Self-hosted
  daemon that switches a Tuya smart plug based on NAS CPU/HDD
  temperatures; the cloud API is only used once to retrieve device local
  keys — runtime control is LAN-only."*
- **Contact Person / Information**: your name and the email your Tuya
  IoT Platform account is registered with.

Approval ranges from instant to a few hours; the status is shown under
**My Subscriptions**. Once it's active, re-run the wizard.

## Environment variables

All variables are validated at startup with a strict schema; the process
**fails fast** (fails to start) if a required variable is missing or
malformed, rather than running with undefined behavior.

| Variable | Default | Description |
|---|---|---|
| `CPU_TEMP_HIGH` | `60` | CPU temp (°C) at/above which the fan turns ON. |
| `CPU_TEMP_LOW` | `48` | CPU must be below this (°C) for the OFF dwell timer to run. |
| `CPU_TEMP_CRITICAL` | `80` | CPU temp (°C) that force-enables the fan even under manual-OFF. |
| `HDD_TEMP_HIGH` | `48` | Disk temp (°C) at/above which the fan turns ON. |
| `HDD_TEMP_LOW` | `42` | Disks must be below this (°C) for the OFF dwell timer to run. |
| `HDD_TEMP_CRITICAL` | `55` | Disk temp (°C) that force-enables the fan even under manual-OFF. |
| `POLL_INTERVAL_SEC` | `30` | How often (seconds) the control loop polls sensors and evaluates state. |
| `OFF_DWELL_SEC` | `300` | Seconds all sources must stay continuously below LOW before the fan turns OFF. |
| `MIN_ON_SEC` | `120` | Minimum seconds the fan stays ON once triggered (anti-short-cycling). |
| `HDD_DEVICES` | `sda,sdb,sdc,sdd,sde` | Comma-separated disk device names (no `/dev/` prefix) to poll via `smartctl`. |
| `TUYA_DEVICE_ID` | *(required)* | Tuya device ID, from the extraction guide above. |
| `TUYA_LOCAL_KEY` | *(required)* | Tuya local key, from the extraction guide above. |
| `TUYA_IP` | *(required)* | Local LAN IP address of the smart plug. |
| `TUYA_VERSION` | `3.3` | Tuya local protocol version reported by `tuya-cli`. |
| `DRY_RUN` | `false` | When `true`, no real Tuya commands are sent — decisions are only logged. |
| `FAIL_SAFE` | `true` | Legacy compatibility setting. Parsed but does not disable protection: sensor/comms failures always force the fan ON. |
| `HTTP_ENABLED` | `true` | Enable the Fastify HTTP API (`/health`, `/status`, `/fan/*`). |
| `PORT` | `3000` | HTTP listen port. |
| `HTTP_HOST` | `0.0.0.0` | HTTP bind address. The API is **unauthenticated** — set to `127.0.0.1` to restrict it to localhost (see [Security note](#security-note)). |
| `LOG_LEVEL` | `info` | pino log level: `fatal` / `error` / `warn` / `info` / `debug` / `trace` / `silent`. |

A ready-to-copy template is provided in [`.env.example`](./.env.example).

## Running with Docker

### `docker run`

```bash
docker build -t cooler-tuya-api .

docker run -d \
  --name cooler-tuya-api \
  --restart unless-stopped \
  --network host \
  --cap-add SYS_RAWIO \
  --device /dev/sda \
  --device /dev/sdb \
  --device /dev/sdc \
  --device /dev/sdd \
  --device /dev/sde \
  -v /sys:/sys:ro \
  --env-file .env \
  cooler-tuya-api
```

### `docker-compose.yml`

A ready-to-use compose file is included in this repo — copy `.env.example`
to `.env`, fill in your Tuya credentials, adjust `HDD_DEVICES` /
`devices:` to match your actual disks, then:

```bash
cp .env.example .env
# edit .env with your TUYA_DEVICE_ID / TUYA_LOCAL_KEY / TUYA_IP
docker compose up -d
```

```yaml
services:
  cooler-tuya-api:
    build: .
    image: cooler-tuya-api:latest
    container_name: cooler-tuya-api
    restart: unless-stopped
    network_mode: host
    cap_add:
      - SYS_RAWIO
    devices:
      - "/dev/sda"
      - "/dev/sdb"
      - "/dev/sdc"
      - "/dev/sdd"
      - "/dev/sde"
    volumes:
      - "/sys:/sys:ro"
    env_file:
      - .env
```

### Why these privileges?

- **`network_mode: host`**: Tuya local-LAN discovery/control uses UDP
  broadcast on the plug's network segment; host networking is the simplest
  reliable way to guarantee that on typical home/NAS deployments.
- **`cap_add: SYS_RAWIO` + explicit `--device`/`devices:` list**: `smartctl`
  needs raw ATA/SCSI I/O access to read SMART attribute 194 (temperature).
  Listing exact devices (rather than using `--privileged`) is the
  **recommended, least-privilege** approach — it grants access only to the
  disks you actually want monitored.
- **`/sys:/sys:ro`**: needed to read the CPU thermal zone
  (`/sys/class/thermal/thermal_zone*/temp`); mounted read-only since the
  service never needs to write to `/sys`.

**Fallback (not recommended):** if your device layout is highly dynamic and
maintaining an explicit `--device` list is impractical, you can run the
container with `--privileged` instead of `--cap-add SYS_RAWIO` + `--device`.
This grants full access to the host's devices and capabilities and is
**less secure** — treat it strictly as a documented fallback, not the
default recommendation.

## HTTP API (when `HTTP_ENABLED=true`)

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Liveness check, returns `200 OK`. |
| `/status` | GET | Current temps, desired and confirmed relay state, communication health, mode (`auto`/`manual`), and last decision. |
| `/fan/on` | POST | Force the fan ON (sticky manual override). |
| `/fan/off` | POST | Force the fan OFF (sticky manual override; critical temps still override this). |
| `/fan/auto` | POST | Clear the manual override and return to automatic hysteresis control. |

`/status.fanOn` retains its original meaning: the **desired** fan state.
`confirmedFanOn` is the latest relay state read or acknowledged command (`null`
when unknown), and `plugCommsOk` reports communication health. These are not a
physical fan-speed sensor: an energized relay cannot prove that the fan spins.
In `DRY_RUN` mode, confirmed state is simulated, not a hardware observation.
`/health` is liveness only; it does not guarantee successful cooling.

### Security note

The HTTP API is **unauthenticated**. The `/fan/*` endpoints mutate hardware
state (they switch the plug, and therefore the fan, on and off), and with the
default `HTTP_HOST=0.0.0.0` combined with `network_mode: host` the API is
reachable by **any host on your LAN**. Run this only on a trusted, isolated
network. To restrict the API to the local machine, set `HTTP_HOST=127.0.0.1`.
If you need access from an untrusted network, place it behind a reverse proxy
that adds authentication.

## Cycle telemetry

Every completed control cycle writes one `info` log line with
`event: "cooler.cycle"` and `schema: 1`, including cycles that hold the
current state and fail-safe cycles. Existing log lines are unchanged.

| Field | Meaning |
|---|---|
| `sampledAt` | Epoch ms when the sensor batch completed; `null` when the batch failed unexpectedly. |
| `readbackAt` | Epoch ms when the pre-command relay read completed (successful or not). |
| `completedAt` | Epoch ms when the cycle finished, including any command. |
| `maxCpu`, `maxHdd` | Temperatures used by the decision; `null` when unavailable. An unexpected sensor failure reports `null`, never the previous cycle's values. |
| `sensorOk` | `false` when any sensor failed this cycle. |
| `thresholds` | `{ cpuHigh, hddHigh, cpuCritical, hddCritical }` in effect. |
| `override` | Manual override used by the decision: `null`, `"on"` or `"off"`. A change made while a command is pending applies to the next cycle. |
| `desiredFanOn` | Fan state the controller requested. |
| `relayObservedFanOn` | Relay state read **before** any command this cycle: `true`, `false` or `null` (unknown or read failed). It is never a command acknowledgement. |
| `commandOutcome` | `not_needed` (no command sent), `acknowledged` (the plug accepted the command) or `failed`. |
| `plugCommsOk` | Communication health after the command phase. |
| `dryRun` | `true` when `DRY_RUN` is enabled. |

Limits:

- A relay state cannot prove that the fan physically spins.
- `acknowledged` means the plug accepted the command; the relay state is only
  observed again at the next cycle's readback.
- With `DRY_RUN=true`, readbacks and acknowledgements are simulated.
- Timestamps come from the host clock. Skipped overlapping ticks and cycles that
  end in an unhandled error produce no event, and `LOG_LEVEL` above `info`
  suppresses it.
- The event contains no error messages; read the existing `warn`/`error`
  lines for failure details. If writing the event fails, the event is dropped
  and control continues unchanged.

## Safety notes

- Manual overrides are **never** allowed to disable thermal protection:
  reaching `CPU_TEMP_CRITICAL` or `HDD_TEMP_CRITICAL` re-enables the fan
  even if you've called `/fan/off`.
- The first control cycle runs immediately at startup. Subsequent cycles
  follow `POLL_INTERVAL_SEC`; an in-flight cycle is never overlapped.
- Each cycle reads the relay state, detecting external OFF changes (for
  example after a plug power loss). Failed commands invalidate the cached
  state: recovery explicitly reasserts **ON** before normal control resumes.
- Sensor read failures and Tuya communication failures are treated as a
  fail-safe condition — the system errs toward keeping the fan **ON** and
  retries the plug command on subsequent cycles. Protection is mandatory;
  the legacy `FAIL_SAFE=false` value does not disable it.
- Tuya attempts have a 10-second deadline, including connection/handshake
  and response, with up to three attempts and 0.5/2-second retry delays.
  Read and write phases can each take up to about 32.5 seconds during an
  outage, in addition to sensor time. Overlapping polling ticks are skipped.
  No software fail-safe can energize an unreachable or unpowered plug.
- On shutdown (`SIGTERM`), the control loop stops polling but **does not**
  turn the fan off — this avoids losing cooling if the container is
  restarting or being redeployed.

## License

MIT
