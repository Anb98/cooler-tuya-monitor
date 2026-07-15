import type { ControlMemory, Decision, ThresholdConfig, TickInput } from './types.js';

function isAboveOrEqual(value: number | null, threshold: number): boolean {
  return value !== null && value >= threshold;
}

function allBelowLow(input: TickInput, thresholds: ThresholdConfig): boolean {
  const cpuBelow = input.maxCpu === null || input.maxCpu < thresholds.cpuLow;
  const hddBelow = input.maxHdd === null || input.maxHdd < thresholds.hddLow;
  return cpuBelow && hddBelow;
}

function anyAboveHigh(input: TickInput, thresholds: ThresholdConfig): boolean {
  return isAboveOrEqual(input.maxCpu, thresholds.cpuHigh) || isAboveOrEqual(input.maxHdd, thresholds.hddHigh);
}

function anyAboveOrEqualCritical(input: TickInput, thresholds: ThresholdConfig): boolean {
  return (
    isAboveOrEqual(input.maxCpu, thresholds.cpuCritical) || isAboveOrEqual(input.maxHdd, thresholds.hddCritical)
  );
}

/**
 * Pure hysteresis state machine tick. No side effects, no I/O — takes
 * current memory + tick input + thresholds, returns the next memory and the
 * decision (action to take, and why).
 *
 * Precedence (strict, top wins):
 *   1. critical-safety: cpu>=CRITICAL || hdd>=CRITICAL => force ON, ignores override entirely.
 *   2. fail-safe: !sensorOk || !plugCommsOk => force ON.
 *   3. manual override: sticky 'on'/'off' until cleared to auto (null).
 *   4. hysteresis/auto: trigger rule + dwell + min-on-time state machine.
 */
export function tick(
  memory: ControlMemory,
  input: TickInput,
  thresholds: ThresholdConfig,
): { memory: ControlMemory; decision: Decision } {
  // 1. Critical safety — always wins, even over manual-OFF.
  if (anyAboveOrEqualCritical(input, thresholds)) {
    return forceOn(memory, input, 'critical threshold reached (CPU or HDD >= CRITICAL)');
  }

  // 2. Fail-safe — sensor or plug comms failure forces ON.
  if (!input.sensorOk) {
    return forceOn(memory, input, 'sensor read failure — fail-safe ON');
  }
  if (!input.plugCommsOk) {
    return forceOn(memory, input, 'plug communication failure — fail-safe ON');
  }

  // 3. Manual override — sticky until cleared to auto.
  if (input.override === 'on') {
    return forceOn(memory, input, 'manual override ON');
  }
  if (input.override === 'off') {
    return forceOff(memory, input, 'manual override OFF');
  }

  // 4. Hysteresis / auto.
  return autoTick(memory, input, thresholds);
}

function forceOn(
  memory: ControlMemory,
  input: TickInput,
  reason: string,
): { memory: ControlMemory; decision: Decision } {
  const wasOff = memory.state === 'OFF';
  const nextMemory: ControlMemory = {
    state: 'ON',
    onAt: memory.onAt ?? input.now,
    belowLowSince: null,
  };
  return {
    memory: nextMemory,
    decision: {
      state: nextMemory.state,
      action: wasOff ? 'turnOn' : 'hold',
      fanOn: true,
      reason,
    },
  };
}

function forceOff(
  memory: ControlMemory,
  input: TickInput,
  reason: string,
): { memory: ControlMemory; decision: Decision } {
  // OFF records no onAt, so the tick timestamp is intentionally unused here —
  // `void input` documents that the ignored parameter is deliberate.
  void input;
  const wasOn = memory.state !== 'OFF';
  const nextMemory: ControlMemory = {
    state: 'OFF',
    onAt: null,
    belowLowSince: null,
  };
  return {
    memory: nextMemory,
    decision: {
      state: nextMemory.state,
      action: wasOn ? 'turnOff' : 'hold',
      fanOn: false,
      reason,
    },
  };
}

function autoTick(
  memory: ControlMemory,
  input: TickInput,
  thresholds: ThresholdConfig,
): { memory: ControlMemory; decision: Decision } {
  const high = anyAboveHigh(input, thresholds);
  const allLow = allBelowLow(input, thresholds);

  switch (memory.state) {
    case 'OFF': {
      if (high) {
        return {
          memory: { state: 'ON_MIN_HOLD', onAt: input.now, belowLowSince: null },
          decision: { state: 'ON_MIN_HOLD', action: 'turnOn', fanOn: true, reason: 'CPU or HDD >= HIGH' },
        };
      }
      return {
        memory,
        decision: { state: 'OFF', action: 'hold', fanOn: false, reason: 'all sources below HIGH, fan stays OFF' },
      };
    }

    case 'ON_MIN_HOLD': {
      const onAt = memory.onAt ?? input.now;
      const minOnElapsed = input.now - onAt >= thresholds.minOnSec * 1000;

      if (!minOnElapsed) {
        return {
          memory: { ...memory, belowLowSince: null },
          decision: {
            state: 'ON_MIN_HOLD',
            action: 'hold',
            fanOn: true,
            reason: 'anti-short-cycle: MIN_ON_SEC not yet elapsed',
          },
        };
      }

      // Min-on satisfied: transition to plain ON, re-evaluate this tick as ON.
      return autoTick({ ...memory, state: 'ON' }, input, thresholds);
    }

    case 'ON': {
      if (allLow) {
        return {
          memory: { ...memory, state: 'COOLING_DWELL', belowLowSince: input.now },
          decision: {
            state: 'COOLING_DWELL',
            action: 'hold',
            fanOn: true,
            reason: 'all sources below LOW — starting OFF dwell timer',
          },
        };
      }
      return {
        memory: { ...memory, belowLowSince: null },
        decision: {
          state: 'ON',
          action: 'hold',
          fanOn: true,
          reason: high ? 'CPU or HDD >= HIGH' : 'source between LOW and HIGH — fan stays ON',
        },
      };
    }

    case 'COOLING_DWELL': {
      if (high) {
        return {
          memory: { ...memory, state: 'ON', belowLowSince: null },
          decision: { state: 'ON', action: 'hold', fanOn: true, reason: 'HIGH spike aborted OFF dwell' },
        };
      }
      if (!allLow) {
        // Rose back above LOW (but not HIGH) — cancel dwell, stay ON.
        return {
          memory: { ...memory, state: 'ON', belowLowSince: null },
          decision: {
            state: 'ON',
            action: 'hold',
            fanOn: true,
            reason: 'source rose above LOW during dwell — dwell cancelled',
          },
        };
      }

      const belowLowSince = memory.belowLowSince ?? input.now;
      const dwellElapsed = input.now - belowLowSince >= thresholds.offDwellSec * 1000;

      if (dwellElapsed) {
        return {
          memory: { state: 'OFF', onAt: null, belowLowSince: null },
          decision: { state: 'OFF', action: 'turnOff', fanOn: false, reason: 'OFF_DWELL_SEC elapsed, all sources below LOW' },
        };
      }

      return {
        memory: { ...memory, belowLowSince },
        decision: {
          state: 'COOLING_DWELL',
          action: 'hold',
          fanOn: true,
          reason: 'OFF dwell timer running',
        },
      };
    }

    default: {
      const exhaustive: never = memory.state;
      throw new Error(`Unhandled control state: ${String(exhaustive)}`);
    }
  }
}
