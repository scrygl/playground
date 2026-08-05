/**
 * Pure formatting helpers shared by the menus and the HUD.
 *
 * Everything here is deliberately allocation-aware. The HUD calls some of these
 * sixty times a second, so the two-digit and small-integer lookup tables below
 * exist so a frame can turn a number into text without building a string.
 */

import type { MedalTier } from '../game/profile';

/** "00" … "99". Indexed directly; never rebuilt. */
export const PAD2: readonly string[] = buildPad2();
/** "0" … "999". Covers speeds, positions, lap counts and chain lengths. */
export const NUM: readonly string[] = buildNum(1000);

function buildPad2(): string[] {
  const out: string[] = new Array(100);
  for (let i = 0; i < 100; i++) out[i] = i < 10 ? `0${i}` : `${i}`;
  return out;
}

function buildNum(n: number): string[] {
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = String(i);
  return out;
}

/** Small-integer to string without allocating, falling back for big values. */
export function num(value: number): string {
  const i = value | 0;
  return i >= 0 && i < 1000 ? NUM[i] : String(i);
}

export const NO_TIME = '--:--.--';

/**
 * Milliseconds as `m:ss.cc`.
 *
 * Infinity and negatives render as placeholder dashes rather than `NaN`, which
 * is what an unset personal best actually is.
 */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return NO_TIME;
  const total = Math.floor(ms);
  const cs = Math.floor((total % 1000) / 10);
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000);
  return `${m}:${PAD2[s]}.${PAD2[cs]}`;
}

/** Milliseconds as `mm:ss` — for coarse readouts like a championship total. */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--:--';
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${PAD2[total % 60]}`;
}

/**
 * A signed gap in seconds, e.g. `-0.42` ahead of the ghost, `+1.08` behind.
 * Zero is rendered with a plus so the column never shifts.
 */
export function formatDelta(ms: number): string {
  if (!Number.isFinite(ms)) return '--.--';
  const sign = ms < 0 ? '-' : '+';
  const a = Math.min(Math.abs(ms), 5_999_990);
  const s = Math.floor(a / 1000);
  const cs = Math.floor((a % 1000) / 10);
  return `${sign}${s}.${PAD2[cs]}`;
}

/** Seconds-only gap used in the standings column, e.g. `+2.4`. */
export function formatGap(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds >= 100) return `+${Math.round(seconds)}`;
  return `+${seconds.toFixed(1)}`;
}

/** Metres per second as whole km/h — the number on the speed readout. */
export function speedKph(metresPerSecond: number): number {
  const v = metresPerSecond * 3.6;
  return v > 0 ? Math.round(v) : 0;
}

export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres)) return '—';
  if (metres >= 1000) return `${(metres / 1000).toFixed(2)} km`;
  return `${Math.round(metres)} m`;
}

/** Credits with thin thousands separators. */
export function formatCredits(value: number): string {
  const v = Math.max(0, Math.round(value));
  let s = String(v);
  if (v >= 10000) {
    s = '';
    const raw = String(v);
    for (let i = 0; i < raw.length; i++) {
      const fromEnd = raw.length - i;
      if (i > 0 && fromEnd % 3 === 0) s += ',';
      s += raw[i];
    }
  }
  return s;
}

const ORDINALS = ['th', 'st', 'nd', 'rd'];

export function ordinal(n: number): string {
  const v = Math.abs(Math.round(n));
  const rem100 = v % 100;
  const rem10 = v % 10;
  const suffix = rem100 >= 11 && rem100 <= 13 ? 'th' : (ORDINALS[rem10] ?? 'th');
  return `${v}${suffix}`;
}

export const MEDAL_LABEL: Record<MedalTier, string> = {
  none: 'Unranked',
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  author: 'Author',
};

/** Percentage as an integer string, for readouts like resolution scale. */
export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Difficulty 1..5 rendered as filled/empty bars for the track card. */
export function difficultyBlocks(level: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(level)));
  let out = '';
  for (let i = 0; i < 5; i++) out += i < filled ? '▮' : '▯';
  return out;
}
