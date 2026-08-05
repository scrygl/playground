/**
 * The `GameAudio` implementation.
 *
 * Three jobs live here and nowhere else:
 *
 *  1. **Autoplay policy.** Nothing is constructed until `unlock()` is called
 *     from inside a user gesture. Before that the object is fully usable — you
 *     can set the mix, request music, start the engine voice, fire SFX — and
 *     all of it is simply remembered and applied the moment the context exists.
 *     `ready` reports the real `AudioContext.state`, never a hopeful boolean.
 *
 *  2. **The lookahead scheduler.** A 25ms timer walks the arrangement bar by
 *     bar and hands each note to the synth with an absolute
 *     `AudioContext.currentTime` value roughly 160ms in the future. Nothing is
 *     ever scheduled from `requestAnimationFrame` — frame jitter of even a few
 *     milliseconds is audible as a flam on a hi-hat.
 *
 *  3. **The `BeatClock`.** Derived from the hardware clock, latency-compensated
 *     so it reports what the player is *hearing* rather than what has been
 *     queued. Gameplay reads it every frame and it must not drift.
 */

import { clamp, clamp01, dampHalflife } from '../core/mathx';
import { MusicDirector, BEATS_PER_BAR, type NoteEvent } from './music';
import { SfxPlayer } from './sfx';
import { MusicSynth, ShipEngineVoice, createAudioGraph, type AudioGraph } from './synth';
import type {
  AudioMixSettings,
  BeatClock,
  EngineVoice,
  GameAudio,
  SfxName,
  SfxOptions,
} from './types';
import type { MusicProfile } from '../track/types';

/** How far ahead of the hardware clock notes are queued, in seconds. */
const LOOKAHEAD_SECONDS = 0.16;
/** How often the scheduler wakes up, in milliseconds. */
const SCHEDULER_INTERVAL_MS = 25;
/** Gap between `startMusic` and the downbeat, so bar 0 is never in the past. */
const MUSIC_LEAD_IN = 0.14;
/** Half-life of the smoothing applied to `setMusicIntensity`, in seconds. */
const INTENSITY_HALFLIFE = 0.45;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

const DEFAULT_MIX: AudioMixSettings = { master: 0.9, music: 0.7, sfx: 0.85 };

interface PendingMusic {
  profile: MusicProfile;
  seed: string;
}

export interface GameAudioOptions {
  /** Starting mix. Individual fields may be overridden later with `setMix`. */
  mix?: Partial<AudioMixSettings>;
}

export class WebAudioGameAudio implements GameAudio {
  private ctx: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private sfxPlayer: SfxPlayer | null = null;

  private director: MusicDirector | null = null;
  private synth: MusicSynth | null = null;
  /** The instrument being faded out during a track crossfade. */
  private retiring: { synth: MusicSynth; until: number } | null = null;

  private pendingMusic: PendingMusic | null = null;
  private profile: MusicProfile | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private playing = false;
  private musicStartTime = 0;
  private cursorBar = 0;
  private cursorEvents: NoteEvent[] | null = null;
  private cursorIndex = 0;

  private targetIntensity = 0.5;
  private smoothedIntensity = 0.5;

  private readonly mix: AudioMixSettings;
  private readonly shipEngine: ShipEngineVoice;
  private disposed = false;

  private readonly beat: BeatClock = {
    bpm: 120,
    running: false,
    beats: 0,
    beatIndex: 0,
    beatPhase: 0,
    barPhase: 0,
    barIndex: 0,
    timeToNextBeat: 0,
    beatDuration: 0.5,
  };
  private clockStamp = -1;

  constructor(options: GameAudioOptions = {}) {
    this.mix = { ...DEFAULT_MIX, ...options.mix };
    this.shipEngine = new ShipEngineVoice(() => this.graph);
  }

  /* -- lifecycle ----------------------------------------------------------- */

