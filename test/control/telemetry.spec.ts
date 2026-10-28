import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ControlLoop } from '../../src/control/loop.js';
import type { Override, ThresholdConfig } from '../../src/control/types.js';
import type { SensorResult, TemperatureSensor } from '../../src/sensors/types.js';
import { DryRunPlug } from '../../src/tuya/dry-run-plug.js';
import { FakeClock } from '../fakes/fake-clock.js';
import { FakePlug } from '../fakes/fake-plug.js';

const thresholds: ThresholdConfig = {
  cpuHigh: 60,
  cpuLow: 48,
  cpuCritical: 80,
  hddHigh: 48,
  hddLow: 42,
  hddCritical: 55,
  offDwellSec: 300,
  minOnSec: 120,
};

const eventThresholds = { cpuHigh: 60, hddHigh: 48, cpuCritical: 80, hddCritical: 55 };

type Line = Record<string, unknown>;

/** Real pino logger writing JSON lines into memory; optionally fails only on cycle events. */
function capturingLogger(options: { level?: string; failCycleEvents?: boolean } = {}) {
  const lines: Line[] = [];
  const raw: string[] = [];
  const logger = pino(
    { level: options.level ?? 'info', base: undefined, timestamp: false },
    {
      write(line: string) {
        if (options.failCycleEvents && line.includes('"cooler.cycle"')) throw new Error('log sink unavailable');
        raw.push(line);
        lines.push(JSON.parse(line) as Line);
      },
    },
  );
  const events = () => lines.filter((line) => line.event === 'cooler.cycle');
  const legacy = () => lines.filter((line) => line.event !== 'cooler.cycle');
  return { logger, lines, raw, events, legacy };
}

/** Clock advanced by every sensor batch (10 ms), relay read (5 ms) and relay command (7 ms). */
function timedRig(cpu: () => number) {
  const clock = new FakeClock(1_000_000);
  const sensors: TemperatureSensor[] = [
    {
      read: async (): Promise<SensorResult> => {
        clock.advance(10);
        return { ok: true, readings: [{ id: 'cpu', kind: 'cpu', label: 'CPU', celsius: cpu() }] };
      },
    },
  ];
  const plug = new FakePlug();
  const getState = plug.getState.bind(plug);
  const turnOn = plug.turnOn.bind(plug);
  const turnOff = plug.turnOff.bind(plug);
  plug.getState = async () => {
    clock.advance(5);
    return getState();
  };
  plug.turnOn = async () => {
    clock.advance(7);
    return turnOn();
  };
  plug.turnOff = async () => {
    clock.advance(7);
    return turnOff();
  };
  return { clock, sensors, plug };
}

function cycleEvent(fields: Partial<Line>): Line {
  return {
    level: 30,
    msg: 'control loop: cycle',
    event: 'cooler.cycle',
    schema: 1,
    sampledAt: 1_000_010,
    readbackAt: 1_000_015,
    completedAt: 1_000_015,
    maxCpu: 35,
    maxHdd: null,
    sensorOk: true,
    thresholds: eventThresholds,
    override: null,
    desiredFanOn: false,
    relayObservedFanOn: false,
    commandOutcome: 'not_needed',
    plugCommsOk: true,
    dryRun: false,
    ...fields,
  };
}

