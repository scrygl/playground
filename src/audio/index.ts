/**
 * Public entry point for the audio subsystem.
 *
 * The game should only ever need `createGameAudio()` and the `GameAudio`
 * interface:
 *
 * ```ts
 * import { createGameAudio } from '@/audio';
 *
 * const audio = createGameAudio();
 *
 * startButton.addEventListener('click', async () => {
 *   await audio.unlock();                       // must be a user gesture
 *   audio.startMusic(track.music, track.seed);  // MusicProfile + track seed
 *   audio.engine.start();
 * });
 *
 * function frame(dt: number): void {
 *   audio.update(dt);
 *   audio.setMusicIntensity(race.pace);         // 0..1, smoothed internally
 *   audio.engine.setSpeed(ship.speed / ship.topSpeed);
 *   audio.engine.setThrottle(input.throttle);
 *   audio.engine.setBoost(ship.boost);
 *   audio.engine.setSlip(ship.slip);
 *
 *   const { barPhase, beatIndex, timeToNextBeat } = audio.clock;
 *   scenery.pulse(barPhase);
 *   if (gate.beat === beatIndex % 4 && timeToNextBeat < 0.08) gate.arm();
 * }
 * ```
 *
 * The composer is exported too, because the track builder needs it: placing
 * beat gates means asking the same `MusicDirector` the audio engine is playing
 * where the kicks land, and both agree because the arrangement is a pure
 * function of `(seed, bar, intensity)`.
 */

export { createGameAudio, WebAudioGameAudio, type GameAudioOptions } from './engine';

export {
  MusicDirector,
  sectionAt,
  BEATS_PER_BAR,
  CYCLE_BARS,
  DRUM,
  FORM,
  VOICE_NAMES,
  type FormSection,
  type MusicDirectorOptions,
  type NoteEvent,
  type SectionInfo,
  type SectionKind,
  type VoiceName,
} from './music';

export {
  SCALES,
  buildChord,
  chordQuality,
  degreeToMidi,
  freqToMidi,
  generateMotif,
  generateProgression,
  isInScale,
  midiName,
  midiToFreq,
  nearestScaleTone,
  progressionVoicings,
  recenterVoicing,
  scaleSize,
  spreadVoicing,
  transposeToRange,
  voiceLead,
  type Chord,
  type ChordQuality,
  type ProgressionOptions,
  type ScaleName,
} from './theory';

export {
  MusicSynth,
  ShipEngineVoice,
  createAudioGraph,
  createImpulseResponse,
  createNoiseBuffer,
  type AudioGraph,
  type ImpulseOptions,
} from './synth';

export { SfxPlayer } from './sfx';

export type {
  AudioMixSettings,
  BeatClock,
  EngineVoice,
  GameAudio,
  SfxName,
  SfxOptions,
} from './types';
