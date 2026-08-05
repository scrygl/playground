/**
 * Pure music theory for Velocity Horizon.
 *
 * Deliberately free of every browser API — no `AudioContext`, no `window`, no
 * `performance`. The composer (`music.ts`) and the unit tests both import this
 * module directly, which is what lets the whole musical layer run headless in
 * Node while the WebAudio layer stays lazily constructed in the browser.
 *
 * Everything here is deterministic: given the same seed you get the same
 * progression, the same voicings, the same motifs. Ghost replays and beat gates
 * depend on that.
 */

import { Rng, hashString } from '../core/rng';
import type { MusicProfile } from '../track/types';

/** The six modes the track format can ask for. */
export type ScaleName = MusicProfile['scale'];

/** Semitone offsets from the root, one entry per scale degree. */
export const SCALES: Readonly<Record<ScaleName, readonly number[]>> = {
  /** Natural minor — the default dark-synthwave home. */
  minor: [0, 2, 3, 5, 7, 8, 10],
  /** Phrygian — the flat second gives it that menacing Spanish/industrial bite. */
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  /** Dorian — minor with a bright sixth; the classic techno/house minor. */
  dorian: [0, 2, 3, 5, 7, 9, 10],
  /** Harmonic minor — leading tone gives a real dominant to cadence with. */
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  /** Major pentatonic — open and heroic, used for the lighter tracks. */
  majorPent: [0, 2, 4, 7, 9],
  /** Minor pentatonic — no half steps, so nothing can ever clash. */
  minorPent: [0, 3, 5, 7, 10],
};

