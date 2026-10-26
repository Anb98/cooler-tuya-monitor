import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { bootstrap } from '../src/index.js';
import { FakeClock } from './fakes/fake-clock.js';
import { FakePlug } from './fakes/fake-plug.js';
import type { Config } from '../src/config/env.js';
import type { TemperatureSensor } from '../src/sensors/types.js';

function fakeSensor(celsius: number): TemperatureSensor {
  return {
    read: async () => ({ ok: true, readings: [{ id: 'cpu0', kind: 'cpu', label: 'CPU', celsius }] }),
  };
}

const testConfig: Config = {
  CPU_TEMP_HIGH: 60,
  CPU_TEMP_LOW: 48,
  CPU_TEMP_CRITICAL: 80,
  HDD_TEMP_HIGH: 48,
  HDD_TEMP_LOW: 42,
  HDD_TEMP_CRITICAL: 55,
  POLL_INTERVAL_SEC: 30,
  OFF_DWELL_SEC: 300,
  MIN_ON_SEC: 120,
  HDD_DEVICES: ['sda'],
  TUYA_DEVICE_ID: 'device-1',
  TUYA_LOCAL_KEY: 'key1234567890123',
  TUYA_IP: '10.0.0.5',
  TUYA_VERSION: '3.3',
  DRY_RUN: true,
  FAIL_SAFE: true,
  HTTP_ENABLED: true,
  PORT: 0,
  HTTP_HOST: '0.0.0.0',
  LOG_LEVEL: 'silent',
};

describe('bootstrap wiring', () => {
  it('assembles config -> loop -> http without throwing, using fakes', () => {
    const plug = new FakePlug();

    expect(() =>
      bootstrap({
        config: testConfig,
        logger: pino({ level: 'silent' }),
        sensors: [fakeSensor(20)],
        plug,
        clock: new FakeClock(0),
        registerSignalHandlers: false,
        startHttpListener: false,
      }),
    ).not.toThrow();
  });

  it('SIGTERM handler stops the loop timer without issuing a turnOff command', async () => {
    const plug = new FakePlug();

    const { shutdown, loop } = bootstrap({
      config: testConfig,
      logger: pino({ level: 'silent' }),
      sensors: [fakeSensor(65)],
      plug,
      clock: new FakeClock(0),
      registerSignalHandlers: false,
      startHttpListener: false,
    });

    // Bootstrap now starts the first cycle immediately; do not launch a concurrent tick.
    await vi.waitFor(() => expect(loop.state.appliedFanOn).toBe(true));
    expect(plug.turnOnCalls).toBe(1);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    shutdown('SIGTERM');

    expect(plug.turnOffCalls).toBe(0);
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });
});
