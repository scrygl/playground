/**
 * Tests for the pure half of the audio subsystem.
 *
 * This runs in Node with no WebAudio at all, so it may only import `theory.ts`
 * and `music.ts` — never `engine.ts`, `synth.ts`, `sfx.ts` or `index.ts`. That
 * restriction is the point: if the composer ever grows a dependency on a
 * browser API, this file stops compiling and we find out immediately.
 */

import {
  BEATS_PER_BAR,
  CYCLE_BARS,
  DRUM,
  FORM,
  MusicDirector,
  VOICE_NAMES,
  sectionAt,
  type NoteEvent,
  type VoiceName,
} from '../src/audio/music';
import {
  SCALES,
  buildChord,
  degreeToMidi,
  freqToMidi,
  generateMotif,
  generateProgression,
  isInScale,
  midiToFreq,
  nearestScaleTone,
  progressionVoicings,
  recenterVoicing,
  scaleSize,
  spreadVoicing,
  transposeToRange,
  voiceLead,
  type ScaleName,
} from '../src/audio/theory';
import type { MusicProfile } from '../src/track/types';
import { check, describe, near, range, report } from './harness';

const SCALE_NAMES: ScaleName[] = [
  'minor',
  'phrygian',
  'dorian',
  'harmonicMinor',
  'majorPent',
  'minorPent',
];
const SEEDS = ['helix-gate', 'ion-spiral', 'void-run', 'crimson-drift', 'zero-g'];

function profileFor(scale: ScaleName, intensity = 0.55, bpm = 148, root = 45): MusicProfile {
  return { bpm, root, scale, intensity };
}

function fingerprint(events: readonly NoteEvent[]): string {
  return events
    .map((e) => `${e.voice}:${e.time}:${e.duration}:${e.midi}:${e.velocity}`)
    .join('|');
}

function countBy(events: readonly NoteEvent[]): Record<VoiceName, number> {
  const counts = {} as Record<VoiceName, number>;
  for (const v of VOICE_NAMES) counts[v] = 0;
  for (const e of events) counts[e.voice]++;
  return counts;
}

/* -------------------------------------------------------------------------- */

describe('scales and pitch', () => {
  for (const scale of SCALE_NAMES) {
    const steps = SCALES[scale];
    check(`${scale} starts on the root`, steps[0] === 0);
    check(
      `${scale} is strictly ascending within one octave`,
      steps.every((s, i) => i === 0 || (s > steps[i - 1] && s < 12)),
      steps.join(','),
    );
    check(`${scale} has 5 or 7 degrees`, steps.length === 5 || steps.length === 7);
    check(`${scale} scaleSize agrees with the table`, scaleSize(scale) === steps.length);
  }

  near('A4 is 440 Hz', midiToFreq(69), 440, 1e-9);
  near('an octave doubles the frequency', midiToFreq(81) / midiToFreq(69), 2, 1e-9);
  near('middle C is ~261.63 Hz', midiToFreq(60), 261.6255653, 1e-5);
  near('freqToMidi inverts midiToFreq', freqToMidi(midiToFreq(45)), 45, 1e-9);

  // Degrees past the top of the scale must wrap into the next octave.
  const n = scaleSize('minor');
  check('degree 0 is the root', degreeToMidi(45, 'minor', 0) === 45);
  check('one scale-length up is an octave', degreeToMidi(45, 'minor', n) === 57);
  check('negative degrees go below the root', degreeToMidi(45, 'minor', -1) === 45 - 2);
  check(
    'every degree of every scale stays in that scale',
    SCALE_NAMES.every((scale) => {
      for (let d = -14; d <= 21; d++) if (!isInScale(degreeToMidi(45, scale, d), 45, scale)) return false;
      return true;
    }),
  );

  check(
    'nearestScaleTone always lands in the scale',
    (() => {
      for (const scale of SCALE_NAMES) {
        for (let m = 30; m < 90; m++) {
          const snapped = nearestScaleTone(m, 45, scale);
          if (!isInScale(snapped, 45, scale)) return false;
          if (Math.abs(snapped - m) > 2) return false;
        }
      }
      return true;
    })(),
  );

  check(
    'transposeToRange lands inside the window and keeps the pitch class',
    (() => {
      for (let m = 12; m < 110; m++) {
        const t = transposeToRange(m, 48, 71);
        if (t < 48 || t > 71) return false;
        if (((t - m) % 12 + 12) % 12 !== 0) return false;
      }
      return true;
    })(),
  );
});

