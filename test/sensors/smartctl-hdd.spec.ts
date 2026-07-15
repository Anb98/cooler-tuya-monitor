import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { SmartctlHddSensor } from '../../src/sensors/smartctl-hdd.js';

/**
 * Builds a fake ChildProcess-like EventEmitter with stdout/stderr streams,
 * letting tests script stdout data and an exit/error event.
 */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('SmartctlHddSensor — security (mandatory RED)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('rejects a HDD_DEVICES entry containing shell metacharacters/injection payloads BEFORE spawning', async () => {
    const maliciousDevices = ['sda; rm -rf /', '$(whoami)', 'sda && cat /etc/passwd', '../../etc/passwd'];

    for (const malicious of maliciousDevices) {
      spawnMock.mockClear();
      const sensor = new SmartctlHddSensor({ devices: [malicious] });
      const result = await sensor.read();

      expect(spawnMock).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.toLowerCase()).toMatch(/invalid|reject|allowlist/);
      }
    }
  });

  it('never invokes a shell and always uses a fixed argv array', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const sensor = new SmartctlHddSensor({ devices: ['sda'] });
    const promise = sensor.read();

    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          ata_smart_attributes: { table: [{ id: 194, raw: { value: 38 } }] },
        }),
      ),
    );
    child.emit('close', 0);

    await promise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe('smartctl');
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(['-A', '-j', '/dev/sda']);
    expect(options?.shell).not.toBe(true);
  });
});

describe('SmartctlHddSensor — fail-safe on process errors (mandatory RED)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('treats ENOENT (missing binary) as ok:false without crashing', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const sensor = new SmartctlHddSensor({ devices: ['sda'] });
    const promise = sensor.read();

    const enoent = Object.assign(new Error('spawn smartctl ENOENT'), { code: 'ENOENT' });
    child.emit('error', enoent);

    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  it('treats a permission-denied spawn error as ok:false without crashing', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const sensor = new SmartctlHddSensor({ devices: ['sda'] });
    const promise = sensor.read();

    const eacces = Object.assign(new Error('spawn smartctl EACCES'), { code: 'EACCES' });
    child.emit('error', eacces);

    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });
});

describe('SmartctlHddSensor — successful reads', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('parses smartctl JSON output and attributes temperature to the correct device', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const sensor = new SmartctlHddSensor({ devices: ['sdb'] });
    const promise = sensor.read();

    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          ata_smart_attributes: {
            table: [
              { id: 5, raw: { value: 0 } },
              { id: 194, raw: { value: 41 } },
            ],
          },
        }),
      ),
    );
    child.emit('close', 0);

    const result = await promise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.readings).toHaveLength(1);
      expect(result.readings[0]?.id).toBe('sdb');
      expect(result.readings[0]?.kind).toBe('hdd');
      expect(result.readings[0]?.celsius).toBe(41);
    }
  });

  it('falls back to temperature.current when attribute 194 is absent', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const sensor = new SmartctlHddSensor({ devices: ['sdc'] });
    const promise = sensor.read();

    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          ata_smart_attributes: { table: [] },
          temperature: { current: 39 },
        }),
      ),
    );
    child.emit('close', 0);

    const result = await promise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.readings[0]?.celsius).toBe(39);
    }
  });

  // Real-world sample (TOSHIBA MQ04ABF100): attribute 194 raw.value is a
  // packed 48-bit field, not celsius — temperature.current must win.
  it('prefers temperature.current over a packed attribute 194 raw.value', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const sensor = new SmartctlHddSensor({ devices: ['sda'] });
    const promise = sensor.read();

    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          temperature: { current: 40 },
          ata_smart_attributes: {
            table: [{ id: 194, raw: { value: 304944054312, string: '40 (Min/Max 21/71)' } }],
          },
        }),
      ),
    );
    child.emit('close', 0);

    const result = await promise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.readings[0]?.celsius).toBe(40);
    }
  });

  it('parses the leading integer of raw.string when temperature.current is absent', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const sensor = new SmartctlHddSensor({ devices: ['sdb'] });
    const promise = sensor.read();

    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          ata_smart_attributes: {
            table: [{ id: 194, raw: { value: 38654705702, string: '38 (0 9 0 0 0)' } }],
          },
        }),
      ),
    );
    child.emit('close', 0);

    const result = await promise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.readings[0]?.celsius).toBe(38);
    }
  });

  it('fails safe (ok:false) when only an implausible packed raw.value is available', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const sensor = new SmartctlHddSensor({ devices: ['sda'] });
    const promise = sensor.read();

    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          ata_smart_attributes: { table: [{ id: 194, raw: { value: 304944054312 } }] },
        }),
      ),
    );
    child.emit('close', 0);

    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no plausible temperature/);
    }
  });
});
