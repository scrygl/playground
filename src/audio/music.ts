/**
 * The composer.
 *
 * `MusicDirector` turns a `MusicProfile` plus a seed into note events, one bar
 * at a time. It never touches WebAudio — it emits data, and `engine.ts`
 * schedules that data against the hardware clock. That split is what makes the
 * musical layer unit-testable in Node and what makes beat gates, ghost replays
 * and the Groove multiplier reproducible: bar N for a given seed and intensity
 * is byte-for-byte the same arrangement every single time.
 *
 * Style target: driving synthwave / dark techno. Four-on-the-floor spine,
 * offbeat bassline, relentless sixteenth arps, long minor pads, and a form with
 * real build-ups and drops rather than one loop repeated until the lap ends.
 */

import { clamp01, lerp } from '../core/mathx';
import { Rng, hashString } from '../core/rng';
import type { MusicProfile } from '../track/types';
import {
  buildChord,
  degreeToMidi,
  generateMotif,
  generateProgression,
  progressionVoicings,
  transposeToRange,
  type Chord,
} from './theory';

export const BEATS_PER_BAR = 4;

export type VoiceName =
  | 'kick'
  | 'sub'
  | 'bass'
  | 'arp'
  | 'pad'
  | 'lead'
  | 'hat'
  | 'snare'
  | 'riser';

export const VOICE_NAMES: readonly VoiceName[] = [
  'kick',
  'sub',
  'bass',
  'arp',
  'pad',
  'lead',
  'hat',
  'snare',
  'riser',
];

const VOICE_ORDER: Readonly<Record<VoiceName, number>> = {
  kick: 0,
  sub: 1,
  bass: 2,
  snare: 3,
  hat: 4,
  arp: 5,
  pad: 6,
  lead: 7,
  riser: 8,
};

/**
 * Percussion voices carry a MIDI number too, but it selects a timbre rather
 * than a pitch. These follow the General MIDI drum map so the numbers read
 * naturally to anyone who has touched a sequencer.
 */
export const DRUM = {
  snare: 38,
  clap: 39,
  closedHat: 42,
  openHat: 46,
  crash: 49,
} as const;

export interface NoteEvent {
  /** Beats from the start of its bar. Always `0 <= time < 4`. */
  time: number;
  /** Length in beats. Always `> 0`; pads may run past the bar line. */
  duration: number;
  /** Integer MIDI note, 0..127. For drums this selects the timbre. */
  midi: number;
  /** Linear velocity, `0 < velocity <= 1`. */
  velocity: number;
  voice: VoiceName;
}

export type SectionKind = 'intro' | 'groove' | 'build' | 'drop' | 'break' | 'peak';

export interface FormSection {
  kind: SectionKind;
  bars: number;
  /** Intensity offset at the first bar of the section. */
  from: number;
  /** Intensity offset at the last bar of the section. */
  to: number;
}

/**
 * The song form, in bars. 80 bars ≈ 2:40 at 120 BPM, so a three-lap race hears
 * roughly one and a half statements — long enough that it never feels like a
 * four-bar loop, short enough that the drops come around often.
 *
 * Every section length is 8 or 16 bars, so section boundaries always land on a
 * phrase boundary and the track's beat gates stay aligned to musical structure.
 */
export const FORM: readonly FormSection[] = [
  { kind: 'intro', bars: 8, from: -0.42, to: -0.3 },
  { kind: 'groove', bars: 16, from: -0.14, to: -0.06 },
  { kind: 'build', bars: 8, from: -0.02, to: 0.3 },
  { kind: 'drop', bars: 16, from: 0.26, to: 0.18 },
  { kind: 'break', bars: 8, from: -0.44, to: -0.28 },
  { kind: 'build', bars: 8, from: 0.0, to: 0.34 },
  { kind: 'peak', bars: 16, from: 0.34, to: 0.26 },
];

/** Total length of one statement of the form. */
export const CYCLE_BARS = FORM.reduce((sum, s) => sum + s.bars, 0);