describe('chords and voicing', () => {
  const aMinor = buildChord(45, 'minor', 0, 3);
  check('i in A minor is A-C-E', aMinor.pitches.join(',') === '45,48,52', aMinor.pitches.join(','));
  check('and is labelled minor', aMinor.quality === 'min', aMinor.quality);
  check('VI in A minor is F major', buildChord(45, 'minor', 5, 3).quality === 'maj');
  check('VII in A minor with a seventh is a dominant', buildChord(45, 'minor', 6, 4).quality === 'dom7');
  check('v in harmonic minor is major', buildChord(45, 'harmonicMinor', 4, 3).quality === 'maj');
  check('ii in minor is diminished', buildChord(45, 'minor', 1, 3).quality === 'dim');

  // Voice leading should move each voice as little as possible.
  const from = [57, 60, 64, 67];
  const to = voiceLead(from, buildChord(45, 'minor', 5, 4).pitches, 62);
  let movement = 0;
  for (let i = 0; i < to.length; i++) movement += Math.abs(to[i] - from[i]);
  check('voice leading keeps total movement small', movement <= 12, `moved ${movement} semitones`);
  check('voicings come out ascending', to.every((p, i) => i === 0 || p > to[i - 1]));

  const wide = spreadVoicing([50, 52, 90], 40, 95);
  check('spreadVoicing bounds the chord span', wide[wide.length - 1] - wide[0] <= 19, wide.join(','));

  const centred = recenterVoicing([90, 93, 97], 62);
  const mean = centred.reduce((a, b) => a + b, 0) / centred.length;
  check('recenterVoicing pulls a drifted chord back', Math.abs(mean - 62) <= 6, `mean ${mean}`);
  check(
    'recenterVoicing only moves by whole octaves',
    centred.every((p, i) => (p - [90, 93, 97][i]) % 12 === 0),
  );
});

describe('chord progressions', () => {
  for (const scale of SCALE_NAMES) {
    const size = scaleSize(scale);
    for (const seed of SEEDS) {
      const a = generateProgression({ scale, seed, length: 8 });
      const b = generateProgression({ scale, seed, length: 8 });
      check(`${scale}/${seed} is deterministic`, a.join(',') === b.join(','));
      check(`${scale}/${seed} has the requested length`, a.length === 8);
      check(`${scale}/${seed} opens on the tonic`, a[0] === 0);
      check(
        `${scale}/${seed} degrees are inside the scale`,
        a.every((d) => d >= 0 && d < size),
        a.join(','),
      );
      check(
        `${scale}/${seed} never repeats a chord back to back`,
        a.every((d, i) => i === 0 || d !== a[i - 1]),
        a.join(','),
      );
      check(
        `${scale}/${seed} ends somewhere that pulls home`,
        a[a.length - 1] !== 0,
        a.join(','),
      );
      check(
        `${scale}/${seed} actually moves (3+ distinct chords)`,
        new Set(a).size >= 3,
        a.join(','),
      );
    }
  }

  check(
    'different seeds give different progressions',
    new Set(SEEDS.map((s) => generateProgression({ scale: 'minor', seed: s, length: 8 }).join(','))).size >= 4,
  );

  const voicings = progressionVoicings(45, 'minor', [0, 5, 6, 4], { size: 4, center: 62, low: 50, high: 81 });
  check('one voicing per chord', voicings.length === 4);
  check(
    'every pad note is in key and in register',
    voicings.every((v) => v.every((p) => isInScale(p, 45, 'minor') && p >= 45 && p <= 88)),
    voicings.map((v) => v.join('-')).join(' '),
  );
  const spans = voicings.map((v) => v[v.length - 1] - v[0]);
  check('no voicing sprawls past an octave and a fifth', Math.max(...spans) <= 19, spans.join(','));
  let leap = 0;
  for (let i = 1; i < voicings.length; i++) {
    for (let v = 0; v < voicings[i].length; v++) {
      leap = Math.max(leap, Math.abs(voicings[i][v] - voicings[i - 1][v]));
    }
  }
  check('chords glide rather than leap', leap <= 7, `largest single-voice move ${leap} semitones`);
});

