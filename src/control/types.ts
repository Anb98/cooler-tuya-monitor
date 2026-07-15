export type ControlState = 'OFF' | 'ON' | 'ON_MIN_HOLD' | 'COOLING_DWELL';

export type Override = 'on' | 'off' | null;

export interface ThresholdConfig {
  cpuHigh: number;
  cpuLow: number;
  cpuCritical: number;
  hddHigh: number;
  hddLow: number;
  hddCritical: number;
  offDwellSec: number;
  minOnSec: number;
}

export interface TickInput {
  /** Hottest CPU reading this tick, or null if no CPU reading available. */
  maxCpu: number | null;
  /** Hottest HDD reading this tick, or null if no HDD reading available. */
  maxHdd: number | null;
  /** False if any sensor read failed this tick — triggers fail-safe. */
  sensorOk: boolean;
  /** False if the last plug command failed — triggers fail-safe. */
  plugCommsOk: boolean;
  /** Sticky manual override, or null for automatic hysteresis control. */
  override: Override;
  /** Current time in milliseconds, from the injected Clock. */
  now: number;
}

export type FanAction = 'turnOn' | 'turnOff' | 'hold';

export interface Decision {
  state: ControlState;
  action: FanAction;
  /** Whether the fan should be physically ON as a result of this decision. */
  fanOn: boolean;
  reason: string;
}

/** Internal persisted state carried between ticks. */
export interface ControlMemory {
  state: ControlState;
  /** Timestamp (ms) the fan turned ON, or null if currently OFF. */
  onAt: number | null;
  /** Timestamp (ms) all sources first went below LOW during the current ON period, or null. */
  belowLowSince: number | null;
}

export const INITIAL_MEMORY: ControlMemory = {
  state: 'OFF',
  onAt: null,
  belowLowSince: null,
};
