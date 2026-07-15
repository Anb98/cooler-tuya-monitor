import type { Reading, SensorResult, TemperatureSensor } from './types.js';

export interface AggregateReading {
  maxCpu: number | null;
  maxHdd: number | null;
  readings: Reading[];
  ok: boolean;
  errors: string[];
}

/**
 * Reads all configured sensors and returns the hottest reading per kind
 * (cpu/hdd) plus an overall ok flag. Any single sensor failure makes the
 * aggregate ok:false — this is a fail-safe INPUT: callers (the control
 * state machine) must treat ok:false as "assume worst case, keep cooling
 * on" rather than crash or silently ignore the failure. A single device
 * failure never blocks reads of other devices/sensors.
 */
export async function readAllSensors(sensors: TemperatureSensor[]): Promise<AggregateReading> {
  const results: SensorResult[] = await Promise.all(sensors.map((sensor) => sensor.read()));

  const readings: Reading[] = [];
  const errors: string[] = [];

  for (const result of results) {
    if (result.ok) {
      readings.push(...result.readings);
    } else {
      errors.push(result.error);
    }
  }

  const cpuReadings = readings.filter((r) => r.kind === 'cpu');
  const hddReadings = readings.filter((r) => r.kind === 'hdd');

  const maxCpu = cpuReadings.length > 0 ? Math.max(...cpuReadings.map((r) => r.celsius)) : null;
  const maxHdd = hddReadings.length > 0 ? Math.max(...hddReadings.map((r) => r.celsius)) : null;

  return {
    maxCpu,
    maxHdd,
    readings,
    ok: errors.length === 0,
    errors,
  };
}
