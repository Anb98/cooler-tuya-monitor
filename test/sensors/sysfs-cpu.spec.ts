import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SysfsCpuSensor } from '../../src/sensors/sysfs-cpu.js';

describe('SysfsCpuSensor', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sysfs-cpu-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a numeric °C value on a successful read', async () => {
    const path = join(dir, 'temp');
    await writeFile(path, '52341\n');

    const sensor = new SysfsCpuSensor({ path });
    const result = await sensor.read();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.readings).toHaveLength(1);
      expect(result.readings[0]?.kind).toBe('cpu');
      expect(result.readings[0]?.celsius).toBeCloseTo(52.341, 3);
    }
  });

  it('returns ok:false without throwing when the path is missing or unreadable', async () => {
    const missingPath = join(dir, 'does-not-exist');
    const sensor = new SysfsCpuSensor({ path: missingPath });

    const result = await sensor.read();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });
});