/**
 * How much of the density range the track profile's own `intensity` reserves as
 * a floor, and how far the race director's pace signal can push before the song
 * form's own swing is added on top.
 */
const INTENSITY_FLOOR_SPAN = 0.34;
const INTENSITY_CEILING = 0.8;

/** Sixteenth-note positions of a 3-3-3-3-4 accent, used to shape the arp. */
const TRESILLO = new Set([0, 3, 6, 9, 12]);

const SECTION_STARTS: readonly number[] = (() => {
  const starts: number[] = [];
  let at = 0;
  for (const section of FORM) {
    starts.push(at);
    at += section.bars;
  }
  return starts;
})();

export interface SectionInfo {
  kind: SectionKind;
  /** Index into {@link FORM}. */
  index: number;
  /** Absolute bar the section started on, for the current cycle. */
  startBar: number;
  bars: number;
  /** 0-based position within the section. */
  barInSection: number;
  /** Bars left before the section ends; 0 on the final bar. */
  barsRemaining: number;
  isFirstBar: boolean;
  isLastBar: boolean;
  /** How far through the section we are, 0..1. */
  progress: number;
  /** Intensity offset this bar contributes. */
  level: number;
  /** Which statement of the form we are on. */
  cycle: number;
}

/** Where in the song form a given absolute bar index falls. */
export function sectionAt(bar: number): SectionInfo {
  const b = Math.max(0, Math.floor(bar));
  const cycle = Math.floor(b / CYCLE_BARS);
  const local = b - cycle * CYCLE_BARS;
  let index = FORM.length - 1;
  for (let i = 0; i < FORM.length; i++) {
    if (local < SECTION_STARTS[i] + FORM[i].bars) {
      index = i;
      break;
    }
  }
  const section = FORM[index];
  const barInSection = local - SECTION_STARTS[index];
  const progress = section.bars > 1 ? barInSection / (section.bars - 1) : 0;
  return {
    kind: section.kind,
    index,
    startBar: cycle * CYCLE_BARS + SECTION_STARTS[index],
    bars: section.bars,
    barInSection,
    barsRemaining: section.bars - 1 - barInSection,
    isFirstBar: barInSection === 0,
    isLastBar: barInSection === section.bars - 1,
    progress,
    level: lerp(section.from, section.to, progress),
    cycle,
  };
}

export interface MusicDirectorOptions {
  /** Chords in the harmonic loop. 8 chords × 2 bars = a 16-bar harmony. */
  progressionLength?: number;
  /** Bars each chord is held for. */
  barsPerChord?: number;
}

function emit(
  out: NoteEvent[],
  voice: VoiceName,
  time: number,
  duration: number,
  midi: number,
  velocity: number,
): void {
  if (!Number.isFinite(time) || time < 0 || time >= BEATS_PER_BAR) return;
  const m = Math.round(midi);
  if (!Number.isFinite(m) || m < 0 || m > 127) return;
  out.push({
    voice,
    time,
    duration: Math.max(0.05, duration),
    midi: m,
    velocity: Math.min(1, Math.max(0.05, velocity)),
  });
}

/**
 * Turns a track's `MusicProfile` into a playable arrangement.
 *
 * Two ways in:
 *  - {@link renderBar} is pure — `(bar, intensity)` in, events out, no state.
 *  - {@link eventsForBar} is the stateful convenience the scheduler uses: it
 *    latches whatever {@link setIntensity} was last given, so arrangement
 *    changes only ever happen on a bar line and never mid-phrase.
 */
export class MusicDirector {
  readonly profile: MusicProfile;
  readonly seed: string;
  readonly beatsPerBar = BEATS_PER_BAR;
  /** Chord loop as scale degrees. */
  readonly progression: readonly number[];
  /** Voice-led pad voicings, one per chord in {@link progression}. */
  readonly voicings: readonly (readonly number[])[];
  /** The track's melodic hook, in scale degrees relative to the current chord. */
  readonly motif: readonly (number | null)[];
  readonly barsPerChord: number;
  /** Tuned kick fundamental — sits in the key so it never fights the bass. */
  readonly kickMidi: number;

