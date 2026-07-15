import { describe, expect, it } from 'vitest';
import { tick } from '../../src/control/state-machine.js';
import { INITIAL_MEMORY } from '../../src/control/types.js';
import type { ControlMemory, ThresholdConfig, TickInput } from '../../src/control/types.js';

const thresholds: ThresholdConfig = {
  cpuHigh: 60,
  cpuLow: 48,
  cpuCritical: 80,
  hddHigh: 48,
  hddLow: 42,
  hddCritical: 55,
  offDwellSec: 300,
  minOnSec: 120,
};

function baseInput(overrides: Partial<TickInput> = {}): TickInput {
  return {
    maxCpu: 40,
    maxHdd: 30,
    sensorOk: true,
    plugCommsOk: true,
    override: null,
    now: 0,
    ...overrides,
  };
}

describe('control state machine — fail-safe (mandatory RED)', () => {
  it('treats sensorOk:false as above HIGH and forces/keeps the fan ON regardless of other inputs', () => {
    // Starting from OFF with cool temps but a failed sensor read.
    const { decision } = tick(INITIAL_MEMORY, baseInput({ sensorOk: false, maxCpu: 20, maxHdd: 20 }), thresholds);

    expect(decision.fanOn).toBe(true);
    expect(decision.action).toBe('turnOn');
    expect(decision.reason).toMatch(/sensor/i);
  });

  it('fail-safe wins even under manual-OFF override', () => {
    const memory: ControlMemory = { state: 'OFF', onAt: null, belowLowSince: null };
    const { decision } = tick(
      memory,
      baseInput({ sensorOk: false, override: 'off', maxCpu: 10, maxHdd: 10 }),
      thresholds,
    );

    expect(decision.fanOn).toBe(true);
  });

  it('plug comms failure also forces the fan ON (fail-safe)', () => {
    const { decision } = tick(
      INITIAL_MEMORY,
      baseInput({ plugCommsOk: false, maxCpu: 20, maxHdd: 20 }),
      thresholds,
    );

    expect(decision.fanOn).toBe(true);
    expect(decision.reason).toMatch(/plug|comms/i);
  });
});

describe('control state machine — hysteresis trigger rule', () => {
  it('CPU crosses HIGH from OFF -> transitions to ON', () => {
    const { memory, decision } = tick(INITIAL_MEMORY, baseInput({ maxCpu: 60, maxHdd: 20, now: 0 }), thresholds);

    expect(decision.fanOn).toBe(true);
    expect(decision.action).toBe('turnOn');
    expect(memory.state).toBe('ON_MIN_HOLD');
  });

  it('disk crosses HIGH while CPU is cool -> transitions to ON', () => {
    const { decision } = tick(INITIAL_MEMORY, baseInput({ maxCpu: 20, maxHdd: 48, now: 0 }), thresholds);

    expect(decision.fanOn).toBe(true);
    expect(decision.action).toBe('turnOn');
  });

  it('sources between LOW and HIGH keep fan ON, no OFF sequence starts', () => {
    const onMemory: ControlMemory = { state: 'ON', onAt: 0, belowLowSince: null };
    const { memory, decision } = tick(
      onMemory,
      baseInput({ maxCpu: 50, maxHdd: 30, now: 200_000 }),
      thresholds,
    );

    expect(decision.fanOn).toBe(true);
    expect(decision.state).toBe('ON');
    expect(memory.belowLowSince).toBeNull();
  });
});

describe('control state machine — anti-short-cycling (MIN_ON_SEC)', () => {
  it('fan stays ON until MIN_ON_SEC elapses even if temps drop immediately', () => {
    const step1 = tick(INITIAL_MEMORY, baseInput({ maxCpu: 60, maxHdd: 20, now: 0 }), thresholds);
    expect(step1.memory.state).toBe('ON_MIN_HOLD');

    // Temps drop below LOW right away, but only 60s have passed (< MIN_ON_SEC=120s).
    const step2 = tick(step1.memory, baseInput({ maxCpu: 20, maxHdd: 20, now: 60_000 }), thresholds);
    expect(step2.decision.fanOn).toBe(true);
    expect(step2.memory.state).toBe('ON_MIN_HOLD');

    // After MIN_ON_SEC elapses (now = 121s), it should evaluate as ON and (since all low) begin dwell.
    const step3 = tick(step2.memory, baseInput({ maxCpu: 20, maxHdd: 20, now: 121_000 }), thresholds);
    expect(step3.decision.fanOn).toBe(true);
    expect(step3.memory.state).toBe('COOLING_DWELL');
  });
});

describe('control state machine — OFF dwell timer', () => {
  it('dwell completes uninterrupted -> fan turns OFF', () => {
    let memory: ControlMemory = { state: 'ON', onAt: 0, belowLowSince: null };

    const start = tick(memory, baseInput({ maxCpu: 20, maxHdd: 20, now: 200_000 }), thresholds);
    memory = start.memory;
    expect(memory.state).toBe('COOLING_DWELL');

    const mid = tick(memory, baseInput({ maxCpu: 20, maxHdd: 20, now: 200_000 + 150_000 }), thresholds);
    memory = mid.memory;
    expect(mid.decision.fanOn).toBe(true);
    expect(memory.state).toBe('COOLING_DWELL');

    const done = tick(memory, baseInput({ maxCpu: 20, maxHdd: 20, now: 200_000 + 300_000 }), thresholds);
    expect(done.decision.fanOn).toBe(false);
    expect(done.decision.action).toBe('turnOff');
    expect(done.memory.state).toBe('OFF');
  });

  it('dwell interrupted by a HIGH spike -> dwell cancelled, fan stays ON', () => {
    let memory: ControlMemory = { state: 'ON', onAt: 0, belowLowSince: null };

    const start = tick(memory, baseInput({ maxCpu: 20, maxHdd: 20, now: 200_000 }), thresholds);
    memory = start.memory;
    expect(memory.state).toBe('COOLING_DWELL');

    const spike = tick(memory, baseInput({ maxCpu: 65, maxHdd: 20, now: 250_000 }), thresholds);
    expect(spike.decision.fanOn).toBe(true);
    expect(spike.memory.state).toBe('ON');
    expect(spike.memory.belowLowSince).toBeNull();

    // Confirm dwell must restart from scratch — immediately below LOW again should not
    // instantly turn off (need full new OFF_DWELL_SEC window).
    const afterSpike = tick(spike.memory, baseInput({ maxCpu: 20, maxHdd: 20, now: 250_001 }), thresholds);
    expect(afterSpike.decision.fanOn).toBe(true);
    expect(afterSpike.memory.state).toBe('COOLING_DWELL');
  });
});

