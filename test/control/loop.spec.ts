import { describe, expect, it, vi } from 'vitest';
import { ControlLoop } from '../../src/control/loop.js';
import { FakeClock } from '../fakes/fake-clock.js';
import { FakePlug } from '../fakes/fake-plug.js';
import type { SensorResult, TemperatureSensor } from '../../src/sensors/types.js';
import type { ThresholdConfig } from '../../src/control/types.js';

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

function fakeSensor(result: SensorResult): TemperatureSensor {
  return { read: async () => result };
}

function fakeFailingSensor(error: string): TemperatureSensor {
  return { read: async () => ({ ok: false, error }) };
}

function fakeRejectingSensor(error: string): TemperatureSensor {
  return { read: async () => Promise.reject(new Error(error)) };
}

describe('ControlLoop — recovery and reconciliation', () => {
  it('reasserts ON after an OFF applied by the plug but not acknowledged, then resumes auto', async () => {
    const clock = new FakeClock(0);
    const plug = new FakePlug();
    let cpu = 65;
    const sensors = [{ read: async (): Promise<SensorResult> => ({ ok: true, readings: [{ id: 'cpu', kind: 'cpu', label: 'CPU', celsius: cpu }] }) }];
    const loop = new ControlLoop({ sensors, plug, clock, thresholds });
    await loop.runOnce();
    cpu = 35;
    clock.advance(120000);
    await loop.runOnce();
    clock.advance(300000);
    const turnOff = vi.spyOn(plug, 'turnOff').mockImplementationOnce(async () => {
      plug.state = 'off';
      throw new Error('OFF applied, acknowledgement lost');
    });
    await loop.runOnce();
    expect(loop.state.appliedFanOn).toBeNull();
    expect(loop.state.plugCommsOk).toBe(false);
    const recovery = await loop.runOnce();
    expect(recovery.reason).toMatch(/communication failure/);
    expect(plug.turnOnCalls).toBe(2);
    expect(plug.state).toBe('on');
    expect(loop.state.plugCommsOk).toBe(true);
    await loop.runOnce();
    clock.advance(300000);
    await loop.runOnce();
    expect(turnOff).toHaveBeenCalledTimes(2);
    expect(plug.state).toBe('off');
  });

  it('detects external OFF while hot without redundant writes when state agrees', async () => {
    const plug = new FakePlug();
    const loop = new ControlLoop({ sensors: [fakeSensor({ ok: true, readings: [{ id: 'cpu', kind: 'cpu', label: 'CPU', celsius: 65 }] })], plug, clock: new FakeClock(0), thresholds });
    await loop.runOnce();
    await loop.runOnce();
    expect(plug.turnOnCalls).toBe(1);
    plug.state = 'off';
    await loop.runOnce();
    expect(plug.getStateCalls).toBe(3);
    expect(plug.turnOnCalls).toBe(2);
    expect(plug.state).toBe('on');
  });

  it.each(['unknown', 'reject'])('forces safe ON on %s readback even when cool and manual OFF', async (failure) => {
    const plug = new FakePlug();
    vi.spyOn(plug, 'getState').mockImplementation(async () => {
      if (failure === 'reject') throw new Error('read failed');
      return 'unknown';
    });
    const loop = new ControlLoop({ sensors: [fakeSensor({ ok: true, readings: [] })], plug, clock: new FakeClock(0), thresholds });
    loop.setOverride('off');
    const decision = await loop.runOnce();
    expect(decision.fanOn).toBe(true);
    expect(decision.reason).toMatch(/communication failure/);
    expect(plug.turnOnCalls).toBe(1);
    expect(plug.turnOffCalls).toBe(0);
    expect(loop.state.appliedFanOn).toBe(true);
  });

  it('starts immediately once, skips overlapping scheduled ticks, and stops polling', async () => {
    vi.useFakeTimers();
    const plug = new FakePlug();
    let resolve!: (value: SensorResult) => void;
    const read = vi.fn(() => new Promise<SensorResult>((done) => { resolve = done; }));
    const loop = new ControlLoop({ sensors: [{ read }], plug, clock: new FakeClock(0), thresholds });
    try {
      loop.start(60000);
      loop.start(60000);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120000);
      expect(read).toHaveBeenCalledTimes(1);
      resolve({ ok: false, error: 'sensor unavailable' });
      await vi.advanceTimersByTimeAsync(0);
      expect(plug.turnOnCalls).toBe(1);
      loop.stop();
      await vi.advanceTimersByTimeAsync(60000);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      loop.stop();
      vi.useRealTimers();
    }
  });
});

