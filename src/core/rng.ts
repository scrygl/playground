/**
 * Deterministic pseudo-random numbers.
 *
 * Every procedural system in the game (tracks, environments, music, ship
 * liveries) draws from a seeded stream so that a given seed always produces the
 * identical race. That matters for ghost replays and for sharing a seed.
 */

/** FNV-1a — turns a human-readable seed like "helix-gate" into a 32-bit int. */
export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number | string = 1) {
    this.state = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) || 1;
  }

  /** mulberry32 — small, fast, and statistically fine for content generation. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length) % items.length];
  }

  /** Fisher-Yates, in place, returns the same array for chaining. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  /** Approximately normal via the sum of uniforms (Irwin-Hall, n=4). */
  gaussian(mean = 0, stdDev = 1): number {
    const u = this.next() + this.next() + this.next() + this.next() - 2;
    return mean + u * 0.8660254 * stdDev;
  }

  /** Independent child stream, so one system's draws can't desync another's. */
  fork(salt: string): Rng {
    return new Rng((this.state ^ hashString(salt)) >>> 0);
  }
}

/**
 * Classic 1D value noise with cubic interpolation. Used for track undulation
 * and other places where we want smooth, repeatable wobble rather than jitter.
 */
export class ValueNoise1D {
  private readonly table: Float32Array;

  constructor(seed: number | string, size = 512) {
    const rng = new Rng(seed);
    this.table = new Float32Array(size);
    for (let i = 0; i < size; i++) this.table[i] = rng.range(-1, 1);
  }

  at(x: number): number {
    const n = this.table.length;
    const i = Math.floor(x);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    const a = this.table[((i % n) + n) % n];
    const b = this.table[(((i + 1) % n) + n) % n];
    return a + (b - a) * s;
  }

  /** Sum of octaves — larger features with finer detail layered on top. */
  fbm(x: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.at(x * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }
}
