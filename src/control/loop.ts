import type { Logger } from 'pino';
import type { TemperatureSensor } from '../sensors/types.js';
import { readAllSensors } from '../sensors/aggregate.js';
import type { PlugController } from '../tuya/types.js';
import type { Clock } from './clock.js';
import { tick } from './state-machine.js';
import { logCycleEvent, type CommandOutcome, type CycleSample, type RelayReadback } from './telemetry.js';
import type { ControlMemory, Decision, Override, ThresholdConfig } from './types.js';
import { INITIAL_MEMORY } from './types.js';

export interface ControlLoopOptions {
  sensors: TemperatureSensor[];
  plug: PlugController;
  clock: Clock;
  thresholds: ThresholdConfig;
  dryRun?: boolean;
  logger?: Logger;
}

export interface SharedControlState {
  memory: ControlMemory;
  lastDecision: Decision | null;
  lastMaxCpu: number | null;
  lastMaxHdd: number | null;
  override: Override;
  plugCommsOk: boolean;
  /** Fan ON/OFF state last CONFIRMED applied to the plug (null = unknown/never applied). */
  appliedFanOn: boolean | null;
}

/**
 * Tick-driven control loop: reads all sensors, feeds the pure state
 * machine, and drives the plug controller based on the decision. Logs every
 * decision (temps, action, reason) and one `cooler.cycle` telemetry event per
 * completed cycle (see telemetry.ts). Retries plug commands are handled by
 * the PlugController implementation itself (e.g. TuyapiLocalPlug); here we
 * simply track whether the last attempted command succeeded to feed
 * `plugCommsOk` into the next tick's fail-safe evaluation.
 */
export class ControlLoop {
  readonly state: SharedControlState;

