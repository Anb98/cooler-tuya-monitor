export interface Clock {
  now(): number;
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
}