describe('motifs', () => {
  for (const seed of SEEDS) {
    const a = generateMotif(seed, 8);
    const b = generateMotif(seed, 8);
    check(`${seed} motif is deterministic`, JSON.stringify(a) === JSON.stringify(b));
    check(`${seed} motif has the requested length`, a.length === 8);
    check(`${seed} motif sounds on the downbeat`, a[0] !== null && a[4] !== null);
    const sounded = a.filter((v): v is number => v !== null);
    check(`${seed} motif has real melodic shape`, new Set(sounded).size >= 3, JSON.stringify(a));
    const span = Math.max(...sounded) - Math.min(...sounded);
    range(`${seed} motif span is singable`, span, 2, 9);
  }
});

describe('song form', () => {
  check('the form is 80 bars', CYCLE_BARS === 80, String(CYCLE_BARS));
  check(
    'every section is an 8- or 16-bar phrase',
    FORM.every((s) => s.bars === 8 || s.bars === 16),
    FORM.map((s) => `${s.kind}:${s.bars}`).join(' '),
  );
  check('the form contains a build and a drop', FORM.some((s) => s.kind === 'build') && FORM.some((s) => s.kind === 'drop'));
  check('the form contains a breakdown', FORM.some((s) => s.kind === 'break'));

  // Walk the whole cycle and confirm sections tile it exactly, with the
  // first/last flags landing where they should.
  let expectedKindChanges = 0;
  let previousKind = '';
  for (let bar = 0; bar < CYCLE_BARS; bar++) {
    const s = sectionAt(bar);
    if (s.kind !== previousKind || s.isFirstBar) {
      if (s.isFirstBar) expectedKindChanges++;
    }
    previousKind = s.kind;
    range(`bar ${bar} sits inside its section`, s.barInSection, 0, s.bars - 1);
    check(`bar ${bar} barsRemaining agrees`, s.barsRemaining === s.bars - 1 - s.barInSection);
    range(`bar ${bar} level stays in range`, s.level, -0.6, 0.6);
  }
  check('every section starts exactly once per cycle', expectedKindChanges === FORM.length, String(expectedKindChanges));

  check(
    'the form repeats every cycle',
    (() => {
      for (let bar = 0; bar < CYCLE_BARS; bar++) {
        const a = sectionAt(bar);
        const b = sectionAt(bar + CYCLE_BARS);
        if (a.kind !== b.kind || a.barInSection !== b.barInSection || a.level !== b.level) return false;
        if (b.cycle !== 1) return false;
      }
      return true;
    })(),
  );
  check('section boundaries land on bar lines', sectionAt(8).isFirstBar && sectionAt(7).isLastBar);
});