describe('control state machine — threshold-equality boundaries', () => {
  it('maxCpu exactly == cpuHigh (60) turns the fan ON (>= HIGH boundary)', () => {
    const { memory, decision } = tick(INITIAL_MEMORY, baseInput({ maxCpu: 60, maxHdd: 20, now: 0 }), thresholds);

    expect(decision.fanOn).toBe(true);
    expect(decision.action).toBe('turnOn');
    expect(memory.state).toBe('ON_MIN_HOLD');
  });

  it('maxCpu exactly == cpuLow (48) does NOT count as below-low (strict <), so no cooling begins', () => {
    const onMemory: ControlMemory = { state: 'ON', onAt: 0, belowLowSince: null };
    const { memory, decision } = tick(onMemory, baseInput({ maxCpu: 48, maxHdd: 20, now: 200_000 }), thresholds);

    expect(decision.fanOn).toBe(true);
    expect(decision.state).toBe('ON');
    expect(memory.state).toBe('ON');
    expect(memory.belowLowSince).toBeNull();
  });

  it('maxCpu exactly == cpuCritical (80) forces critical ON, even under manual-OFF', () => {
    const memory: ControlMemory = { state: 'OFF', onAt: null, belowLowSince: null };
    const { decision } = tick(memory, baseInput({ maxCpu: 80, maxHdd: 20, override: 'off', now: 0 }), thresholds);

    expect(decision.fanOn).toBe(true);
    expect(decision.reason).toMatch(/critical/i);
  });

  it('maxHdd exactly == hddHigh (48) turns the fan ON (>= HIGH boundary)', () => {
    const { memory, decision } = tick(INITIAL_MEMORY, baseInput({ maxCpu: 20, maxHdd: 48, now: 0 }), thresholds);

    expect(decision.fanOn).toBe(true);
    expect(decision.action).toBe('turnOn');
    expect(memory.state).toBe('ON_MIN_HOLD');
  });

  it('maxHdd exactly == hddLow (42) does NOT count as below-low (strict <), so no cooling begins', () => {
    const onMemory: ControlMemory = { state: 'ON', onAt: 0, belowLowSince: null };
    const { memory, decision } = tick(onMemory, baseInput({ maxCpu: 20, maxHdd: 42, now: 200_000 }), thresholds);

    expect(decision.fanOn).toBe(true);
    expect(decision.state).toBe('ON');
    expect(memory.state).toBe('ON');
    expect(memory.belowLowSince).toBeNull();
  });

  it('maxHdd exactly == hddCritical (55) forces critical ON, even under manual-OFF', () => {
    const memory: ControlMemory = { state: 'OFF', onAt: null, belowLowSince: null };
    const { decision } = tick(memory, baseInput({ maxCpu: 20, maxHdd: 55, override: 'off', now: 0 }), thresholds);

    expect(decision.fanOn).toBe(true);
    expect(decision.reason).toMatch(/critical/i);
  });
});

describe('control state machine — manual override', () => {
  it('manual ON persists across cycles regardless of temps', () => {
    const step1 = tick(INITIAL_MEMORY, baseInput({ override: 'on', maxCpu: 10, maxHdd: 10, now: 0 }), thresholds);
    expect(step1.decision.fanOn).toBe(true);

    const step2 = tick(step1.memory, baseInput({ override: 'on', maxCpu: 5, maxHdd: 5, now: 500_000 }), thresholds);
    expect(step2.decision.fanOn).toBe(true);
  });

  it('manual OFF overridden by critical threshold, forced-state reason logged', () => {
    const memory: ControlMemory = { state: 'OFF', onAt: null, belowLowSince: null };
    const { decision } = tick(
      memory,
      baseInput({ override: 'off', maxCpu: 81, maxHdd: 20, now: 0 }),
      thresholds,
    );

    expect(decision.fanOn).toBe(true);
    expect(decision.reason).toMatch(/critical/i);
  });

  it('clearing override returns to auto hysteresis on next cycle', () => {
    const step1 = tick(INITIAL_MEMORY, baseInput({ override: 'on', maxCpu: 10, maxHdd: 10, now: 0 }), thresholds);
    expect(step1.decision.fanOn).toBe(true);

    // Clear to auto — cool temps, should now evaluate under hysteresis (state was forced ON, onAt set at 0).
    const step2 = tick(step1.memory, baseInput({ override: null, maxCpu: 10, maxHdd: 10, now: 200_000 }), thresholds);
    // ON with min-on already elapsed (200s > 120s) and all low -> begins dwell in auto mode.
    expect(step2.memory.state).toBe('COOLING_DWELL');
  });
});