export const A4_MIDI = 69;
export const A4_FREQ = 440;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Equal temperament. Accepts fractional MIDI so voices can be detuned in cents. */
export function midiToFreq(midi: number): number {
  return A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Inverse of {@link midiToFreq}; handy for mapping filter cutoffs to pitch. */
export function freqToMidi(freq: number): number {
  return A4_MIDI + 12 * Math.log2(Math.max(freq, 1e-6) / A4_FREQ);
}

/** Cents offset applied to a MIDI number — used for detuned oscillator stacks. */
export function detuneMidi(midi: number, cents: number): number {
  return midi + cents / 100;
}

/** `45` → `"A2"`. Only used by tooling and the piano-roll dump. */
export function midiName(midi: number): string {
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  return `${NOTE_NAMES[pc]}${Math.floor(m / 12) - 1}`;
}

/** Number of notes in one octave of a scale (7 for the modes, 5 for pentatonics). */
export function scaleSize(scale: ScaleName): number {
  return SCALES[scale].length;
}

/**
 * Scale degree → MIDI. `degree` is unbounded in both directions: -1 is the
 * seventh below the root, 7 (on a heptatonic scale) is the octave.
 */
export function degreeToMidi(root: number, scale: ScaleName, degree: number): number {
  const steps = SCALES[scale];
  const n = steps.length;
  const octave = Math.floor(degree / n);
  const index = degree - octave * n;
  return root + octave * 12 + steps[index];
}

/** True when `midi` is a member of the scale in any octave. */
export function isInScale(midi: number, root: number, scale: ScaleName): boolean {
  const pc = (((Math.round(midi) - root) % 12) + 12) % 12;
  return SCALES[scale].includes(pc);
}

/**
 * Snap an arbitrary pitch to the nearest scale tone, preferring downward moves
 * on a tie so melodic lines lean minor rather than drifting sharp.
 */
export function nearestScaleTone(midi: number, root: number, scale: ScaleName): number {
  const target = Math.round(midi);
  for (let d = 0; d <= 6; d++) {
    if (isInScale(target - d, root, scale)) return target - d;
    if (isInScale(target + d, root, scale)) return target + d;
  }
  return target;
}

/** Shift by whole octaves until the note sits inside [low, high]. */
export function transposeToRange(midi: number, low: number, high: number): number {
  if (high < low) return midi;
  let m = midi;
  while (m < low) m += 12;
  while (m > high) m -= 12;
  // If the window is narrower than an octave we can overshoot; clamp politely.
  return Math.max(low, Math.min(high, m));
}

export type ChordQuality =
  | 'min'
  | 'maj'
  | 'dim'
  | 'aug'
  | 'sus2'
  | 'sus4'
  | 'min7'
  | 'maj7'
  | 'dom7'
  | 'minMaj7'
  | 'halfDim7'
  | 'dim7'
  | 'other';

export interface Chord {
  /** Scale degree the chord is built on, 0 = tonic. */
  degree: number;
  /** Root pitch as MIDI. */
  root: number;
  /** Chord tones, ascending, un-voiced (stacked straight out of the scale). */
  pitches: number[];
  quality: ChordQuality;
}

/**
 * Stack scale thirds. On the pentatonic scales "a third up the scale" is really
 * a fourth or a fifth, which yields the quartal voicings that genre lives on —
 * that is intentional, not a bug.
 */
export function buildChord(
  root: number,
  scale: ScaleName,
  degree: number,
  size = 3,
): Chord {
  const pitches: number[] = [];
  for (let i = 0; i < Math.max(1, size); i++) {
    pitches.push(degreeToMidi(root, scale, degree + i * 2));
  }
  return {
    degree,
    root: pitches[0],
    pitches,
    quality: chordQuality(pitches),
  };
}

/** Name a stack of pitches from its interval content (lowest note taken as root). */
export function chordQuality(pitches: readonly number[]): ChordQuality {
  if (pitches.length === 0) return 'other';
  const base = pitches[0];
  const set = new Set<number>();
  for (const p of pitches) set.add((((Math.round(p) - base) % 12) + 12) % 12);
  const has = (n: number): boolean => set.has(n);

  const minor3 = has(3);
  const major3 = has(4);
  const p5 = has(7);
  const d5 = has(6);
  const a5 = has(8) && !minor3;
  const b7 = has(10);
  const M7 = has(11);
  const dd7 = has(9);

  if (minor3 && d5 && dd7 && !b7) return 'dim7';
  if (minor3 && d5 && b7) return 'halfDim7';
  if (minor3 && d5) return 'dim';
  if (major3 && a5 && !p5) return 'aug';
  if (minor3 && M7) return 'minMaj7';
  if (minor3 && b7) return 'min7';
  if (major3 && M7) return 'maj7';
  if (major3 && b7) return 'dom7';
  if (minor3) return 'min';
  if (major3) return 'maj';
  if (has(2) && !has(5)) return 'sus2';
  if (has(5)) return 'sus4';
  if (p5) return 'other';
  return 'other';
}

/**
 * Move a chord's pitch classes to the octaves that sit closest to the previous
 * voicing, so the pad glides between chords instead of leaping. Returns a fresh
 * ascending array centred near `center`.
 */
export function voiceLead(
  previous: readonly number[] | null,
  chord: readonly number[],
  center = 60,
): number[] {
  const anchors =
    previous && previous.length > 0
      ? previous
      : chord.map((_, i) => center + (i - (chord.length - 1) / 2) * 4);

  const out: number[] = [];
  for (const raw of chord) {
    // Octave-transpose this chord tone to sit as close as possible to *any*
    // voice of the previous chord, not to the voice at the same index. Matching
    // by index forces parallel motion — Am7 to Fmaj7 would slide every voice
    // down a third instead of holding the three common tones and moving one.
    let best = raw;
    let bestCost = Infinity;
    for (const anchor of anchors) {
      const candidate = raw + Math.round((anchor - raw) / 12) * 12;
      const cost = Math.abs(candidate - anchor);
      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
    }
    out.push(best);
  }
  out.sort((a, b) => a - b);
  // De-collide unisons produced by two voices landing on the same octave.
  for (let i = 1; i < out.length; i++) {
    if (out[i] === out[i - 1]) out[i] += 12;
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Open a voicing up so the lowest interval is not a muddy minor second/third
 * down in the bass register, and keep the whole thing inside [low, high].
 */
export function spreadVoicing(voicing: readonly number[], low: number, high: number): number[] {
  const out = voicing.slice().sort((a, b) => a - b);
  if (out.length > 2 && out[1] - out[0] < 3) out[0] -= 12;
  for (let i = 0; i < out.length; i++) {
    while (out[i] < low) out[i] += 12;
    while (out[i] > high) out[i] -= 12;
  }
  out.sort((a, b) => a - b);
  // Keep the whole chord inside an octave and a fifth. Voice leading can strand
  // one tone two octaves above the rest, which stops reading as a single chord.
  for (let guard = 0; guard < 6 && out.length > 1; guard++) {
    const top = out.length - 1;
    if (out[top] - out[0] <= MAX_VOICING_SPAN) break;
    out[top] -= 12;
    out.sort((a, b) => a - b);
  }
  return out;
}

/** An octave and a fifth — as wide as a pad voicing can get before it smears. */
const MAX_VOICING_SPAN = 19;

/**
 * Transpose a whole voicing by octaves so its average pitch sits near `center`.
 *
 * Voice leading plus collision-avoidance can ratchet a chain of chords upward
 * an octave at a time; without this the pad slowly climbs out of its register
 * over the course of a progression.
 */
export function recenterVoicing(voicing: readonly number[], center: number): number[] {
  if (voicing.length === 0) return [];
  let mean = 0;
  for (const p of voicing) mean += p;
  mean /= voicing.length;
  const shift = Math.round((center - mean) / 12) * 12;
  return shift === 0 ? voicing.slice() : voicing.map((p) => p + shift);
}

/* -------------------------------------------------------------------------- */
/* Progression generation                                                     */
/* -------------------------------------------------------------------------- */

type Transition = readonly (readonly [degree: number, weight: number])[];

/**
 * Functional-harmony-ish transition weights for the seven-note modes, indexed by
 * the degree we are leaving. Weighted toward the moves that actually sound like
 * driving minor-key electronic music: i→VI, i→VII, VII→i, VI→VII.
 */
const TRANSITIONS_HEPTATONIC: readonly Transition[] = [
  /* 0  i   */ [[5, 5], [6, 4], [3, 3], [2, 2], [4, 2], [1, 1]],
  /* 1  ii  */ [[4, 3], [6, 2], [0, 2], [5, 1]],
  /* 2  III */ [[5, 3], [6, 3], [3, 2], [0, 2]],
  /* 3  iv  */ [[6, 3], [4, 3], [0, 2], [5, 2]],
  /* 4  v   */ [[0, 6], [5, 2], [6, 1]],
  /* 5  VI  */ [[6, 5], [3, 2], [4, 2], [0, 2], [2, 1]],
  /* 6  VII */ [[0, 5], [2, 3], [5, 1], [3, 1]],
];

/** Pentatonic scales have five degrees and no leading tone, so simpler pulls. */
const TRANSITIONS_PENTATONIC: readonly Transition[] = [
  /* 0 */ [[3, 3], [4, 3], [2, 2], [1, 1]],
  /* 1 */ [[4, 2], [0, 2], [3, 1]],
  /* 2 */ [[4, 3], [0, 2], [1, 1]],
  /* 3 */ [[4, 3], [0, 2], [2, 1]],
  /* 4 */ [[0, 4], [2, 2], [3, 1]],
];

/** Degrees that pull hardest back to the tonic, per scale family. */
const CADENCE_DEGREES: Readonly<Record<ScaleName, readonly number[]>> = {
  minor: [6, 4, 5],
  phrygian: [1, 6, 4],
  dorian: [6, 3, 4],
  harmonicMinor: [4, 6, 1],
  majorPent: [4, 3],
  minorPent: [4, 3],
};

/** Each mode leans on its signature chord; nudge the walk toward it. */
const MODE_BIAS: Readonly<Record<ScaleName, Readonly<Record<number, number>>>> = {
  minor: { 5: 1.35, 6: 1.25 },
  phrygian: { 1: 2.6, 6: 1.2 },
  dorian: { 3: 2.2, 6: 1.2 },
  harmonicMinor: { 4: 2.4, 6: 0.6 },
  majorPent: {},
  minorPent: {},
};

export interface ProgressionOptions {
  scale: ScaleName;
  seed: string;
  /** Number of chords in the loop. 4 or 8 read best against 8/16-bar phrases. */
  length?: number;
}

function weightedPick(
  rng: Rng,
  options: Transition,
  weightOf: (degree: number, base: number) => number,
): number {
  let total = 0;
  for (const [degree, weight] of options) total += Math.max(0, weightOf(degree, weight));
  if (total <= 0) return options.length > 0 ? options[0][0] : 0;
  let roll = rng.next() * total;
  for (const [degree, weight] of options) {
    roll -= Math.max(0, weightOf(degree, weight));
    if (roll <= 0) return degree;
  }
  return options[options.length - 1][0];
}

/**
 * A deterministic chord loop as scale degrees. Always starts on the tonic and
 * always ends on a chord that pulls back to it, so the loop point is a cadence
 * rather than a seam. Never returns two identical chords in a row.
 */
export function generateProgression(options: ProgressionOptions): number[] {
  const { scale, seed } = options;
  const length = Math.max(2, options.length ?? 8);
  const table = scaleSize(scale) === 5 ? TRANSITIONS_PENTATONIC : TRANSITIONS_HEPTATONIC;
  const bias = MODE_BIAS[scale];
  const rng = new Rng(hashString(`${seed}|progression|${scale}|${length}`));

  const degrees: number[] = [0];
  const used = new Map<number, number>([[0, 1]]);
  for (let i = 1; i < length; i++) {
    const from = degrees[i - 1];
    const previous = degrees[i - 2] ?? -1;
    const weightOf = (degree: number, base: number): number => {
      let w = base * (bias[degree] ?? 1);
      // No immediate repeats, and a light penalty for anything heard recently —
      // otherwise the walk parks on two chords and the loop stops moving.
      if (degree === from) return 0;
      if (degree === previous) w *= 0.3;
      // The tonic already anchors bar one; re-stating it mid-loop makes the
      // progression sag. Let it back in only for the turnaround.
      if (degree === 0) w *= i === length - 1 ? 0 : 0.3;
      w *= Math.pow(0.55, used.get(degree) ?? 0);
      return w;
    };
    const next = weightedPick(rng, table[from], weightOf);
    degrees.push(next);
    used.set(next, (used.get(next) ?? 0) + 1);
  }

  // Force a real cadence into the loop point so the seam sounds intentional.
  const cadences = CADENCE_DEGREES[scale];
  const last = degrees[length - 1];
  if (last === 0 || last === degrees[length - 2]) {
    const choice = cadences.find((d) => d !== degrees[length - 2]) ?? cadences[0];
    degrees[length - 1] = choice;
  }
  // The halfway point should have left home, so the loop reads as two phrases
  // rather than one plateau. Whatever we substitute has to differ from both
  // neighbours, or the patch itself creates a repeated chord.
  const mid = length >> 1;
  if (length >= 4 && degrees[mid] === 0) {
    const neighbours = new Set([degrees[mid - 1], degrees[mid + 1] ?? -1]);
    const candidates = scaleSize(scale) === 5 ? [3, 4, 2, 1] : [5, 6, 3, 2, 4];
    degrees[mid] = candidates.find((d) => !neighbours.has(d)) ?? degrees[mid];
  }
  return degrees;
}

/**
 * Voice-lead an entire progression in one pass so any bar can be looked up
 * without replaying state. This is what keeps `renderBar(n)` pure.
 */
export function progressionVoicings(
  root: number,
  scale: ScaleName,
  degrees: readonly number[],
  opts: { size?: number; center?: number; low?: number; high?: number } = {},
): number[][] {
  const size = opts.size ?? 4;
  const center = opts.center ?? 62;
  const low = opts.low ?? 48;
  const high = opts.high ?? 79;
  const shape = (previous: number[] | null, degree: number): number[] =>
    recenterVoicing(
      spreadVoicing(voiceLead(previous, buildChord(root, scale, degree, size).pitches, center), low, high),
      center,
    );

  const out: number[][] = [];
  let previous: number[] | null = null;
  for (const degree of degrees) {
    const led = shape(previous, degree);
    out.push(led);
    previous = led;
  }
  // One extra pass so the wrap from the last chord back to the first is smooth
  // too — the loop is heard far more often than the first statement.
  if (out.length > 1) {
    previous = out[out.length - 1];
    for (let i = 0; i < out.length; i++) {
      out[i] = shape(previous, degrees[i]);
      previous = out[i];
    }
  }
  return out;
}

/**
 * A short, memorable melodic cell in scale degrees, with rests encoded as
 * `null`. The lead voice transposes this against whatever chord is current, so
 * one motif carries the whole track.
 */
export function generateMotif(seed: string, steps = 8, restChance = 0.26): (number | null)[] {
  const LOW = -2;
  const HIGH = 9;
  const MOVES = [-3, -2, -2, -1, -1, 1, 1, 2, 2, 3, 4];

  for (let attempt = 0; attempt < 12; attempt++) {
    const rng = new Rng(hashString(`${seed}|motif|${steps}|${attempt}`));
    const out: (number | null)[] = [];
    // Start on a chord tone so the hook lands in the harmony immediately.
    let cursor = rng.pick([0, 2, 4, 4, 7]);
    for (let i = 0; i < steps; i++) {
      // Downbeats always sound: a motif that can rest on beat one is not a hook.
      if (i % 4 !== 0 && rng.next() < restChance) {
        out.push(null);
        continue;
      }
      out.push(cursor);
      const move = rng.pick(MOVES);
      // Reflect off the register limits rather than clamping — clamping makes
      // the line stick to the boundary and repeat the same note forever.
      let next = cursor + move;
      if (next > HIGH || next < LOW) next = cursor - move;
      cursor = Math.max(LOW, Math.min(HIGH, next));
    }

    const sounded = out.filter((v): v is number => v !== null);
    const distinct = new Set(sounded).size;
    const span = Math.max(...sounded) - Math.min(...sounded);
    // Reject flat or wildly leaping cells; a hook needs shape but not chaos.
    if (sounded.length >= Math.ceil(steps * 0.5) && distinct >= 3 && span >= 2 && span <= 9) {
      return out;
    }
  }
  return [0, 2, null, 4, 2, null, 0, -1];
}