  get ready(): boolean {
    return !this.disposed && this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * Total time between a scheduled sample and the speaker, in seconds.
   *
   * Gameplay needs this: a beat gate's timing window has to be measured against
   * what the player heard, not against what the browser queued. The `BeatClock`
   * already has it applied — this is exposed for anything that wants to do its
   * own maths (input latency budgets, ghost replay alignment).
   */
  get outputLatency(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const base = typeof ctx.baseLatency === 'number' ? ctx.baseLatency : 0;
    const output = typeof ctx.outputLatency === 'number' ? ctx.outputLatency : 0;
    return base + output;
  }

  /** Must be called from inside a user gesture handler. */
  async unlock(): Promise<void> {
    if (this.disposed) return;
    if (!this.ctx) {
      const Ctor = audioContextCtor();
      if (!Ctor) return; // No WebAudio here (SSR, tests, ancient browser).
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.graph = createAudioGraph(this.ctx);
      this.applyMix();
      this.sfxPlayer = new SfxPlayer(this.graph);
      if (this.profile) this.sfxPlayer.setKey(this.profile.root, this.profile.scale);
      // An engine voice that was started before unlock builds itself now.
      this.shipEngine.resumeIfRequested();
    }
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* the gesture was not trusted; the caller can try again */
      }
    }
    const pending = this.pendingMusic;
    if (pending && this.ctx.state === 'running') {
      this.pendingMusic = null;
      this.startMusic(pending.profile, pending.seed);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopScheduler();
    this.playing = false;
    this.cursorEvents = null;
    this.director = null;
    this.pendingMusic = null;
    this.shipEngine.dispose();
    this.synth?.dispose();
    this.synth = null;
    this.retiring?.synth.dispose();
    this.retiring = null;
    this.sfxPlayer = null;
    this.graph?.dispose();
    this.graph = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
    this.resetClock();
  }

  /* -- mixing -------------------------------------------------------------- */

  setMix(mix: Partial<AudioMixSettings>): void {
    if (typeof mix.master === 'number') this.mix.master = clamp(mix.master, 0, 1.5);
    if (typeof mix.music === 'number') this.mix.music = clamp(mix.music, 0, 1.5);
    if (typeof mix.sfx === 'number') this.mix.sfx = clamp(mix.sfx, 0, 1.5);
    this.applyMix();
  }

  getMix(): AudioMixSettings {
    return { ...this.mix };
  }

  private applyMix(): void {
    const graph = this.graph;
    if (!graph) return;
    const t = graph.ctx.currentTime;
    // Short ramps rather than assignments: a slider drag must not zipper.
    graph.master.gain.setTargetAtTime(this.mix.master, t, 0.02);
    graph.music.gain.setTargetAtTime(this.mix.music, t, 0.02);
    graph.sfx.gain.setTargetAtTime(this.mix.sfx, t, 0.02);
  }

  /* -- music --------------------------------------------------------------- */

  /**
   * Start (or crossfade to) a generated arrangement.
   *
   * Safe to call before `unlock()` — the request is held and honoured as soon
   * as the context exists.
   */
  startMusic(profile: MusicProfile, seed: string): void {
    if (this.disposed) return;
    this.profile = profile;
    this.targetIntensity = clamp01(profile.intensity);
    this.smoothedIntensity = this.targetIntensity;

    const ctx = this.ctx;
    const graph = this.graph;
    if (!ctx || !graph || ctx.state !== 'running') {
      this.pendingMusic = { profile, seed };
      return;
    }

    this.sfxPlayer?.setKey(profile.root, profile.scale);

    // Retire whatever is currently playing under a short crossfade.
    if (this.synth) {
      const now = ctx.currentTime;
      this.retiring?.synth.dispose();
      this.synth.fadeTo(0, now, 0.9);
      this.retiring = { synth: this.synth, until: now + 1.0 };
    }

    const director = new MusicDirector(profile, seed);
    director.setIntensity(this.targetIntensity);
    const synth = new MusicSynth(graph, { secondsPerBeat: director.secondsPerBeat });
    synth.setTempo(director.secondsPerBeat);
    synth.setBrightness(director.effectiveIntensity(0));
    synth.output.gain.setValueAtTime(0, ctx.currentTime);
    synth.fadeTo(1, ctx.currentTime, 0.6);

    this.director = director;
    this.synth = synth;
    this.musicStartTime = ctx.currentTime + MUSIC_LEAD_IN;
    this.cursorBar = 0;
    this.cursorEvents = null;
    this.cursorIndex = 0;
    this.playing = true;
    this.clockStamp = -1;
    this.startScheduler();
  }

