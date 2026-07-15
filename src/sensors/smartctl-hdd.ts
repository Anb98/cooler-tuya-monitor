import { spawn } from 'node:child_process';
import type { Reading, SensorResult, TemperatureSensor } from './types.js';

export interface SmartctlHddSensorOptions {
  devices: string[];
  /** Per-device spawn timeout in milliseconds. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Bare device name allowlist: exactly "sd" followed by one or more lowercase
 * letters (e.g. sda, sdb, sdaa). Rejects anything else — including shell
 * metacharacters, path traversal, or command-injection payloads — BEFORE any
 * subprocess is spawned. This is a hard security boundary (see design threat
 * matrix): a malicious HDD_DEVICES entry must never reach spawn().
 */
const DEVICE_NAME_ALLOWLIST = /^sd[a-z]+$/;

interface SmartAttr194Result {
  celsius: number;
}

/**
 * A reading outside this range is not a real drive temperature. Attribute
 * 194's raw.value is often a packed 48-bit field (current | min<<16 |
 * max<<32), which decodes to astronomically large "temperatures" — those
 * must be rejected so the daemon fails safe instead of latching critical.
 */
function isPlausibleCelsius(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 150;
}

function parseSmartctlJson(json: unknown): SmartAttr194Result | { error: string } {
  if (typeof json !== 'object' || json === null) {
    return { error: 'smartctl output was not a JSON object' };
  }
  const obj = json as Record<string, unknown>;

  // smartctl's normalized temperature.current field is authoritative;
  // attribute 194's raw fields are vendor-encoded and only used as fallback.
  const temperature = obj.temperature as { current?: number } | undefined;
  if (isPlausibleCelsius(temperature?.current)) {
    return { celsius: temperature.current };
  }

  const attrs = obj.ata_smart_attributes as
    | { table?: Array<{ id?: number; raw?: { value?: number; string?: string } }> }
    | undefined;
  const attr194 = attrs?.table?.find((entry) => entry.id === 194);

  // raw.string leads with the current temperature, e.g. "40 (Min/Max 21/71)".
  const leading = attr194?.raw?.string?.match(/^(\d+)/);
  if (leading) {
    const celsius = Number(leading[1]);
    if (isPlausibleCelsius(celsius)) {
      return { celsius };
    }
  }

  // Some drives report plain celsius in raw.value; packed values fail the
  // plausibility check and fall through to the error (fail-safe) path.
  if (isPlausibleCelsius(attr194?.raw?.value)) {
    return { celsius: attr194.raw.value };
  }

  return { error: 'no plausible temperature in temperature.current or attribute 194 (raw.string/raw.value) in smartctl output' };
}

/**
 * Reads HDD temperature via `smartctl -A -j /dev/sdX` for each configured
 * device. Devices are validated against a strict allowlist BEFORE spawning;
 * the subprocess is invoked with a fixed argv array and shell:false — no
 * string interpolation, no shell involved.
 */
export class SmartctlHddSensor implements TemperatureSensor {
  private readonly devices: string[];
  private readonly timeoutMs: number;

  constructor(options: SmartctlHddSensorOptions) {
    this.devices = options.devices;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async read(): Promise<SensorResult> {
    const readings: Reading[] = [];
    const errors: string[] = [];

    for (const device of this.devices) {
      const result = await this.readOne(device);
      if (result.ok) {
        readings.push(...result.readings);
      } else {
        errors.push(result.error);
      }
    }

    if (errors.length > 0) {
      return { ok: false, error: errors.join('; ') };
    }
    return { ok: true, readings };
  }

  private async readOne(device: string): Promise<SensorResult> {
    if (!DEVICE_NAME_ALLOWLIST.test(device)) {
      return {
        ok: false,
        error: `Invalid HDD_DEVICES entry "${device}": rejected by allowlist (expected /dev/sd[a-z]+)`,
      };
    }

    const devicePath = `/dev/${device}`;

    return new Promise<SensorResult>((resolve) => {
      const child = spawn('smartctl', ['-A', '-j', devicePath], { shell: false });

      let settled = false;
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve({ ok: false, error: `smartctl timed out reading ${devicePath}` });
      }, this.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: false,
          error: `Failed to spawn smartctl for ${devicePath}: ${err.code ?? err.message}`,
        });
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (code !== 0 && stdout.trim().length === 0) {
          resolve({
            ok: false,
            error: `smartctl exited with code ${code} for ${devicePath}: ${stderr.trim() || 'no output'}`,
          });
          return;
        }

        try {
          const json = JSON.parse(stdout);
          const parsed = parseSmartctlJson(json);
          if ('error' in parsed) {
            resolve({ ok: false, error: `${parsed.error} for ${devicePath}` });
            return;
          }
          resolve({
            ok: true,
            readings: [{ id: device, kind: 'hdd', label: devicePath, celsius: parsed.celsius }],
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          resolve({ ok: false, error: `Failed to parse smartctl JSON for ${devicePath}: ${message}` });
        }
      });
    });
  }
}
