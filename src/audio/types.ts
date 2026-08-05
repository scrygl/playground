import type { MusicProfile } from '../track/types';

/**
 * The shared clock between the music and the game.
 *
 * Rhythm gameplay (beat gates, pulsing scenery, the Groove multiplier) reads
 * this every frame, so it must be derived from the WebAudio hardware clock
 * rather than from `requestAnimationFrame` — otherwise gates drift out of sync
 * with what the player hears within a lap.
 */
export interface BeatClock {
  bpm: number;
  /** Whether music is actually playing; when false everything else reads zero. */
  running: boolean;
  /** Fractional beats since the music started. */
  beats: number;
  /** Integer index of the beat currently sounding. */
  beatIndex: number;
  /** Progress through the current beat, 0..1. */
  beatPhase: number;
  /** Progress through the current bar of four beats, 0..1. */
  barPhase: number;
  /** Integer index of the current bar. */
  barIndex: number;
  /** Seconds until the next beat lands. */
  timeToNextBeat: number;
  /** Seconds per beat. */
  beatDuration: number;
}

export type SfxName =
  | 'uiMove'
  | 'uiSelect'
  | 'uiBack'
  | 'uiError'
  | 'countdownTick'
  | 'countdownGo'
  | 'boostPad'
  | 'boostFire'
  | 'gateHit'
  | 'gatePerfect'
  | 'gateMiss'
  | 'impactSoft'
  | 'impactHard'
  | 'scrape'
  | 'shieldPickup'
  | 'shieldLow'
  | 'weaponPickup'
  | 'weaponFire'
  | 'explode'
  | 'lapComplete'
  | 'finish'
  | 'respawn'
  | 'eliminated';

export interface SfxOptions {
  /** Linear gain multiplier applied on top of the SFX bus. */
  volume?: number;
  /** Playback rate / pitch multiplier. */
  rate?: number;
  /** -1 hard left to +1 hard right. */
  pan?: number;
}

/** Continuous engine tone, driven every frame from ship state. */
export interface EngineVoice {
  /** 0..1 normalised speed. Drives pitch and brightness. */
  setSpeed(normalised: number): void;
  /** 0..1 throttle input. Drives drive/harmonic content. */
  setThrottle(v: number): void;
  /** 0..1 boost amount. Adds an aggressive upper layer. */
  setBoost(v: number): void;
  /** 0..1 how hard the craft is sliding, adds turbulence noise. */
  setSlip(v: number): void;
  start(): void;
  stop(): void;
}

export interface AudioMixSettings {
  master: number;
  music: number;
  sfx: number;
}

/**
 * The contract the game uses to talk to audio. Implemented by
 * `src/audio/engine.ts`; the rest of the game only ever sees this.
 */
export interface GameAudio {
  /** True once the AudioContext is running. */
  readonly ready: boolean;
  /** Must be called from inside a user gesture handler. */
  unlock(): Promise<void>;
  setMix(mix: Partial<AudioMixSettings>): void;
  getMix(): AudioMixSettings;

  /** Start (or crossfade to) a generated arrangement for this track. */
  startMusic(profile: MusicProfile, seed: string): void;
  stopMusic(fadeSeconds?: number): void;
  /** 0..1 arrangement density — the race director drives this from pace. */
  setMusicIntensity(v: number): void;
  /** Ducks music briefly, e.g. under a big impact. */
  duck(amount: number, seconds: number): void;

  readonly clock: BeatClock;
  readonly engine: EngineVoice;

  play(name: SfxName, options?: SfxOptions): void;
  /** Called once per frame with the frame delta in seconds. */
  update(dt: number): void;
  dispose(): void;
}