  stopMusic(fadeSeconds = 1): void {
    this.pendingMusic = null;
    const ctx = this.ctx;
    const synth = this.synth;
    this.playing = false;
    this.cursorEvents = null;
    this.director = null;
    this.resetClock();
    if (!ctx || !synth) {
      synth?.dispose();
      this.synth = null;
      return;
    }
    this.stopScheduler();
    const fade = Math.max(0, fadeSeconds);
    const now = ctx.currentTime;
    synth.fadeTo(0, now, fade);
    // Let scheduled tails ring through the fade, then cut hard.
    synth.stopAll(now + fade + 0.05);
    const dying = synth;
    this.synth = null;
    setTimeout(
      () => {
        dying.dispose();
      },
      (fade + 0.2) * 1000,
    );
  }

  /** 0..1 arrangement density. Smoothed, then latched on the next bar line. */
  setMusicIntensity(v: number): void {
    this.targetIntensity = clamp01(v);
  }

  /** Ducks music briefly, e.g. under a big impact. */
  duck(amount: number, seconds: number): void {
    const graph = this.graph;
    if (!graph) return;
    const depth = clamp01(1 - clamp01(amount));
    const hold = Math.max(0.02, seconds);
    const g = graph.musicDuck.gain;
    const now = graph.ctx.currentTime;
    const current = g.value;
    g.cancelScheduledValues(now);
    g.setValueAtTime(current, now);
    g.linearRampToValueAtTime(Math.min(current, depth), now + 0.015);
    g.linearRampToValueAtTime(1, now + 0.015 + hold);
  }

  /* -- clock --------------------------------------------------------------- */

  get clock(): BeatClock {
    this.refreshClock();
    return this.beat;
  }

  private resetClock(): void {
    this.beat.running = false;
    this.beat.beats = 0;
    this.beat.beatIndex = 0;
    this.beat.beatPhase = 0;
    this.beat.barPhase = 0;
    this.beat.barIndex = 0;
    this.beat.timeToNextBeat = 0;
    this.clockStamp = -1;
  }

  /**
   * Recompute from `AudioContext.currentTime`, never from frame deltas.
   *
   * `currentTime` only advances once per render quantum, so the result is
   * naturally stable within a frame; the stamp check just avoids redoing the
   * arithmetic when gameplay reads `clock` several times in the same frame.
   */
  private refreshClock(): void {
    const ctx = this.ctx;
    const director = this.director;
    if (director) {
      this.beat.bpm = director.bpm;
      this.beat.beatDuration = director.secondsPerBeat;
    }
    if (!ctx || !director || !this.playing || ctx.state !== 'running') {
      if (this.beat.running) this.resetClock();
      return;
    }
    const stamp = ctx.currentTime;
    if (stamp === this.clockStamp) return;
    this.clockStamp = stamp;

    const spb = director.secondsPerBeat;
    // What the speaker is playing right now, not what has been queued.
    const elapsed = stamp - this.outputLatency - this.musicStartTime;
    if (elapsed < 0) {
      this.beat.running = false;
      this.beat.beats = 0;
      this.beat.beatIndex = 0;
      this.beat.beatPhase = 0;
      this.beat.barPhase = 0;
      this.beat.barIndex = 0;
      this.beat.timeToNextBeat = -elapsed;
      return;
    }
    const beats = elapsed / spb;
    const beatIndex = Math.floor(beats);
    const bars = beats / BEATS_PER_BAR;
    this.beat.running = true;
    this.beat.beats = beats;
    this.beat.beatIndex = beatIndex;
    this.beat.beatPhase = beats - beatIndex;
    this.beat.barIndex = Math.floor(bars);
    this.beat.barPhase = bars - Math.floor(bars);
    this.beat.timeToNextBeat = (1 - this.beat.beatPhase) * spb;
  }