  private targetIntensity: number;
  private latchedIntensity: number;

  constructor(profile: MusicProfile, seed: string, options: MusicDirectorOptions = {}) {
    this.profile = profile;
    this.seed = seed;
    this.barsPerChord = Math.max(1, Math.floor(options.barsPerChord ?? 2));
    const length = Math.max(2, Math.floor(options.progressionLength ?? 8));
    this.progression = generateProgression({ scale: profile.scale, seed, length });
    this.voicings = progressionVoicings(profile.root, profile.scale, this.progression, {
      size: 4,
      center: 62,
      low: 50,
      high: 81,
    });
    this.motif = generateMotif(`${seed}|${profile.scale}`, 8);
    this.kickMidi = 24 + (((profile.root % 12) + 12) % 12);
    this.targetIntensity = clamp01(profile.intensity);
    this.latchedIntensity = this.targetIntensity;
  }

  get bpm(): number {
    return this.profile.bpm;
  }

  get secondsPerBeat(): number {
    return 60 / this.profile.bpm;
  }

  get barDuration(): number {
    return (60 / this.profile.bpm) * BEATS_PER_BAR;
  }

  /** The intensity currently sounding (only changes on a bar line). */
  get intensity(): number {
    return this.latchedIntensity;
  }

  /** The intensity requested by the race director, applied at the next bar. */
  get requestedIntensity(): number {
    return this.targetIntensity;
  }

  /** Ask for a new arrangement density. Takes effect on the next bar boundary. */
  setIntensity(v: number): void {
    this.targetIntensity = clamp01(v);
  }

  /**
   * Base intensity floor from the track profile. A profile intensity of 1 means
   * even a crawling player still gets a reasonably busy arrangement.
   */
  get intensityFloor(): number {
    return clamp01(this.profile.intensity) * INTENSITY_FLOOR_SPAN;
  }

  /**
   * Map the race director's 0..1 pace signal, plus where we are in the song
   * form, onto the density the arrangement actually uses.
   *
   * Strictly increasing in `dynamic` — more pace never means less music — and
   * deliberately capped below 1 so the song form still has headroom on top: a
   * drop at half pace must still read as a drop, and an intro at full pace must
   * still read as an intro.
   */
  effectiveIntensity(bar: number, dynamic = this.latchedIntensity): number {
    const floor = this.intensityFloor;
    const base = floor + (INTENSITY_CEILING - floor) * clamp01(dynamic);
    return clamp01(base + sectionAt(bar).level);
  }

  /** Which chord of the loop bar `bar` is sitting on. */
  chordIndexForBar(bar: number): number {
    const n = this.progression.length;
    const i = Math.floor(Math.max(0, bar) / this.barsPerChord);
    return ((i % n) + n) % n;
  }

  chordForBar(bar: number): Chord {
    return buildChord(this.profile.root, this.profile.scale, this.progression[this.chordIndexForBar(bar)], 4);
  }

  voicingForBar(bar: number): readonly number[] {
    return this.voicings[this.chordIndexForBar(bar)];
  }

  sectionForBar(bar: number): SectionInfo {
    return sectionAt(bar);
  }

  /**
   * Latch the requested intensity and render. The scheduler calls this exactly
   * once per bar, which is what keeps transitions on bar lines.
   */
  eventsForBar(bar: number): NoteEvent[] {
    this.latchedIntensity = this.targetIntensity;
    return this.renderBar(bar, this.latchedIntensity);
  }

