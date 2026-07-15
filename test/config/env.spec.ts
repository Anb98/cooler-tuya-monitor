import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

const fullValidEnv = {
  TUYA_DEVICE_ID: 'device-123',
  TUYA_LOCAL_KEY: 'local-key-abc',
  TUYA_IP: '192.168.1.50',
  TUYA_VERSION: '3.3',
  CPU_TEMP_HIGH: '60',
  CPU_TEMP_LOW: '48',
  CPU_TEMP_CRITICAL: '80',
  HDD_TEMP_HIGH: '48',
  HDD_TEMP_LOW: '42',
  HDD_TEMP_CRITICAL: '55',
  POLL_INTERVAL_SEC: '30',
  OFF_DWELL_SEC: '300',
  MIN_ON_SEC: '120',
  HDD_DEVICES: 'sda,sdb,sdc,sdd,sde',
  DRY_RUN: 'false',
  FAIL_SAFE: 'true',
  HTTP_ENABLED: 'true',
  PORT: '3000',
};

describe('loadConfig', () => {
  it('exits the process with a clear validation error when TUYA_LOCAL_KEY is unset', () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { TUYA_LOCAL_KEY, ...envWithoutKey } = fullValidEnv;
    void TUYA_LOCAL_KEY;

    loadConfig(envWithoutKey as NodeJS.ProcessEnv);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]?.[0]).toContain('TUYA_LOCAL_KEY');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('parses a valid full environment successfully with correct types and defaults', () => {
    const config = loadConfig(fullValidEnv as NodeJS.ProcessEnv);

    expect(config.TUYA_DEVICE_ID).toBe('device-123');
    expect(config.TUYA_LOCAL_KEY).toBe('local-key-abc');
    expect(config.CPU_TEMP_HIGH).toBe(60);
    expect(config.HDD_TEMP_LOW).toBe(42);
    expect(config.HDD_DEVICES).toEqual(['sda', 'sdb', 'sdc', 'sdd', 'sde']);
    expect(config.DRY_RUN).toBe(false);
    expect(config.FAIL_SAFE).toBe(true);
    expect(config.HTTP_ENABLED).toBe(true);
    expect(config.PORT).toBe(3000);
  });

  it('rejects a threshold misconfiguration where CPU_TEMP_LOW >= CPU_TEMP_HIGH', () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const badEnv = { ...fullValidEnv, CPU_TEMP_LOW: '60', CPU_TEMP_HIGH: '60' };

    loadConfig(badEnv as NodeJS.ProcessEnv);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]?.[0]).toContain('CPU_TEMP_LOW');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('applies documented defaults when optional env vars are absent', () => {
    const minimalEnv = {
      TUYA_DEVICE_ID: 'device-123',
      TUYA_LOCAL_KEY: 'local-key-abc',
      TUYA_IP: '192.168.1.50',
    };

    const config = loadConfig(minimalEnv as NodeJS.ProcessEnv);

    expect(config.CPU_TEMP_HIGH).toBe(60);
    expect(config.CPU_TEMP_LOW).toBe(48);
    expect(config.CPU_TEMP_CRITICAL).toBe(80);
    expect(config.HDD_TEMP_HIGH).toBe(48);
    expect(config.HDD_TEMP_LOW).toBe(42);
    expect(config.HDD_TEMP_CRITICAL).toBe(55);
    expect(config.POLL_INTERVAL_SEC).toBe(30);
    expect(config.OFF_DWELL_SEC).toBe(300);
    expect(config.MIN_ON_SEC).toBe(120);
    expect(config.HDD_DEVICES).toEqual(['sda', 'sdb', 'sdc', 'sdd', 'sde']);
    expect(config.DRY_RUN).toBe(false);
    expect(config.FAIL_SAFE).toBe(true);
    expect(config.HTTP_ENABLED).toBe(true);
    expect(config.PORT).toBe(3000);
  });
});