  /* -- sfx and engine ------------------------------------------------------ */

  get engine(): EngineVoice {
    return this.shipEngine;
  }

  play(name: SfxName, options?: SfxOptions): void {
    if (!this.ready) return;
    this.sfxPlayer?.play(name, options);
  }

  /* -- per-frame ----------------------------------------------------------- */

  /**
   * Called once per frame. Does *not* schedule audio — that is the interval
   * timer's job. This only smooths the intensity signal, retires finished
   * crossfades, and refreshes the clock so `clock` is current for this frame.
   */
  update(dt: number): void {
    if (this.disposed) return;
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
    this.smoothedIntensity = dampHalflife(
      this.smoothedIntensity,
      this.targetIntensity,
      INTENSITY_HALFLIFE,
      step,
    );
    this.director?.setIntensity(this.smoothedIntensity);

    const ctx = this.ctx;
    if (ctx && this.retiring && ctx.currentTime >= this.retiring.until) {
      this.retiring.synth.dispose();
      this.retiring = null;
    }
    this.refreshClock();
  }

  /* -- scheduler ----------------------------------------------------------- */

  private startScheduler(): void {
    if (this.timer !== null || this.disposed) return;
    this.timer = setInterval(() => this.tick(), SCHEDULER_INTERVAL_MS);
  }

  private stopScheduler(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private barStartTime(bar: number): number {
    const spb = this.director ? this.director.secondsPerBeat : 0.5;
    return this.musicStartTime + bar * BEATS_PER_BAR * spb;
  }

  /**
   * Queue everything that falls inside the lookahead window.
   *
   * Bars are materialised one at a time and only when the window reaches them,
   * which is what keeps `MusicDirector.eventsForBar` — and therefore the
   * intensity latch — running exactly once per bar, on the bar line.
   */
  private tick(): void {
    const ctx = this.ctx;
    const director = this.director;
    const synth = this.synth;
    if (!ctx || !director || !synth || !this.playing) return;
    if (ctx.state !== 'running') return;

    const spb = director.secondsPerBeat;
    const now = ctx.currentTime;
    const horizon = now + LOOKAHEAD_SECONDS;

    // If the tab was backgrounded the timer may have been throttled for
    // seconds. Skip forward rather than dumping a burst of stale notes.
    const behind = now - this.barStartTime(this.cursorBar);
    const barSeconds = BEATS_PER_BAR * spb;
    if (behind > barSeconds * 2) {
      this.cursorBar += Math.floor(behind / barSeconds);
      this.cursorEvents = null;
      this.cursorIndex = 0;
    }

    for (let guard = 0; guard < 64; guard++) {
      if (this.barStartTime(this.cursorBar) >= horizon) break;
      if (!this.cursorEvents) {
        // Latches the requested intensity — arrangement changes land here, on
        // a bar line, never mid-bar.
        this.cursorEvents = director.eventsForBar(this.cursorBar);
        this.cursorIndex = 0;
        synth.setBrightness(director.effectiveIntensity(this.cursorBar));
      }
      let exhausted = true;
      while (this.cursorIndex < this.cursorEvents.length) {
        const event = this.cursorEvents[this.cursorIndex];
        const at = this.barStartTime(this.cursorBar) + event.time * spb;
        if (at >= horizon) {
          exhausted = false;
          break;
        }
        // A note whose moment has already passed is dropped, not crammed in
        // late — a flam is more noticeable than a missing hi-hat.
        if (at >= now - 0.02) synth.play(event, Math.max(at, now));
        this.cursorIndex++;
      }
      if (!exhausted) break;
      this.cursorBar++;
      this.cursorEvents = null;
      this.cursorIndex = 0;
    }
  }
}

/** Construct the game's audio. Nothing is allocated until `unlock()`. */
export function createGameAudio(options?: GameAudioOptions): GameAudio {
  return new WebAudioGameAudio(options);
}