  /**
   * Pure renderer. Same `(seed, bar, intensity)` always yields the same events
   * in the same order.
   */
  renderBar(bar: number, dynamic = this.latchedIntensity): NoteEvent[] {
    const b = Math.max(0, Math.floor(bar));
    const section = sectionAt(b);
    const eff = this.effectiveIntensity(b, dynamic);
    const out: NoteEvent[] = [];

    this.renderPad(b, eff, out);
    this.renderSub(b, eff, out);
    this.renderKick(b, eff, section, out);
    this.renderHats(b, eff, out);
    this.renderSnare(b, eff, section, out);
    this.renderBass(b, eff, out);
    this.renderArp(b, eff, out);
    this.renderLead(b, eff, section, out);
    this.renderRiser(eff, section, out);

    out.sort((a, c) => a.time - c.time || VOICE_ORDER[a.voice] - VOICE_ORDER[c.voice] || a.midi - c.midi);
    return out;
  }

  /** How many notes each voice plays in a bar. Used by tests and the dev dump. */
  densityForBar(bar: number, dynamic = this.latchedIntensity): Record<VoiceName, number> {
    const counts = {} as Record<VoiceName, number>;
    for (const v of VOICE_NAMES) counts[v] = 0;
    for (const ev of this.renderBar(bar, dynamic)) counts[ev.voice]++;
    return counts;
  }

  /* ---------------------------------------------------------------------- */

  /**
   * A fresh stream per (bar, tag). Deriving randomness from the bar index
   * instead of walking one long stream is what lets any bar be rendered on its
   * own, in any order, and lets a voice thicken as intensity rises without the
   * notes that were already there changing underneath the player.
   */
  private rngFor(bar: number, tag: string): Rng {
    return new Rng(hashString(`${this.seed}|${tag}|${bar}`));
  }

  private renderKick(bar: number, eff: number, section: SectionInfo, out: NoteEvent[]): void {
    const midi = this.kickMidi;
    const slots: [number, number][] = [];
    if (eff < 0.1) {
      slots.push([0, 0.95]);
    } else if (eff < 0.28) {
      slots.push([0, 0.98], [2, 0.86]);
    } else {
      for (let beat = 0; beat < BEATS_PER_BAR; beat++) {
        slots.push([beat, beat === 0 ? 1 : 0.9]);
      }
    }
    if (eff >= 0.52) slots.push([this.rngFor(bar, 'kickA').pick([3.75, 2.75, 1.75]), 0.6]);
    if (eff >= 0.78) slots.push([this.rngFor(bar, 'kickB').pick([3.5, 2.5, 0.75]), 0.54]);

    // The bar before a drop pulls the floor out — the silence is the hook.
    const lift = section.kind === 'build' && section.isLastBar && eff > 0.45;
    for (const [time, velocity] of slots) {
      if (lift && time >= 2) continue;
      emit(out, 'kick', time, 0.5, midi, velocity);
    }
  }

  private renderSub(bar: number, eff: number, out: NoteEvent[]): void {
    const chord = this.chordForBar(bar);
    const midi = transposeToRange(chord.root, 26, 37);
    if (eff < 0.42) {
      // Atmospheric: one long drone under everything.
      emit(out, 'sub', 0, BEATS_PER_BAR, midi, 0.72);
    } else if (eff < 0.72) {
      // Gated with the kick so the low end breathes instead of smearing.
      for (let beat = 0; beat < BEATS_PER_BAR; beat++) {
        emit(out, 'sub', beat, 0.92, midi, beat === 0 ? 0.8 : 0.66);
      }
    } else {
      for (let i = 0; i < 8; i++) {
        emit(out, 'sub', i * 0.5, 0.46, midi, i % 2 === 0 ? 0.78 : 0.6);
      }
    }
  }

