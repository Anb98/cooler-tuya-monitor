export type PlugState = 'on' | 'off' | 'unknown';

export interface PlugController {
  turnOn(): Promise<void>;
  turnOff(): Promise<void>;
  getState(): Promise<PlugState>;
}
