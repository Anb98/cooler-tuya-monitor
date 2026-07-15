import { readFile } from 'node:fs/promises';
import type { SensorResult, TemperatureSensor } from './types.js';

export interface SysfsCpuSensorOptions {
  /** Path to a sysfs thermal zone temp file, e.g. /sys/class/thermal/thermal_zone0/temp */
  path?: string;
  id?: string;
  label?: string;
}

const DEFAULT_PATH = '/sys/class/thermal/thermal_zone0/temp';

/**
 * Reads CPU temperature from a sysfs thermal zone. The kernel reports
 * millidegrees Celsius as a plain integer string; we convert to °C.
 */
export class SysfsCpuSensor implements TemperatureSensor {
  private readonly path: string;
  private readonly id: string;
  private readonly label: string;

  constructor(options: SysfsCpuSensorOptions = {}) {
    this.path = options.path ?? DEFAULT_PATH;
    this.id = options.id ?? 'cpu0';
    this.label = options.label ?? 'CPU';
  }

  async read(): Promise<SensorResult> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const millidegrees = Number.parseInt(raw.trim(), 10);
      if (Number.isNaN(millidegrees)) {
        return { ok: false, error: `Unparseable sysfs temperature value at ${this.path}: "${raw.trim()}"` };
      }
      const celsius = millidegrees / 1000;
      return {
        ok: true,
        readings: [{ id: this.id, kind: 'cpu', label: this.label, celsius }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to read CPU sysfs temperature at ${this.path}: ${message}` };
    }
  }
}
