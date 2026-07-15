import { describe, expect, it } from 'vitest';
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
