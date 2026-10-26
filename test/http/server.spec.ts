import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/http/server.js';
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

function buildLoop(celsius: number) {
  const clock = new FakeClock(0);
  const plug = new FakePlug();
  const sensors = [fakeSensor({ ok: true, readings: [{ id: 'cpu0', kind: 'cpu', label: 'CPU', celsius }] })];
  const loop = new ControlLoop({ sensors, plug, clock, thresholds });
  return { loop, clock };
}

describe('HTTP server', () => {
  it('GET /health returns a 200 liveness response', async () => {
    const { loop } = buildLoop(20);
    const app = buildServer({ controlState: loop.state });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('GET /status reflects current temps/state/mode/last-decision after a loop cycle', async () => {
    const { loop } = buildLoop(65);
    await loop.runOnce();
    const app = buildServer({ controlState: loop.state });

    const response = await app.inject({ method: 'GET', url: '/status' });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.temps.cpu).toBe(65);
    expect(body.fanOn).toBe(true);
    expect(body.confirmedFanOn).toBe(true);
    expect(body.plugCommsOk).toBe(true);
    expect(body.mode).toBe('auto');
    expect(body.lastDecision.action).toBe('turnOn');
  });

  it('distinguishes desired from unconfirmed state after failed commands', async () => {
    const plug = new FakePlug({ alwaysFail: true });
    const loop = new ControlLoop({ sensors: [fakeSensor({ ok: true, readings: [{ id: 'cpu', kind: 'cpu', label: 'CPU', celsius: 65 }] })], plug, clock: new FakeClock(0), thresholds });
    const app = buildServer({ controlState: loop.state });
    const initial = await app.inject({ method: 'GET', url: '/status' });
    expect(initial.json()).toMatchObject({ fanOn: null, confirmedFanOn: null });
    await loop.runOnce();
    const response = await app.inject({ method: 'GET', url: '/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ fanOn: true, confirmedFanOn: null, plugCommsOk: false });
    expect(response.json().lastDecision.action).toBe('turnOn');
    await app.close();
  });

  it('POST /fan/on then next loop tick keeps fan ON regardless of temps', async () => {
    const { loop } = buildLoop(10);
    const app = buildServer({ controlState: loop.state });

    const response = await app.inject({ method: 'POST', url: '/fan/on' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ override: 'on' });

    const decision = await loop.runOnce();
    expect(decision.fanOn).toBe(true);
  });

  it('preserves manual OFF and lets critical temperature override it', async () => {
    const { loop } = buildLoop(20);
    const app = buildServer({ controlState: loop.state });
    await app.inject({ method: 'POST', url: '/fan/on' });
    await loop.runOnce();
    const response = await app.inject({ method: 'POST', url: '/fan/off' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ override: 'off' });
    expect((await loop.runOnce()).fanOn).toBe(false);
    const hot = new ControlLoop({ sensors: [fakeSensor({ ok: true, readings: [{ id: 'cpu', kind: 'cpu', label: 'CPU', celsius: 80 }] })], plug: new FakePlug(), clock: new FakeClock(0), thresholds });
    const hotApp = buildServer({ controlState: hot.state });
    await hotApp.inject({ method: 'POST', url: '/fan/off' });
    expect((await hot.runOnce()).fanOn).toBe(true);
    await app.close();
    await hotApp.close();
  });

  it('POST /fan/auto clears override, next tick returns to automatic hysteresis', async () => {
    const { loop, clock } = buildLoop(10);
    const app = buildServer({ controlState: loop.state });

    await app.inject({ method: 'POST', url: '/fan/on' });
    await loop.runOnce();

    const response = await app.inject({ method: 'POST', url: '/fan/auto' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ override: null, mode: 'auto' });

    // Advance past MIN_ON_SEC so anti-short-cycling no longer holds the fan
    // ON once override is cleared — otherwise ON_MIN_HOLD legitimately keeps
    // it ON regardless of override state, which is correct behavior but not
    // what this scenario is testing.
    clock.advance((thresholds.minOnSec + 1) * 1000);
    const decision = await loop.runOnce();
    // Cool temps (10°C), auto mode, min-on satisfied -> dwell then eventually OFF;
    // immediately after min-on elapses with all-low, loop enters COOLING_DWELL
    // (still fanOn:true) rather than instantly OFF — assert we're back under
    // automatic hysteresis control (not forced by override).
    expect(decision.reason).not.toMatch(/manual override/i);
  });

  it('decision log/status entry includes CPU temp, disk temps, action, and reason', async () => {
    const { loop } = buildLoop(65);
    await loop.runOnce();
    const app = buildServer({ controlState: loop.state });

    const response = await app.inject({ method: 'GET', url: '/status' });
    const body = response.json();

    expect(body.temps).toHaveProperty('cpu');
    expect(body.temps).toHaveProperty('hdd');
    expect(body.lastDecision).toHaveProperty('action');
    expect(body.lastDecision).toHaveProperty('reason');
    expect(typeof body.lastDecision.reason).toBe('string');
  });
});