describe('ControlLoop — cooler.cycle telemetry', () => {
  it('reports the OFF readback before a successful ON acknowledgement, then an INFO event for the ON hold', async () => {
    const { clock, sensors, plug } = timedRig(() => 65);
    const log = capturingLogger();
    const loop = new ControlLoop({ sensors, plug, clock, thresholds, logger: log.logger });

    await loop.runOnce();
    await loop.runOnce();

    expect(log.events()).toEqual([
      cycleEvent({
        maxCpu: 65,
        desiredFanOn: true,
        relayObservedFanOn: false,
        commandOutcome: 'acknowledged',
        completedAt: 1_000_022,
      }),
      cycleEvent({
        sampledAt: 1_000_032,
        readbackAt: 1_000_037,
        completedAt: 1_000_037,
        maxCpu: 65,
        desiredFanOn: true,
        relayObservedFanOn: true,
      }),
    ]);
    expect([plug.getStateCalls, plug.turnOnCalls, plug.turnOffCalls]).toEqual([2, 1, 0]);
  });

  it('reports a failed command without raw error text and keeps the next readback distinct from acknowledgement', async () => {
    const { clock, sensors, plug } = timedRig(() => 65);
    vi.spyOn(plug, 'turnOn').mockImplementationOnce(async () => {
      plug.turnOnCalls += 1;
      throw new Error('ECONNRESET secret-local-key-123');
    });
    const log = capturingLogger();
    const loop = new ControlLoop({ sensors, plug, clock, thresholds, logger: log.logger });

    await loop.runOnce();
    await loop.runOnce();

    expect(log.events()).toEqual([
      cycleEvent({
        maxCpu: 65,
        desiredFanOn: true,
        relayObservedFanOn: false,
        commandOutcome: 'failed',
        plugCommsOk: false,
      }),
      cycleEvent({
        sampledAt: 1_000_025,
        readbackAt: 1_000_030,
        completedAt: 1_000_037,
        maxCpu: 65,
        desiredFanOn: true,
        relayObservedFanOn: false,
        commandOutcome: 'acknowledged',
      }),
    ]);
    expect(log.raw.filter((line) => line.includes('cooler.cycle')).join('')).not.toMatch(/ECONNRESET|secret/);
    expect([plug.getStateCalls, plug.turnOnCalls, plug.turnOffCalls]).toEqual([2, 2, 0]);
  });

  it.each(['unknown', 'reject'])('reports a null relay observation on %s readback and the fail-safe ON outcome', async (failure) => {
    const { clock, sensors, plug } = timedRig(() => 35);
    vi.spyOn(plug, 'getState').mockImplementationOnce(async () => {
      plug.getStateCalls += 1;
      clock.advance(5);
      if (failure === 'reject') throw new Error('read failed token=abc');
      return 'unknown';
    });
    const log = capturingLogger();
    const loop = new ControlLoop({ sensors, plug, clock, thresholds, logger: log.logger });

    const decision = await loop.runOnce();

    expect(decision.reason).toMatch(/communication failure/);
    expect(log.events()).toEqual([
      cycleEvent({
        completedAt: 1_000_022,
        desiredFanOn: true,
        relayObservedFanOn: null,
        commandOutcome: 'acknowledged',
      }),
    ]);
    expect(log.raw.filter((line) => line.includes('cooler.cycle')).join('')).not.toMatch(/token|read failed/);
    expect([plug.getStateCalls, plug.turnOnCalls, plug.turnOffCalls]).toEqual([1, 1, 0]);
  });

  it('records decision-time manual overrides, including critical heat overriding manual OFF', async () => {
    let cpu = 35;
    const { clock, sensors, plug } = timedRig(() => cpu);
    plug.state = 'on';
    const log = capturingLogger();
    const loop = new ControlLoop({ sensors, plug, clock, thresholds, logger: log.logger });

    loop.setOverride('off');
    await loop.runOnce();
    cpu = 85;
    await loop.runOnce();

    expect(log.events()).toEqual([
      cycleEvent({
        override: 'off',
        relayObservedFanOn: true,
        commandOutcome: 'acknowledged',
        completedAt: 1_000_022,
      }),
      cycleEvent({
        sampledAt: 1_000_032,
        readbackAt: 1_000_037,
        completedAt: 1_000_044,
        maxCpu: 85,
        override: 'off',
        desiredFanOn: true,
        relayObservedFanOn: false,
        commandOutcome: 'acknowledged',
      }),
    ]);
    expect([plug.getStateCalls, plug.turnOnCalls, plug.turnOffCalls]).toEqual([2, 1, 1]);
  });

  it('keeps the decision-time override when it changes while the command is pending', async () => {
    const { clock, sensors, plug } = timedRig(() => 35);
    let release!: () => void;
    vi.spyOn(plug, 'turnOn').mockImplementationOnce(async () => {
      plug.turnOnCalls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      plug.state = 'on';
    });
    const log = capturingLogger();
    const loop = new ControlLoop({ sensors, plug, clock, thresholds, logger: log.logger });

    loop.setOverride('on');
    const pending = loop.runOnce();
    await vi.waitFor(() => expect(plug.turnOnCalls).toBe(1));
    const later: Override = 'off';
    loop.setOverride(later);
    release();
    await pending;

    expect(log.events()).toEqual([
      cycleEvent({ override: 'on', desiredFanOn: true, commandOutcome: 'acknowledged' }),
    ]);
    expect(loop.state.override).toBe('off');
  });

  it('marks dry-run cycles and their simulated acknowledgement', async () => {
    const clock = new FakeClock(5);
    const log = capturingLogger();
    const sensors = [{ read: async (): Promise<SensorResult> => ({ ok: true, readings: [{ id: 'hdd', kind: 'hdd', label: 'sda', celsius: 50 }] }) }];
    const loop = new ControlLoop({ sensors, plug: new DryRunPlug(log.logger), clock, thresholds, dryRun: true, logger: log.logger });

    await loop.runOnce();

    expect(log.events()).toEqual([
      cycleEvent({
        sampledAt: 5,
        readbackAt: 5,
        completedAt: 5,
        maxCpu: null,
        maxHdd: 50,
        desiredFanOn: true,
        commandOutcome: 'acknowledged',
        dryRun: true,
      }),
    ]);
  });

  it('emits null temperatures and sample time after a sensor rejection instead of stale values', async () => {
    let reject = false;
    const { clock, plug } = timedRig(() => 65);
    const sensors: TemperatureSensor[] = [
      {
        read: async (): Promise<SensorResult> => {
          clock.advance(10);
          if (reject) throw new Error('/dev/sda permission denied');
          return { ok: true, readings: [{ id: 'cpu', kind: 'cpu', label: 'CPU', celsius: 65 }] };
        },
      },
    ];
    const log = capturingLogger();
    const loop = new ControlLoop({ sensors, plug, clock, thresholds, logger: log.logger });

    await loop.runOnce();
    reject = true;
    await loop.runOnce();

    expect(log.events()[1]).toEqual(
      cycleEvent({
        sampledAt: null,
        readbackAt: 1_000_037,
        completedAt: 1_000_037,
        maxCpu: null,
        sensorOk: false,
        desiredFanOn: true,
        relayObservedFanOn: true,
      }),
    );
    expect(log.raw.filter((line) => line.includes('cooler.cycle')).join('')).not.toMatch(/sda|permission/);
    expect(loop.state.lastMaxCpu).toBe(65);
    expect([plug.getStateCalls, plug.turnOnCalls, plug.turnOffCalls]).toEqual([2, 1, 0]);
  });

  it('never lets a failing telemetry write change control, Tuya calls or legacy log lines', async () => {
    const scenario = [65, 65, 35, 35, 35, 35];
    const run = async (failCycleEvents: boolean) => {
      let step = 0;
      const { clock, sensors, plug } = timedRig(() => scenario[step] ?? 35);
      const log = capturingLogger({ level: 'debug', failCycleEvents });
      const loop = new ControlLoop({ sensors, plug, clock, thresholds, logger: log.logger });
      const decisions = [];
      for (step = 0; step < scenario.length; step++) {
        decisions.push(await loop.runOnce());
        clock.advance(200_000);
      }
      const counts = [plug.getStateCalls, plug.turnOnCalls, plug.turnOffCalls];
      return { decisions, counts, state: { ...loop.state }, legacy: log.legacy(), events: log.events() };
    };

    const healthy = await run(false);
    const failing = await run(true);

    expect(healthy.events).toHaveLength(scenario.length);
    expect(failing.events).toHaveLength(0);
    expect(failing.decisions).toEqual(healthy.decisions);
    expect(failing.counts).toEqual(healthy.counts);
    expect(failing.state).toEqual(healthy.state);
    expect(failing.legacy).toEqual(healthy.legacy);
  });

  it('preserves legacy decision, hold and command-failure log lines', async () => {
    const { clock, sensors, plug } = timedRig(() => 65);
    vi.spyOn(plug, 'turnOn').mockImplementationOnce(async () => {
      plug.turnOnCalls += 1;
      throw new Error('ack lost');
    });
    const log = capturingLogger({ level: 'debug' });
    const loop = new ControlLoop({ sensors, plug, clock, thresholds, logger: log.logger });

    await loop.runOnce();
    await loop.runOnce();
    await loop.runOnce();

    const decision = { maxCpu: 65, maxHdd: null, action: 'turnOn', state: 'ON_MIN_HOLD', reason: 'CPU or HDD >= HIGH', dryRun: false };
    const recovery = { ...decision, action: 'hold', state: 'ON', reason: 'plug communication failure — fail-safe ON' };
    const hold = { ...decision, action: 'hold', state: 'ON' };
    expect(log.legacy()).toEqual([
      { level: 30, msg: 'control loop: decision', ...decision },
      { level: 50, msg: 'control loop: plug command failed — will retry next cycle', err: 'ack lost', action: 'turnOn' },
      { level: 30, msg: 'control loop: decision', ...recovery },
      { level: 20, msg: 'control loop: hold', ...hold },
    ]);
    expect([plug.getStateCalls, plug.turnOnCalls, plug.turnOffCalls]).toEqual([3, 2, 0]);
  });
});