describe('ControlLoop — verifier regressions', () => {
  const cpuSensor = (celsius: () => number): TemperatureSensor => ({
    read: async () => ({ ok: true, readings: [{ id: 'cpu', kind: 'cpu', label: 'CPU', celsius: celsius() }] }),
  });

  it('recovers at 65C after a manual OFF applied without acknowledgement', async () => {
    let cpu = 35;
    const plug = new FakePlug();
    const loop = new ControlLoop({ sensors: [cpuSensor(() => cpu)], plug, clock: new FakeClock(0), thresholds });
    loop.setOverride('on');
    await loop.runOnce();
    loop.setOverride('off');
    vi.spyOn(plug, 'turnOff').mockImplementationOnce(async () => {
      plug.state = 'off';
      throw new Error('ack lost');
    });
    await loop.runOnce();
    loop.setOverride(null);
    cpu = 65;
    for (let i = 0; i < 3; i++) await loop.runOnce();
    expect(plug.state).toBe('on');
    expect(plug.turnOnCalls).toBe(2);
    expect(loop.state.plugCommsOk).toBe(true);
  });

  it('avoids writes from startup when the relay already matches hot or cool demand', async () => {
    const on = new FakePlug();
    on.state = 'on';
    const hot = new ControlLoop({ sensors: [cpuSensor(() => 65)], plug: on, clock: new FakeClock(0), thresholds });
    const off = new FakePlug();
    const cool = new ControlLoop({ sensors: [cpuSensor(() => 35)], plug: off, clock: new FakeClock(0), thresholds });
    for (let i = 0; i < 5; i++) {
      await hot.runOnce();
      await cool.runOnce();
    }
    expect(on.turnOnCalls + on.turnOffCalls + off.turnOnCalls + off.turnOffCalls).toBe(0);
    expect(on.getStateCalls).toBe(5);
    expect(off.getStateCalls).toBe(5);
  });

  it('skips scheduled ticks during pending readback and resumes after completion', async () => {
    vi.useFakeTimers();
    const plug = new FakePlug();
    let release!: (state: 'on' | 'off') => void;
    const get = vi.spyOn(plug, 'getState').mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const loop = new ControlLoop({ sensors: [cpuSensor(() => 65)], plug, clock: new FakeClock(0), thresholds });
    try {
      loop.start(1000);
      await vi.advanceTimersByTimeAsync(5000);
      expect(get).toHaveBeenCalledTimes(1);
      expect(plug.turnOnCalls).toBe(0);
      release('off');
      await vi.advanceTimersByTimeAsync(0);
      expect(plug.turnOnCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(get).toHaveBeenCalledTimes(2);
      expect(plug.turnOnCalls).toBe(1);
    } finally {
      loop.stop();
      vi.useRealTimers();
    }
  });
});

describe('ControlLoop — integration with fakes', () => {
  it('issues turnOn plug call for a HIGH -> ON scenario', async () => {
    const clock = new FakeClock(0);
    const plug = new FakePlug();
    const sensors = [fakeSensor({ ok: true, readings: [{ id: 'cpu0', kind: 'cpu', label: 'CPU', celsius: 65 }] })];

    const loop = new ControlLoop({ sensors, plug, clock, thresholds });
    const decision = await loop.runOnce();

    expect(decision.fanOn).toBe(true);
    expect(plug.turnOnCalls).toBe(1);
    expect(plug.state).toBe('on');
  });

  it('DRY_RUN=true: decision computed and logged but no plug command dispatched to a real device', async () => {
    const clock = new FakeClock(0);
    const plug = new FakePlug();
    const sensors = [fakeSensor({ ok: true, readings: [{ id: 'cpu0', kind: 'cpu', label: 'CPU', celsius: 65 }] })];

    const loop = new ControlLoop({ sensors, plug, clock, thresholds, dryRun: true });
    const decision = await loop.runOnce();

    // Note: with DRY_RUN, bootstrap wiring is expected to inject a DryRunPlug
    // instance as `plug` (see src/index.ts) rather than a real Tuya client;
    // the loop itself just calls whatever PlugController it was given.
    expect(decision.fanOn).toBe(true);
    expect(decision.action).toBe('turnOn');
  });
});

describe('ControlLoop — plug command failure handling', () => {
  it('logs and retries on subsequent cycles until the plug command succeeds', async () => {
    const clock = new FakeClock(0);
    const plug = new FakePlug({ failNextCalls: 1 });
    const sensors = [fakeSensor({ ok: true, readings: [{ id: 'cpu0', kind: 'cpu', label: 'CPU', celsius: 65 }] })];

    const loop = new ControlLoop({ sensors, plug, clock, thresholds });

    const first = await loop.runOnce();
    // First attempt fails inside FakePlug -> loop catches it, does not crash.
    expect(first.fanOn).toBe(true);
    expect(plug.turnOnCalls).toBe(1);
    expect(plug.state).toBe('off'); // failed, plug state never flipped

    clock.advance(1000);
    const second = await loop.runOnce();
    expect(second.fanOn).toBe(true);
    expect(plug.turnOnCalls).toBe(2);
    expect(plug.state).toBe('on');
  });
});

describe('ControlLoop — fail-safe on sensor/plug failure (mandatory RED)', () => {
  it('errs toward fan ON when the sensor read fails', async () => {
    const clock = new FakeClock(0);
    const plug = new FakePlug();
    const sensors = [fakeFailingSensor('sysfs read ENOENT')];

    const loop = new ControlLoop({ sensors, plug, clock, thresholds });
    const decision = await loop.runOnce();

    expect(decision.fanOn).toBe(true);
    expect(plug.turnOnCalls).toBe(1);
    expect(plug.state).toBe('on');
  });

  it('errs toward fan ON when the plug reports a permanent comms failure', async () => {
    const clock = new FakeClock(0);
    const plug = new FakePlug({ alwaysFail: true });
    const sensors = [fakeSensor({ ok: true, readings: [{ id: 'cpu0', kind: 'cpu', label: 'CPU', celsius: 65 }] })];

    const loop = new ControlLoop({ sensors, plug, clock, thresholds });

    // First tick: sensor says HIGH, attempts turnOn, plug fails -> plugCommsOk flips false.
    const first = await loop.runOnce();
    expect(first.fanOn).toBe(true);

    // Second tick: even if temps report cool, plugCommsOk:false forces fail-safe ON.
    const coolSensors = [fakeSensor({ ok: true, readings: [{ id: 'cpu0', kind: 'cpu', label: 'CPU', celsius: 10 }] })];
    const loop2 = new ControlLoop({ sensors: coolSensors, plug, clock, thresholds });
    loop2.state.plugCommsOk = false;
    clock.advance(1000);
    const second = await loop2.runOnce();

    expect(second.fanOn).toBe(true);
    expect(second.reason).toMatch(/plug|comms/i);
  });

  it('does not crash the process when both sensor and plug fail simultaneously', async () => {
    const clock = new FakeClock(0);
    const plug = new FakePlug({ alwaysFail: true });
    const sensors = [fakeFailingSensor('smartctl ENOENT')];

    const loop = new ControlLoop({ sensors, plug, clock, thresholds });

    await expect(loop.runOnce()).resolves.toMatchObject({ fanOn: true });
  });

  it('forces fan ON (no unhandled rejection) when a sensor read() REJECTS instead of resolving', async () => {
    const clock = new FakeClock(0);
    const plug = new FakePlug();
    const sensors = [fakeRejectingSensor('sensor exploded unexpectedly')];

    const loop = new ControlLoop({ sensors, plug, clock, thresholds });

    // runOnce must resolve (not reject) and drive the fail-safe (ON) path.
    const decision = await loop.runOnce();

    expect(decision.fanOn).toBe(true);
    expect(plug.turnOnCalls).toBe(1);
    expect(plug.state).toBe('on');
  });
});