  private renderBass(bar: number, eff: number, out: NoteEvent[]): void {
    if (eff < 0.3) return;
    const chord = this.chordForBar(bar);
    const base = transposeToRange(chord.root, 33, 44);
    const tones = chord.pitches.map((p) => transposeToRange(p, base, base + 11));

    // Offbeat eighths are the spine; higher tiers thicken around them rather
    // than filling every sixteenth, which would smear into the sub. The extra
    // sixteenths move every four bars so a sixteen-bar drop is not one loop.
    const shape = this.rngFor(Math.floor(bar / 4), 'bassShape');
    const slots: number[] = [0.5, 1.5, 2.5, 3.5];
    if (eff >= 0.44) slots.push(0, 2);
    if (eff >= 0.6) slots.push(...(shape.bool() ? [0.75, 2.75] : [0.25, 1.75]));
    if (eff >= 0.74) slots.push(...(shape.bool() ? [3.25, 3.75] : [2.25, 3.75]));
    slots.sort((a, c) => a - c);

    for (const time of slots) {
      // Per-slot stream: raising intensity adds notes without rewriting the
      // ones already playing.
      const rng = this.rngFor(bar, `bass@${time}`);
      const onBeat = Number.isInteger(time);
      const roll = rng.next();
      let midi = base;
      if (!onBeat) {
        if (roll > 0.9) midi = base + 12;
        else if (roll > 0.78) midi = tones[Math.min(2, tones.length - 1)];
        else if (roll > 0.66) midi = tones[Math.min(1, tones.length - 1)];
      }
      emit(out, 'bass', time, onBeat ? 0.4 : 0.44, midi, onBeat ? 0.88 : 0.68 + roll * 0.14);
    }
  }

  private renderArp(bar: number, eff: number, out: NoteEvent[]): void {
    if (eff < 0.4) return;
    const voicing = this.voicingForBar(bar);
    const tones: number[] = [];
    for (const p of voicing) tones.push(transposeToRange(p, 64, 75));
    for (const p of voicing) tones.push(transposeToRange(p, 64, 75) + 12);
    tones.sort((a, c) => a - c);
    const n = tones.length;
    if (n === 0) return;

    // Shape changes every four bars so the arp evolves across a phrase.
    const shapeRng = this.rngFor(Math.floor(bar / 4), 'arpShape');
    const shape = shapeRng.int(0, 3);
    const tresillo = shapeRng.bool(0.4);
    const perm = this.rngFor(Math.floor(bar / 4), 'arpPerm').shuffle(
      Array.from({ length: n }, (_, i) => i),
    );

    for (let step = 0; step < 16; step++) {
      const active = eff >= 0.7 ? true : eff >= 0.55 ? step % 4 !== 1 : step % 2 === 0;
      if (!active) continue;
      let index: number;
      switch (shape) {
        case 0:
          index = step % n;
          break;
        case 1:
          index = n - 1 - (step % n);
          break;
        case 2: {
          const span = Math.max(1, n * 2 - 2);
          const t = step % span;
          index = t < n ? t : span - t;
          break;
        }
        default:
          index = perm[step % n];
          break;
      }
      // Alternate a straight four accent with a 3-3-3-3-4 tresillo so a wall of
      // sixteenths still has a pulse inside it.
      const accent = tresillo ? TRESILLO.has(step) : step % 4 === 0;
      emit(out, 'arp', step * 0.25, 0.22, tones[Math.max(0, Math.min(n - 1, index))], accent ? 0.7 : 0.46);
    }
  }

  private renderPad(bar: number, eff: number, out: NoteEvent[]): void {
    // Pads restate on the chord change and sustain across it, so the harmony
    // moves without a retrigger click every bar.
    if (bar % this.barsPerChord !== 0) return;
    const voicing = this.voicingForBar(bar);
    const count = eff < 0.3 ? Math.min(3, voicing.length) : voicing.length;
    // Pull the pad back as the kit fills in; it is the bed, not the feature.
    const velocity = 0.58 - eff * 0.22;
    const duration = this.barsPerChord * BEATS_PER_BAR + 0.25;
    for (let i = 0; i < count; i++) {
      emit(out, 'pad', 0, duration, voicing[i], velocity);
    }
  }