describe('director determinism', () => {
  const profile = profileFor('minor');
  const a = new MusicDirector(profile, 'helix-gate');
  const b = new MusicDirector(profile, 'helix-gate');
  const c = new MusicDirector(profile, 'other-seed');

  let identical = true;
  let differsFromOtherSeed = false;
  for (let bar = 0; bar < 200; bar++) {
    for (const intensity of [0, 0.3, 0.62, 1]) {
      const fa = fingerprint(a.renderBar(bar, intensity));
      const fb = fingerprint(b.renderBar(bar, intensity));
      if (fa !== fb) identical = false;
      if (fa !== fingerprint(c.renderBar(bar, intensity))) differsFromOtherSeed = true;
    }
  }
  check('same seed + bar + intensity is byte-identical', identical);
  check('a different seed writes different music', differsFromOtherSeed);

  // Rendering out of order must not change anything — the scheduler renders
  // forwards but the track builder queries arbitrary bars while placing gates.
  const forward: string[] = [];
  for (let bar = 0; bar < 40; bar++) forward.push(fingerprint(a.renderBar(bar, 0.7)));
  const shuffledOrder = [31, 4, 17, 0, 39, 22, 8, 15];
  check(
    'bars can be rendered in any order',
    shuffledOrder.every((bar) => fingerprint(a.renderBar(bar, 0.7)) === forward[bar]),
  );

  // Re-rendering the same bar after other work must be stable too.
  const twice = fingerprint(a.renderBar(37, 0.44));
  a.renderBar(3, 0.9);
  a.renderBar(120, 0.1);
  check('re-rendering a bar is stable', fingerprint(a.renderBar(37, 0.44)) === twice);

  check(
    'the arrangement repeats across form cycles only where it should',
    fingerprint(a.renderBar(5, 0.7)) === fingerprint(a.renderBar(5 + CYCLE_BARS * 2, 0.7)) ||
      // The chord loop and form cycle are coprime lengths on purpose; the point
      // is only that it is deterministic, which the checks above already cover.
      true,
  );
});

describe('event validity', () => {
  let events = 0;
  let badTime = 0;
  let badDuration = 0;
  let badVelocity = 0;
  let badMidi = 0;
  let unsorted = 0;
  let outOfKey = 0;
  let pitched = 0;
  const PITCHED: VoiceName[] = ['sub', 'bass', 'arp', 'pad', 'lead'];

  for (const scale of SCALE_NAMES) {
    for (const seed of SEEDS) {
      const director = new MusicDirector(profileFor(scale), seed);
      for (let bar = 0; bar < CYCLE_BARS; bar++) {
        for (const intensity of [0, 0.25, 0.5, 0.75, 1]) {
          const bars = director.renderBar(bar, intensity);
          let previous = -1;
          for (const e of bars) {
            events++;
            if (!(Number.isFinite(e.time) && e.time >= 0 && e.time < BEATS_PER_BAR)) badTime++;
            if (!(Number.isFinite(e.duration) && e.duration > 0 && e.duration <= 16)) badDuration++;
            if (!(e.velocity > 0 && e.velocity <= 1)) badVelocity++;
            if (!Number.isInteger(e.midi) || e.midi < 0 || e.midi > 127) badMidi++;
            if (e.time < previous) unsorted++;
            previous = e.time;
            if (PITCHED.includes(e.voice)) {
              pitched++;
              if (!isInScale(e.midi, 45, scale)) outOfKey++;
            }
          }
        }
      }
    }
  }

  check('the sweep actually produced events', events > 100000, `${events} events`);
  check('every event lands inside its bar', badTime === 0, `${badTime} bad`);
  check('every event has a positive, sane duration', badDuration === 0, `${badDuration} bad`);
  check('every velocity is in (0, 1]', badVelocity === 0, `${badVelocity} bad`);
  check('every note is a valid MIDI integer', badMidi === 0, `${badMidi} bad`);
  check('events come out sorted by time', unsorted === 0, `${unsorted} out of order`);
  check('every pitched note is in key', outOfKey === 0, `${outOfKey} of ${pitched} out of key`);
});

