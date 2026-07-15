import { describe, expect, it } from 'vitest';
import { readAllSensors } from '../../src/sensors/aggregate.js';
import type { SensorResult, TemperatureSensor } from '../../src/sensors/types.js';

function fakeSensor(result: SensorResult): TemperatureSensor {
  return { read: async () => result };
}

describe('readAllSensors', () => {
  it('returns hottest cpu/hdd reading and ok:true when all sensors succeed', async () => {
    const sensors: TemperatureSensor[] = [
      fakeSensor({ ok: true, readings: [{ id: 'cpu0', kind: 'cpu', label: 'CPU', celsius: 55 }] }),
      fakeSensor({ ok: true, readings: [{ id: 'sda', kind: 'hdd', label: '/dev/sda', celsius: 40 }] }),
      fakeSensor({ ok: true, readings: [{ id: 'sdb', kind: 'hdd', label: '/dev/sdb', celsius: 46 }] }),
    ];

    const aggregate = await readAllSensors(sensors);

    expect(aggregate.ok).toBe(true);
    expect(aggregate.maxCpu).toBe(55);
    expect(aggregate.maxHdd).toBe(46);
    expect(aggregate.errors).toEqual([]);
  });

  it('one disk fails among many: overall ok:false, but does not block other devices reads', async () => {
    const sensors: TemperatureSensor[] = [
      fakeSensor({ ok: true, readings: [{ id: 'cpu0', kind: 'cpu', label: 'CPU', celsius: 50 }] }),
      fakeSensor({ ok: true, readings: [{ id: 'sda', kind: 'hdd', label: '/dev/sda', celsius: 41 }] }),
      fakeSensor({ ok: false, error: 'smartctl timed out reading /dev/sdb' }),
      fakeSensor({ ok: true, readings: [{ id: 'sdc', kind: 'hdd', label: '/dev/sdc', celsius: 43 }] }),
    ];

    const aggregate = await readAllSensors(sensors);

    expect(aggregate.ok).toBe(false);
    expect(aggregate.errors).toHaveLength(1);
    // Other devices' successful readings are still present.
    expect(aggregate.readings.some((r) => r.id === 'sda')).toBe(true);
    expect(aggregate.readings.some((r) => r.id === 'sdc')).toBe(true);
    expect(aggregate.maxHdd).toBe(43);
  });
});
