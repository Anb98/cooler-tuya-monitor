import type { Logger } from 'pino';
import type { Override, ThresholdConfig } from './types.js';

export type CommandOutcome = 'not_needed' | 'acknowledged' | 'failed';

/**
 * `cooler.cycle` schema 1: one INFO line per completed control cycle, used to
 * correlate heat, controller demand and observed relay state. Carries typed
 * fields only — never raw errors, credentials or upstream text. Timestamps are
 * epoch milliseconds from the loop clock.
 */
export interface CycleEvent {
  event: 'cooler.cycle';
  schema: 1;
  /** Sensor batch completion; null when the batch failed unexpectedly. */
  sampledAt: number | null;
  /** Pre-command relay read completion (successful or not). */
  readbackAt: number;
  completedAt: number;
  /** Decision inputs: null temperatures on unexpected failure, never stale ones. */
  maxCpu: number | null;
  maxHdd: number | null;
  sensorOk: boolean;
  thresholds: Pick<ThresholdConfig, 'cpuHigh' | 'hddHigh' | 'cpuCritical' | 'hddCritical'>;
  /** Override used by the decision, even if changed while a command was pending. */
  override: Override;
  desiredFanOn: boolean;
  /** Relay state read BEFORE any command this cycle (null = unknown); never a command acknowledgement. */
  relayObservedFanOn: boolean | null;
  commandOutcome: CommandOutcome;
  /** Communication health after the command phase. */
  plugCommsOk: boolean;
  dryRun: boolean;
}

export type CycleSample = Pick<CycleEvent, 'sampledAt' | 'maxCpu' | 'maxHdd' | 'sensorOk'>;
export type RelayReadback = Pick<CycleEvent, 'readbackAt' | 'relayObservedFanOn'>;

/**
 * Observational only: the event is built and written inside a guard so a
 * failing clock, serializer or log sink can never perturb the control cycle.
 */
export function logCycleEvent(logger: Logger | undefined, build: () => CycleEvent): void {
  if (!logger) return;
  try {
    logger.info(build(), 'control loop: cycle');
  } catch {
    // A dropped telemetry line is preferable to changing control behavior.
  }
}
