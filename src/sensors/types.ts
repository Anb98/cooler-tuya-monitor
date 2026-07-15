export type SensorKind = 'cpu' | 'hdd';

export interface Reading {
  id: string;
  kind: SensorKind;
  label: string;
  celsius: number;
}

export type SensorResult =
  | { ok: true; readings: Reading[] }
  | { ok: false; error: string };

export interface TemperatureSensor {
  read(): Promise<SensorResult>;
}
