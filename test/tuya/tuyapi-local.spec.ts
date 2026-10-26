import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const connectMock = vi.hoisted(() => vi.fn());
const setMock = vi.hoisted(() => vi.fn());
const disconnectMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());
const destroyMock = vi.hoisted(() => vi.fn());
const TuyaDeviceMock = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    connect: connectMock,
    set: setMock,
    disconnect: disconnectMock,
    get: getMock,
    client: { destroy: destroyMock },
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
    getMock.mockReset();
    destroyMock.mockClear();
  });

  afterEach(() => vi.useRealTimers());

  it.each(['connect', 'get', 'set'])('bounds a hung %s and cleans up every retry', async (stage) => {
    vi.useFakeTimers();
    connectMock.mockResolvedValue(true);
    getMock.mockResolvedValue(true);
    setMock.mockResolvedValue({});
    const hung = () => new Promise<never>(() => {});
    ({ connect: connectMock, get: getMock, set: setMock })[stage]!.mockImplementation(hung);
    const plug = new TuyapiLocalPlug({ ...baseOptions, attemptTimeoutMs: 100, backoffMs: [0] });
    const operation = stage === 'get'
      ? expect(plug.getState()).resolves.toBe('unknown')
      : expect(plug.turnOn()).rejects.toThrow('Tuya command failed after 3 attempts: Tuya attempt timed out after 100ms');
    await vi.runAllTimersAsync();
    await operation;
    expect(connectMock).toHaveBeenCalledTimes(3);
    expect(disconnectMock).toHaveBeenCalledTimes(3);
    expect(destroyMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never sends a late OFF after an expired connection resolves', async () => {
    vi.useFakeTimers();
    let connected!: (value: boolean) => void;
    connectMock.mockImplementation(() => new Promise<boolean>((resolve) => { connected = resolve; }));
    const plug = new TuyapiLocalPlug({ ...baseOptions, attemptTimeoutMs: 100, maxRetries: 1 });
    const failure = expect(plug.turnOff()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    connected(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(setMock).not.toHaveBeenCalled();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it.each([[true, 'on'], [false, 'off'], ['invalid', 'unknown']])('maps readback %s to %s without background reads', async (value, state) => {
    connectMock.mockResolvedValue(true);
    getMock.mockResolvedValue(value);
    const plug = new TuyapiLocalPlug(baseOptions);
    await expect(plug.getState()).resolves.toBe(state);
    expect(getMock).toHaveBeenCalledWith({ dps: 1 });
    expect(TuyaDeviceMock).toHaveBeenCalledWith(expect.objectContaining({ issueGetOnConnect: false }));
    expect(setMock).not.toHaveBeenCalled();
    expect(disconnectMock).toHaveBeenCalledTimes(1);
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