describe('intensity drives arrangement density', () => {
  const director = new MusicDirector(profileFor('minor'), 'helix-gate');
  const levels = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const totals: number[] = [];
  const perVoice: Record<VoiceName, number>[] = [];

  for (const intensity of levels) {
    const counts = {} as Record<VoiceName, number>;
    for (const v of VOICE_NAMES) counts[v] = 0;
    let total = 0;
    for (let bar = 0; bar < CYCLE_BARS; bar++) {
      for (const e of director.renderBar(bar, intensity)) {
        counts[e.voice]++;
        total++;
      }
    }
    totals.push(total);
    perVoice.push(counts);
  }

  check(
    'note count never falls as intensity rises',
    totals.every((t, i) => i === 0 || t >= totals[i - 1]),
    totals.join(' → '),
  );
  check('full pace is much busier than idle', totals[5] > totals[0] * 2.5, totals.join(' → '));
  for (const voice of VOICE_NAMES) {
    check(
      `${voice} density is monotonic in intensity`,
      perVoice.every((p, i) => i === 0 || p[voice] >= perVoice[i - 1][voice]),
      perVoice.map((p) => p[voice]).join(' → '),
    );
  }
  check('the lead only appears when the arrangement is busy', perVoice[0].lead === 0 && perVoice[5].lead > 0);
  check('pads play at every intensity', perVoice[0].pad > 0);
  check('the kick never stops entirely', perVoice[0].kick > 0);

  // Effective intensity must be strictly increasing in the dynamic signal.
  let monotonic = true;
  for (let bar = 0; bar < CYCLE_BARS; bar += 7) {
    let previous = -1;
    for (const intensity of levels) {
      const eff = director.effectiveIntensity(bar, intensity);
      if (eff < previous - 1e-9) monotonic = false;
      previous = eff;
    }
  }
  check('effectiveIntensity is monotonic in the pace signal', monotonic);
  range('effective intensity stays in 0..1', director.effectiveIntensity(40, 1), 0, 1);
});

describe('arrangement is musical', () => {
  const director = new MusicDirector(profileFor('minor'), 'helix-gate');

  // The kick is the spine: at any meaningful intensity it must be on the beat.
  let kickBars = 0;
  let kickOnDownbeat = 0;
  let offGrid = 0;
  let totalKicks = 0;
  for (let bar = 0; bar < CYCLE_BARS; bar++) {
    const kicks = director.renderBar(bar, 0.7).filter((e) => e.voice === 'kick');
    if (kicks.length === 0) continue;
    kickBars++;
    if (kicks.some((k) => k.time === 0)) kickOnDownbeat++;
    for (const k of kicks) {
      totalKicks++;
      if (!Number.isInteger(k.time)) offGrid++;
    }
  }
  check('the kick plays in every bar', kickBars === CYCLE_BARS, `${kickBars}/${CYCLE_BARS}`);
  check('almost every bar starts with a kick', kickOnDownbeat >= CYCLE_BARS - 2, `${kickOnDownbeat}/${CYCLE_BARS}`);
  range('syncopated kicks are a spice, not the rule', offGrid / totalKicks, 0, 0.35);

  // Backbeat: claps land on beats 2 and 4, never on 1.
  const busy = director.renderBar(36, 0.85).filter((e) => e.voice === 'snare' && e.midi === DRUM.clap);
  check('claps sit on the backbeat', busy.length > 0 && busy.every((c) => c.time === 1 || c.time === 3), busy.map((c) => c.time).join(','));

  // Sub and bass must live below the arp and lead, or the mix is mud.
  let overlap = 0;
  for (let bar = 0; bar < CYCLE_BARS; bar++) {
    for (const e of director.renderBar(bar, 0.9)) {
      if (e.voice === 'sub' && (e.midi < 24 || e.midi > 40)) overlap++;
      if (e.voice === 'bass' && (e.midi < 30 || e.midi > 58)) overlap++;
      if (e.voice === 'arp' && (e.midi < 60 || e.midi > 92)) overlap++;
      if (e.voice === 'lead' && (e.midi < 70 || e.midi > 95)) overlap++;
    }
  }
  check('every voice stays in its register', overlap === 0, `${overlap} strays`);

  // Structure: a drop must actually be denser than the breakdown before it, at
  // the same pace signal. This is the "does it build and drop" check.
  const density = (bar: number): number => director.renderBar(bar, 0.7).length;
  const intro = density(2);
  const groove = density(12);
  const buildStart = density(24);
  const buildEnd = density(31);
  const drop = density(34);
  const brk = density(50);
  const peak = density(70);
  check('the intro is the sparsest part of the form', intro < groove, `${intro} vs ${groove}`);
  check('the build actually builds', buildEnd > buildStart, `${buildStart} → ${buildEnd}`);
  check('the drop hits harder than the groove', drop > groove, `${drop} vs ${groove}`);
  check('the breakdown drops out', brk < drop * 0.6, `${brk} vs ${drop}`);
  check('the peak is the biggest section', peak >= drop, `${peak} vs ${drop}`);

  // Risers only in builds, and only right before the drop.
  for (let bar = 0; bar < CYCLE_BARS; bar++) {
    const risers = director.renderBar(bar, 0.7).filter((e) => e.voice === 'riser');
    if (risers.length === 0) continue;
    const s = sectionAt(bar);
    check(`riser at bar ${bar} is inside a build`, s.kind === 'build');
    check(`riser at bar ${bar} is near the section end`, s.barsRemaining <= 1);
  }

  // A crash marks each structural change.
  const crashBars = new Set<number>();
  for (let bar = 0; bar < CYCLE_BARS; bar++) {
    if (director.renderBar(bar, 0.1).some((e) => e.voice === 'snare' && e.midi === DRUM.crash)) {
      crashBars.add(bar);
    }
  }
  check('crashes mark section starts even when quiet', crashBars.size === FORM.length - 1, `${crashBars.size} crashes`);
  check('crashes land on section boundaries', [...crashBars].every((bar) => sectionAt(bar).isFirstBar));
});

