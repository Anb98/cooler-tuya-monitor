import type { PlugController, PlugState } from '../../src/tuya/types.js';

export interface FakePlugOptions {
  /** If set, this many turnOn/turnOff calls fail before succeeding. */
  failNextCalls?: number;
  /** If true, every call fails (used for permanent comms-failure scenarios). */
  alwaysFail?: boolean;
}

/**
 * In-memory PlugController fake with configurable failure injection and
 * call-count tracking, for deterministic control-loop and tuya-client tests.
 */
export class FakePlug implements PlugController {
  state: PlugState = 'off';
  turnOnCalls = 0;
  turnOffCalls = 0;
  getStateCalls = 0;

  private failuresRemaining: number;
  private readonly alwaysFail: boolean;

  constructor(options: FakePlugOptions = {}) {
    this.failuresRemaining = options.failNextCalls ?? 0;
    this.alwaysFail = options.alwaysFail ?? false;
  }

  private maybeFail(): void {
    if (this.alwaysFail) {
      throw new Error('FakePlug: simulated permanent comms failure');
    }
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('FakePlug: simulated transient comms failure');
    }
  }

  async turnOn(): Promise<void> {
    this.turnOnCalls += 1;
    this.maybeFail();
    this.state = 'on';
  }

  async turnOff(): Promise<void> {
    this.turnOffCalls += 1;
    this.maybeFail();
    this.state = 'off';
  }

  async getState(): Promise<PlugState> {
    this.getStateCalls += 1;
    return this.state;
  }
}
