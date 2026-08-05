/** Small numeric helpers used across physics, camera, and UI animation. */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, clamp01(inverseLerp(inMin, inMax, v)));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Framerate-independent exponential approach. `smoothing` is the fraction of
 * the remaining distance still left after one second, so 0.001 is snappy and
 * 0.5 is languid. Unlike a raw `lerp(a, b, 0.1)` this behaves identically at
 * 30fps and 240fps, which matters a lot for camera and steering feel.
 */
export function damp(current: number, target: number, smoothing: number, dt: number): number {
  return lerp(current, target, 1 - Math.pow(smoothing, dt));
}

/** Same idea, expressed as a half-life in seconds — often easier to reason about. */
export function dampHalflife(current: number, target: number, halflife: number, dt: number): number {
  if (halflife <= 0) return target;
  return lerp(current, target, 1 - Math.pow(2, -dt / halflife));
}

/** Move toward a target at a bounded rate; good for values that must not overshoot. */
export function moveToward(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Wrap an angle into [-PI, PI). */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed angular difference from `a` to `b`. */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t;
}

export function dampAngle(current: number, target: number, smoothing: number, dt: number): number {
  return current + angleDelta(current, target) * (1 - Math.pow(smoothing, dt));
}

/** Positive modulo — `-1 mod 10` gives 9, not -1. Used constantly for lap wrapping. */
export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/**
 * Signed distance from `a` to `b` on a loop of length `len`, choosing whichever
 * way round is shorter. Lap and overtake logic depends on this.
 */
export function loopDelta(a: number, b: number, len: number): number {
  let d = mod(b - a, len);
  if (d > len * 0.5) d -= len;
  return d;
}

/** Applies a deadzone then rescales so the usable range still reaches 1. */
export function deadzone(v: number, threshold = 0.15): number {
  const a = Math.abs(v);
  if (a < threshold) return 0;
  return Math.sign(v) * ((a - threshold) / (1 - threshold));
}

/** Standard critically-damped spring. Returns the new value; velocity is mutated in place. */
export function springDamp(
  current: number,
  target: number,
  velocity: { v: number },
  frequency: number,
  damping: number,
  dt: number,
): number {
  const omega = TAU * frequency;
  const f = 1 + 2 * dt * damping * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const detInv = 1 / (f + hhoo);
  const detX = f * current + dt * velocity.v + hhoo * target;
  const detV = velocity.v + hoo * (target - current);
  velocity.v = detV * detInv;
  return detX * detInv;
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--:--.---';
  const totalMs = Math.floor(ms);
  const m = Math.floor(totalMs / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const f = totalMs % 1000;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
}

export function formatDelta(ms: number): string {
  if (!Number.isFinite(ms)) return '--';
  const sign = ms >= 0 ? '+' : '-';
  const a = Math.abs(ms);
  const s = Math.floor(a / 1000);
  const f = Math.floor(a % 1000);
  return `${sign}${s}.${String(f).padStart(3, '0')}`;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
