import type { Clock } from '../../src/control/clock.js';

/** Manually advanceable clock for deterministic time-based tests. */
export class FakeClock implements Clock {
  private currentMs: number;

  constructor(startMs = 0) {
    this.currentMs = startMs;
  }

  now(): number {
    return this.currentMs;
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }

  set(ms: number): void {
    this.currentMs = ms;
  }
}