  private readonly sensors: TemperatureSensor[];
  private readonly plug: PlugController;
  private readonly clock: Clock;
  private readonly thresholds: ThresholdConfig;
  private readonly dryRun: boolean;
  private readonly logger?: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: ControlLoopOptions) {
    this.sensors = options.sensors;
    this.plug = options.plug;
    this.clock = options.clock;
    this.thresholds = options.thresholds;
    this.dryRun = options.dryRun ?? false;
    this.logger = options.logger;
    this.state = {
      memory: INITIAL_MEMORY,
      lastDecision: null,
      lastMaxCpu: null,
      lastMaxHdd: null,
      override: null,
      plugCommsOk: true,
      appliedFanOn: null,
    };
  }

  setOverride(override: Override): void {
    this.state.override = override;
  }

  start(pollIntervalMs: number): void {
    if (this.timer) return;
    const run = () => {
      // Re-entrancy guard: skip this tick if the previous runOnce() has not
      // resolved yet, so overlapping ticks never race SharedControlState.
      if (this.running) {
        this.logger?.debug('control loop: previous tick still running — skipping this interval');
        return;
      }
      this.running = true;
      void this.runOnce().finally(() => {
        this.running = false;
      });
    };
    this.timer = setInterval(run, pollIntervalMs);
    run(); // Establish safe hardware state without waiting one polling interval.
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<Decision> {
    try {
      const aggregate = await readAllSensors(this.sensors);
      const sample: CycleSample = {
        sampledAt: this.clock.now(),
        maxCpu: aggregate.maxCpu,
        maxHdd: aggregate.maxHdd,
        sensorOk: aggregate.ok,
      };
      const readback = await this.refreshPlugState();
      const override = this.state.override;

      const { memory, decision } = tick(
        this.state.memory,
        {
          maxCpu: aggregate.maxCpu,
          maxHdd: aggregate.maxHdd,
          sensorOk: aggregate.ok,
          plugCommsOk: this.state.plugCommsOk,
          override,
          now: this.clock.now(),
        },
        this.thresholds,
      );

      this.state.memory = memory;
      this.state.lastDecision = decision;
      this.state.lastMaxCpu = aggregate.maxCpu;
      this.state.lastMaxHdd = aggregate.maxHdd;

      if (!aggregate.ok) {
        this.logger?.warn({ errors: aggregate.errors }, 'sensor read failure this tick — fail-safe input');
      }

      const commandOutcome = await this.applyDecision(decision, aggregate.maxCpu, aggregate.maxHdd);
      this.logCycle(sample, readback, override, decision, commandOutcome);

      return decision;
    } catch (err) {
      // Any unexpected throw (e.g. a sensor.read() that rejects instead of
      // resolving {ok:false}) must never leave the fan OFF or at a stale
      // state. Re-derive a fail-safe decision through the same forceOn path
      // (sensorOk:false) and drive the fan ON.
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error({ err: message }, 'control loop: unexpected error during tick — forcing fail-safe ON');
      const readback = await this.refreshPlugState();
      return this.forceFailSafeOn(readback);
    }
  }

  /** Reads the relay before any command; the result is never a command acknowledgement. */
  private async refreshPlugState(): Promise<RelayReadback> {
    try {
      const actual = await this.plug.getState();
      this.state.appliedFanOn = actual === 'unknown' ? null : actual === 'on';
    } catch (err) {
      this.state.appliedFanOn = null;
      this.logger?.warn({ err: String(err) }, 'control loop: plug state read failed');
    }
    const readback: RelayReadback = { readbackAt: this.clock.now(), relayObservedFanOn: this.state.appliedFanOn };
    if (readback.relayObservedFanOn !== null) return readback;
    this.state.plugCommsOk = false;
    this.logger?.warn('control loop: plug state unknown — forcing fail-safe ON');
    // A successful read does not clear an earlier failed command: reassert
    // the safe ON state once before allowing normal auto/manual control.
    return readback;
  }

  /** Drive the fan to the fail-safe (ON) state after an unexpected tick error. */
  private async forceFailSafeOn(readback: RelayReadback): Promise<Decision> {
    const override = this.state.override;
    const { memory, decision } = tick(
      this.state.memory,
      {
        maxCpu: null,
        maxHdd: null,
        sensorOk: false,
        plugCommsOk: this.state.plugCommsOk,
        override,
        now: this.clock.now(),
      },
      this.thresholds,
    );

    this.state.memory = memory;
    this.state.lastDecision = decision;

    const commandOutcome = await this.applyDecision(decision, this.state.lastMaxCpu, this.state.lastMaxHdd);
    // Telemetry reports the fail-safe inputs, not the stale legacy temperatures.
    const sample: CycleSample = { sampledAt: null, maxCpu: null, maxHdd: null, sensorOk: false };
    this.logCycle(sample, readback, override, decision, commandOutcome);

    return decision;
  }

  private logCycle(
    sample: CycleSample,
    readback: RelayReadback,
    override: Override,
    decision: Decision,
    commandOutcome: CommandOutcome,
  ): void {
    const { cpuHigh, hddHigh, cpuCritical, hddCritical } = this.thresholds;
    logCycleEvent(this.logger, () => ({
      event: 'cooler.cycle',
      schema: 1,
      ...sample,
      ...readback,
      completedAt: this.clock.now(),
      thresholds: { cpuHigh, hddHigh, cpuCritical, hddCritical },
      override,
      desiredFanOn: decision.fanOn,
      commandOutcome,
      plugCommsOk: this.state.plugCommsOk,
      dryRun: this.dryRun,
    }));
  }

  private async applyDecision(
    decision: Decision,
    maxCpu: number | null,
    maxHdd: number | null,
  ): Promise<CommandOutcome> {
    const logPayload = {
      maxCpu,
      maxHdd,
      action: decision.action,
      state: decision.state,
      reason: decision.reason,
      dryRun: this.dryRun,
    };

    // Dispatch a plug command whenever the desired fan state has not yet
    // been CONFIRMED applied — this is what makes retries happen on
    // subsequent cycles when a previous attempt failed (design: "system
    // must retry and keep attempting to reach the safe (ON) state").
    const needsCommand = !this.state.plugCommsOk || this.state.appliedFanOn !== decision.fanOn;

    if (!needsCommand) {
      this.logger?.debug(logPayload, 'control loop: hold');
      return 'not_needed';
    }

    this.logger?.info(logPayload, 'control loop: decision');

    try {
      if (decision.fanOn) {
        await this.plug.turnOn();
      } else {
        await this.plug.turnOff();
      }
      this.state.plugCommsOk = true;
      this.state.appliedFanOn = decision.fanOn;
      return 'acknowledged';
    } catch (err) {
      this.state.plugCommsOk = false;
      // A lost acknowledgement can mean the relay changed despite failure.
      this.state.appliedFanOn = null;
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(
        { err: message, action: decision.action },
        'control loop: plug command failed — will retry next cycle',
      );
      return 'failed';
    }
  }
}
