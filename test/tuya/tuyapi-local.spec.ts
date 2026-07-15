import { describe, expect, it, vi, beforeEach } from 'vitest';

const connectMock = vi.hoisted(() => vi.fn());
const setMock = vi.hoisted(() => vi.fn());
const disconnectMock = vi.hoisted(() => vi.fn());
const TuyaDeviceMock = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    connect: connectMock,
    set: setMock,
    disconnect: disconnectMock,
    // Real tuyapi TuyaDevice is an EventEmitter; the plug attaches an 'error'
    // listener in createDevice(), so the fake must expose .on too.
    on: vi.fn(),
  })),
);

vi.mock('tuyapi', () => ({
  default: TuyaDeviceMock,
}));

import { TuyapiLocalPlug } from '../../src/tuya/tuyapi-local.js';

const baseOptions = { id: 'device-1', key: 'key1234567890123', ip: '10.0.0.5', version: '3.3' };

describe('TuyapiLocalPlug', () => {
  beforeEach(() => {
    connectMock.mockReset();
    setMock.mockReset();
    disconnectMock.mockReset();
    TuyaDeviceMock.mockClear();
  });

  it('resolves without retrying when the command succeeds on first attempt', async () => {
    connectMock.mockResolvedValue(true);
    setMock.mockResolvedValue({});

    const plug = new TuyapiLocalPlug({ ...baseOptions, sleep: vi.fn().mockResolvedValue(undefined) });
    await plug.turnOn();

    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith({ dps: 1, set: true });
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });

  it('retries with backoff up to 3x on transient failures, then succeeds', async () => {
    connectMock.mockResolvedValue(true);
    setMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({});

    const sleep = vi.fn().mockResolvedValue(undefined);
    const plug = new TuyapiLocalPlug({ ...baseOptions, sleep });

    await plug.turnOn();

    expect(setMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it('surfaces a comms failure (throws, does not swallow) after exhausting all retries', async () => {
    connectMock.mockResolvedValue(true);
    setMock.mockRejectedValue(new Error('ECONNRESET'));

    const sleep = vi.fn().mockResolvedValue(undefined);
    const plug = new TuyapiLocalPlug({ ...baseOptions, sleep, maxRetries: 3 });

    await expect(plug.turnOn()).rejects.toThrow(/Tuya command failed after 3 attempts/);
    expect(setMock).toHaveBeenCalledTimes(3);
  });
});
