/**
 * FDE Gym — seeded deterministic PRNG.
 *
 * A tiny `mulberry32` implementation with a typed, two-method surface
 * (`next`, `nextInt`). It is PURE and deterministic: the same seed always
 * produces the same sequence, and NO `Math.random()` is ever called. This is
 * the only source of randomness the deterministic control plane may consume;
 * anything driven by a run seed must flow through an `Rng` produced here.
 *
 * `next()` returns a float in `[0, 1)`; `nextInt(n)` returns an integer in
 * `[0, n)` for positive integer `n` (throws otherwise). The internal state is
 * a single 32-bit counter advanced by `mulberry32`; `Math.imul` and
 * `Math.floor` are deterministic and permitted (only `Math.random` is banned).
 */

export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). `n` must be a positive integer. */
  nextInt(n: number): number;
}

export function createRng(seed: number): Rng {
  // Fold the seed into an unsigned 32-bit integer so any number (even
  // negative or non-integer) maps to a fixed, reproducible state.
  let state = seed >>> 0;

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    nextInt(n: number): number {
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`nextInt(n) requires a positive integer, got ${String(n)}`);
      }
      return Math.floor(next() * n);
    },
  };
}
