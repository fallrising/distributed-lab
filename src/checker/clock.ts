// Time-budget interface of the checker. This file is the only exemption of the determinism scan
// (ADR-0001 D2): it is not part of the simulation. AC tests use the state-count budget or a fake clock.
// Declared locally so src/ type-checks without Node or DOM typings (browser-portable core).
declare const performance: { now(): number };

export interface Clock {
  /** Monotonic milliseconds. */
  now(): number;
}

export const systemClock: Clock = {
  now: () => performance.now(),
};