  private renderLead(bar: number, eff: number, section: SectionInfo, out: NoteEvent[]): void {
    const featured = section.kind === 'drop' || section.kind === 'peak';
    if (!(eff >= 0.66 && featured) && !(eff >= 0.86 && section.kind === 'groove')) return;
    // Call and response: the lead sits out every fourth bar so it stays a hook.
    if (section.barInSection % 4 === 3) return;

    const degree = this.progression[this.chordIndexForBar(bar)];
    const lift = section.progress > 0.5 ? 2 : 0;
    for (let step = 0; step < this.motif.length; step++) {
      const cell = this.motif[step];
      if (cell === null) continue;
      const raw = degreeToMidi(this.profile.root, this.profile.scale, degree + cell + lift);
      const midi = transposeToRange(raw, 72, 89);
      const accent = step % 4 === 0;
      emit(out, 'lead', step * 0.5, accent ? 0.46 : 0.38, midi, accent ? 0.82 : 0.66);
    }
  }

  private renderHats(bar: number, eff: number, out: NoteEvent[]): void {
    // Hats come in early and never leave: even the quietest passage keeps a
    // pulse, so a player who has slowed to a crawl still has something to
    // steer to. What changes is the subdivision, not the presence.
    if (eff < 0.12) return;
    const sixteenths = eff >= 0.55;
    const openHats = eff >= 0.42;
    // Move the open hats around every four bars — always two of them, so the
    // density is unchanged, but the groove stops being a metronome.
    const pattern = this.rngFor(Math.floor(bar / 4), 'hatShape').int(0, 2);
    const openSlots = new Set<number>(
      openHats ? [[1.5, 3.5], [0.5, 3.5], [1.5, 3.75]][pattern] : [],
    );

    const step = sixteenths ? 0.25 : 0.5;
    for (let time = 0; time < BEATS_PER_BAR; time += step) {
      if (openSlots.has(time)) continue;
      const sixteenth = Math.round(time * 4);
      const offbeat = sixteenth % 4 === 2;
      const downbeat = sixteenth % 4 === 0;
      const velocity = offbeat ? 0.52 : downbeat ? 0.34 : 0.24;
      emit(out, 'hat', time, sixteenths ? 0.12 : 0.16, DRUM.closedHat, velocity);
    }
    for (const time of openSlots) {
      emit(out, 'hat', time, 0.45, DRUM.openHat, 0.5);
    }
  }

  private renderSnare(bar: number, eff: number, section: SectionInfo, out: NoteEvent[]): void {
    // A crash marks every structural change, at any intensity — it is the
    // signpost that tells the player a new section has begun.
    if (section.isFirstBar && section.kind !== 'intro') {
      emit(out, 'snare', 0, 2, DRUM.crash, 0.62);
    }
    if (eff < 0.34) return;

    const fill = section.isLastBar && eff >= 0.44;
    emit(out, 'snare', 1, 0.4, DRUM.clap, 0.9);
    if (!fill) emit(out, 'snare', 3, 0.4, DRUM.clap, 0.88);

    if (eff >= 0.58) {
      // Ghost notes drift around the backbeat every four bars.
      const ghost = this.rngFor(Math.floor(bar / 4), 'ghost').int(0, 2);
      emit(out, 'snare', [1.75, 1.25, 1.5][ghost], 0.2, DRUM.snare, 0.32);
      if (!fill) emit(out, 'snare', 3.75, 0.2, DRUM.snare, 0.34);
    }
    if (eff >= 0.8) emit(out, 'snare', 2.25, 0.2, DRUM.snare, 0.28);

    if (fill) {
      // Sixteenth roll across the last beat, accelerating into the downbeat.
      for (let i = 0; i < 4; i++) {
        emit(out, 'snare', 3 + i * 0.25, 0.2, DRUM.snare, 0.45 + i * 0.14);
      }
    }
  }

  private renderRiser(eff: number, section: SectionInfo, out: NoteEvent[]): void {
    if (section.kind !== 'build') return;
    if (section.barsRemaining > 1) return;
    const base = transposeToRange(this.profile.root, 60, 71);
    const last = section.barsRemaining === 0;
    emit(out, 'riser', 0, BEATS_PER_BAR, base + (last ? 12 : 0), (last ? 0.78 : 0.46) * (0.6 + eff * 0.4));
  }
}