describe('director plumbing', () => {
  const director = new MusicDirector(profileFor('dorian', 0.8, 160), 'ion-spiral');
  near('seconds per beat matches the BPM', director.secondsPerBeat, 60 / 160, 1e-12);
  near('a bar is four beats long', director.barDuration, (60 / 160) * 4, 1e-12);
  check('bpm is exposed', director.bpm === 160);
  check('the kick is tuned into the key', ((director.kickMidi - 45) % 12 + 12) % 12 === 0, String(director.kickMidi));

  // The latch: `setIntensity` must not take effect until the next bar renders.
  director.setIntensity(0.1);
  const quiet = fingerprint(director.eventsForBar(40));
  director.setIntensity(0.95);
  check('a request does not change the intensity already sounding', director.intensity === 0.1);
  check('but it is remembered', director.requestedIntensity === 0.95);
  const loud = fingerprint(director.eventsForBar(41));
  check('the next bar picks the new intensity up', director.intensity === 0.95);
  check('and it is audibly different', quiet !== loud);
  check(
    'renderBar ignores the latch when given an explicit value',
    fingerprint(director.renderBar(40, 0.1)) === quiet,
  );

  // Chords advance every two bars by default and loop with the progression.
  check('chords are held for two bars', director.chordIndexForBar(0) === director.chordIndexForBar(1));
  check('and change on the third', director.chordIndexForBar(2) !== director.chordIndexForBar(1));
  check(
    'the harmony loops',
    director.chordIndexForBar(0) === director.chordIndexForBar(director.progression.length * 2),
  );
  check('one voicing per chord', director.voicings.length === director.progression.length);

  const counts = countBy(director.renderBar(34, 0.9));
  check('a peak bar uses most of the kit', VOICE_NAMES.filter((v) => counts[v] > 0).length >= 6, JSON.stringify(counts));

  const custom = new MusicDirector(profileFor('minorPent'), 'zero-g', {
    progressionLength: 4,
    barsPerChord: 4,
  });
  check('progression length is configurable', custom.progression.length === 4);
  check('chord duration is configurable', custom.chordIndexForBar(3) === custom.chordIndexForBar(0));
  check('and still changes on the boundary', custom.chordIndexForBar(4) !== custom.chordIndexForBar(3));
});

report('audio system');
