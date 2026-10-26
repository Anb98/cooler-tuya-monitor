import TuyaDevice from 'tuyapi';
import type { Logger } from 'pino';
import type { PlugController, PlugState } from './types.js';

export interface TuyapiLocalPlugOptions {
  id: string;
  key: string;
  ip: string;
  version: string;
  /** DPS index used to switch the plug. Most single-socket plugs use "1". */
  dps?: number;
  /** Max retry attempts on transient failure. */
  maxRetries?: number;
  /** Deadline covering connect, handshake and the command/read response per attempt. */
  attemptTimeoutMs?: number;
  /** Backoff delays (ms) between retries; last value repeats if retries > delays.length. */
  backoffMs?: number[];
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Logger used to surface raw device 'error' events. */
  logger?: Logger;
}

const DEFAULT_BACKOFF_MS = [500, 2000];
const DEFAULT_MAX_RETRIES = 3;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * PlugController backed by tuyapi's local-LAN protocol. Connects lazily per
 * command (connect -> set dps -> disconnect), retrying transient failures
 * with backoff. An unrecoverable comms failure after all retries is thrown
 * back to the caller (never swallowed), so the control loop can treat it as
 * a fail-safe condition.
 */
export class TuyapiLocalPlug implements PlugController {
  private readonly dps: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number[];
  private readonly attemptTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger?: Logger;
  private readonly deviceOptions: { id: string; key: string; ip: string; version: string };

  constructor(options: TuyapiLocalPlugOptions) {
    this.deviceOptions = {
      id: options.id,
      key: options.key,
      ip: options.ip,
      version: options.version,
    };
    this.dps = options.dps ?? 1;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 10000;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger;
  }

  async turnOn(): Promise<void> {
    await this.withRetry(() => this.setDps(true));
  }

  async turnOff(): Promise<void> {
    await this.withRetry(() => this.setDps(false));
  }

  async getState(): Promise<PlugState> {
    try {
      const value = await this.withRetry(() => this.getDps());
      if (typeof value === 'boolean') {
        return value ? 'on' : 'off';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private async setDps(value: boolean): Promise<void> {
    await this.withDevice((device) => device.set({ dps: this.dps, set: value }));
  }

  private async getDps(): Promise<unknown> {
    return this.withDevice((device) => device.get({ dps: this.dps }));
  }

  private async withDevice<T>(operation: (device: TuyaDevice) => Promise<T>): Promise<T> {
    const device = this.createDevice();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new Error(`Tuya attempt timed out after ${this.attemptTimeoutMs}ms`);
    try {
      return await Promise.race([
        (async () => {
          await device.connect();
          // A late handshake must never dispatch an obsolete command after a retry.
          if (expired) throw timeoutError;
          return operation(device);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(timeoutError);
          }, this.attemptTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      device.disconnect();
      // tuyapi.disconnect() is a no-op before a completed handshake. Destroy
      // its socket too, so a timed-out 3.4 handshake cannot outlive this attempt.
      (device as TuyaDevice & { client?: { destroy(): void } }).client?.destroy();
    }
  }

  private createDevice(): TuyaDevice {
    const device = new TuyaDevice({ ...this.deviceOptions, issueGetOnConnect: false });
    // Attach an 'error' listener IMMEDIATELY. tuyapi emits 'error' from raw
    // socket callbacks (connect-timeout / socket-error / parse-error); with no
    // listener Node throws synchronously and crashes the whole daemon instead
    // of the connect/set/get promise rejecting. A fresh listener per device
    // instance keeps that path safe; the promise still rejects and withRetry
    // handles retries/fail-safe — this listener never alters control flow.
    device.on('error', (err) => this.logger?.warn({ err: err?.message ?? String(err) }, 'tuya device error'));
    return device;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const isLastAttempt = attempt === this.maxRetries - 1;
        if (isLastAttempt) {
          break;
        }
        const delay = this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)] ?? 0;
        await this.sleep(delay);
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Tuya command failed after ${this.maxRetries} attempts: ${message}`);
  }
}
