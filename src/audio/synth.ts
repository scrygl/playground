/**
 * WebAudio voice construction.
 *
 * Everything the game can hear is built here out of oscillators, noise buffers
 * we fill ourselves, filters, waveshapers and a convolution reverb whose
 * impulse response is generated procedurally. There is not a single audio asset
 * in the project.
 *
 * Nothing in this module touches a global — no `new AudioContext()` at import
 * time, no `window` lookups. Every entry point takes the context (or the graph)
 * it should build into, so `engine.ts` can stay lazy until `unlock()` and so
 * this file can be imported in Node without exploding. (It is still never
 * imported by the pure test path; `music.ts` and `theory.ts` know nothing about
 * this file, only the other way round.)
 */

import { clamp, clamp01, lerp } from '../core/mathx';
import { Rng } from '../core/rng';
import type { NoteEvent } from './music';
import { DRUM } from './music';
import { midiToFreq } from './theory';
import type { EngineVoice } from './types';

/** Smallest value an exponential ramp may target; zero is illegal. */
export const EPS = 1e-4;

/* -------------------------------------------------------------------------- */
/* Procedural sources                                                         */
/* -------------------------------------------------------------------------- */

/** Deterministic white noise. Two channels, decorrelated, so it images wide. */
export function createNoiseBuffer(ctx: BaseAudioContext, seconds = 2, seed = 'noise'): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const rng = new Rng(seed);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = rng.next() * 2 - 1;
  }
  return buffer;
}

export interface ImpulseOptions {
  /** Tail length in seconds. */
  seconds?: number;
  /** Higher decays faster. 2 is a big hall, 5 is a small room. */
  decay?: number;
  /** Gap before the tail starts, in seconds. */
  preDelay?: number;
  /** 0 = bright and glassy, 1 = dark and distant. */
  damping?: number;
  seed?: string;
}

/**
 * A convolution reverb impulse response, synthesised.
 *
 * Exponentially decaying noise gives the diffuse tail; a handful of discrete
 * early reflections in the first 60ms give it a sense of a room rather than a
 * wash. A one-pole lowpass run over the whole buffer is the damping — real
 * rooms lose high frequencies faster than lows, and without it the tail sounds
 * like a hiss instead of a space.
 */
export function createImpulseResponse(ctx: BaseAudioContext, options: ImpulseOptions = {}): AudioBuffer {
  const seconds = options.seconds ?? 2.6;
  const decay = options.decay ?? 2.6;
  const preDelay = options.preDelay ?? 0.012;
  const damping = clamp01(options.damping ?? 0.55);
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(2, length, rate);
  const rng = new Rng(options.seed ?? 'impulse');
  const preDelaySamples = Math.floor(preDelay * rate);
  // One-pole coefficient: more damping means a lower corner frequency.
  const coeff = lerp(0.65, 0.12, damping);

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = preDelaySamples; i < length; i++) {
      const t = (i - preDelaySamples) / (length - preDelaySamples);
      const envelope = Math.pow(1 - t, decay);
      lp += coeff * ((rng.next() * 2 - 1) - lp);
      data[i] = lp * envelope;
    }
    // Early reflections — a few sparse taps before the tail settles in.
    for (let r = 0; r < 7; r++) {
      const at = preDelaySamples + Math.floor(rng.range(0.004, 0.06) * rate);
      if (at < length) data[at] += rng.range(-0.7, 0.7) * Math.pow(0.72, r);
    }
    // Normalise so swapping IR settings never changes the send level.
    let peak = 0;
    for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(data[i]));
    if (peak > 0) {
      const gain = 0.85 / peak;
      for (let i = 0; i < length; i++) data[i] *= gain;
    }
  }
  return buffer;
}

/** Odd-symmetric soft saturation. `amount` 0 is nearly clean, 1 is aggressive. */
export function createDriveCurve(amount: number, size = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size);
  const k = 1 + amount * 28;
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k) / Math.tanh(k);
  }
  return curve;
}

/** A hard-ish brick wall used as the very last stage before the destination. */
export function createLimiterCurve(size = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    // Linear below ~0.7, tanh above; inaudible until something actually peaks.
    curve[i] = Math.abs(x) < 0.7 ? x : Math.sign(x) * (0.7 + 0.3 * Math.tanh((Math.abs(x) - 0.7) / 0.3));
  }
  return curve;
}

/* -------------------------------------------------------------------------- */
/* The mix graph                                                              */
/* -------------------------------------------------------------------------- */

export interface AudioGraph {
  ctx: AudioContext;
  /** Post-limiter output level; `AudioMixSettings.master`. */
  master: GainNode;
  /** Music bus level; `AudioMixSettings.music`. */
  music: GainNode;
  /** Automated by `duck()`. Separate from `music` so the two never fight. */
  musicDuck: GainNode;
  /** Kick-triggered sidechain pump — the reason techno breathes. */
  musicPump: GainNode;
  /** Everything music voices connect to. */
  musicIn: GainNode;
  /** SFX bus level; `AudioMixSettings.sfx`. Also carries the engine. */
  sfx: GainNode;
  /** Send bus into the shared reverb. */
  reverbIn: GainNode;
  /** Send bus into the shared tempo-synced delay. */
  delayIn: GainNode;
  delay: DelayNode;
  delayFeedback: GainNode;
  noise: AudioBuffer;
  /** Retune the delay to the current tempo. */
  setDelayTime(seconds: number): void;
  dispose(): void;
}

/**
 * Build the whole mix graph.
 *
 * ```
 *   music voices ─▶ musicIn ─▶ musicPump ─▶ musicDuck ─▶ music ─┐
 *   sfx + engine ─▶ sfx ─────────────────────────────────────────┼─▶ comp ─▶ clip ─▶ master ─▶ out
 *   sends ─▶ reverb / delay ─▶ returns ───────────────────────────┘
 * ```
 *
 * Gain staging: every voice is written to peak well under 1, the buses sit at
 * unity, and the compressor plus the soft-clip curve after it mean the output
 * physically cannot clip no matter how many voices land on the same sample.
 */
export function createAudioGraph(ctx: AudioContext): AudioGraph {
  const master = ctx.createGain();
  master.gain.value = 0.9;

  const clipper = ctx.createWaveShaper();
  clipper.curve = createLimiterCurve();
  clipper.oversample = '2x';

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -10;
  compressor.knee.value = 8;
  compressor.ratio.value = 12;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.22;

  compressor.connect(clipper);
  clipper.connect(master);
  master.connect(ctx.destination);

  const music = ctx.createGain();
  const musicDuck = ctx.createGain();
  const musicPump = ctx.createGain();
  const musicIn = ctx.createGain();
  musicIn.connect(musicPump);
  musicPump.connect(musicDuck);
  musicDuck.connect(music);
  music.connect(compressor);

  const sfx = ctx.createGain();
  sfx.connect(compressor);

  // --- Shared reverb -------------------------------------------------------
  const reverbIn = ctx.createGain();
  reverbIn.gain.value = 1;
  const reverbHigh = ctx.createBiquadFilter();
  reverbHigh.type = 'highpass';
  reverbHigh.frequency.value = 260; // keep the sub out of the tail
  const reverbLow = ctx.createBiquadFilter();
  reverbLow.type = 'lowpass';
  reverbLow.frequency.value = 6200;
  const convolver = ctx.createConvolver();
  convolver.normalize = false;
  convolver.buffer = createImpulseResponse(ctx, {
    seconds: 2.8,
    decay: 2.7,
    damping: 0.6,
    seed: 'velocity-horizon-hall',
  });
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = 0.5;
  reverbIn.connect(reverbHigh);
  reverbHigh.connect(reverbLow);
  reverbLow.connect(convolver);
  convolver.connect(reverbReturn);
  reverbReturn.connect(compressor);

  // --- Shared delay --------------------------------------------------------
  const delayIn = ctx.createGain();
  const delay = ctx.createDelay(2);
  delay.delayTime.value = 0.28;
  const delayFeedback = ctx.createGain();
  delayFeedback.gain.value = 0.36;
  const delayTone = ctx.createBiquadFilter();
  delayTone.type = 'bandpass';
  delayTone.frequency.value = 1600;
  delayTone.Q.value = 0.6;
  const delayReturn = ctx.createGain();
  delayReturn.gain.value = 0.45;
  delayIn.connect(delay);
  delay.connect(delayTone);
  delayTone.connect(delayFeedback);
  delayFeedback.connect(delay);
  delayTone.connect(delayReturn);
  // A little of the delay into the reverb glues the two together.
  delayReturn.connect(reverbIn);
  delayReturn.connect(compressor);

  const noise = createNoiseBuffer(ctx, 2.5, 'velocity-horizon-noise');

  let disposed = false;
  return {
    ctx,
    master,
    music,
    musicDuck,
    musicPump,
    musicIn,
    sfx,
    reverbIn,
    delayIn,
    delay,
    delayFeedback,
    noise,
    setDelayTime(seconds: number): void {
      const t = ctx.currentTime;
      delay.delayTime.setTargetAtTime(clamp(seconds, 0.02, 1.9), t, 0.05);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const node of [
        master,
        clipper,
        compressor,
        music,
        musicDuck,
        musicPump,
        musicIn,
        sfx,
        reverbIn,
        reverbHigh,
        reverbLow,
        convolver,
        reverbReturn,
        delayIn,
        delay,
        delayFeedback,
        delayTone,
        delayReturn,
      ]) {
        try {
          node.disconnect();
        } catch {
          /* already torn down */
        }
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Envelope + node helpers                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Percussive envelope: instant-ish attack, exponential decay to silence.
 * Returns the time the voice may be stopped.
 */
export function decayEnvelope(
  param: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  decay: number,
): number {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(EPS, t0);
  param.linearRampToValueAtTime(Math.max(EPS, peak), t0 + attack);
  param.exponentialRampToValueAtTime(EPS, t0 + attack + decay);
  return t0 + attack + decay + 0.01;
}

/**
 * Sustained envelope for pitched voices. `hold` is the note length in seconds;
 * the release runs past it, which is why voices are allowed to overlap.
 */
export function sustainEnvelope(
  param: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  decay: number,
  sustain: number,
  hold: number,
  release: number,
): number {
  const level = Math.max(EPS, peak * sustain);
  const off = t0 + Math.max(hold, attack + 0.005);
  param.cancelScheduledValues(t0);
  param.setValueAtTime(EPS, t0);
  param.linearRampToValueAtTime(Math.max(EPS, peak), t0 + attack);
  param.exponentialRampToValueAtTime(level, t0 + attack + Math.max(0.005, decay));
  param.setValueAtTime(level, off);
  param.exponentialRampToValueAtTime(EPS, off + release);
  return off + release + 0.01;
}

/** A one-shot slice of the shared noise buffer, started at a random offset. */
export function noiseSource(graph: AudioGraph, time: number, duration: number, rate = 1): AudioBufferSourceNode {
  const src = graph.ctx.createBufferSource();
  src.buffer = graph.noise;
  src.playbackRate.value = rate;
  src.loop = true;
  // Offsetting keeps repeated hits from sounding like the identical sample.
  const offset = (time * 7.13) % Math.max(0.001, graph.noise.duration - 0.5);
  src.start(time, offset);
  src.stop(time + duration);
  return src;
}

/** Small wrapper so voice code reads as a signal chain, not node plumbing. */
export function biquad(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  frequency: number,
  q = 1,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = clamp(frequency, 20, ctx.sampleRate * 0.48);
  f.Q.value = q;
  return f;
}

export function gainNode(ctx: BaseAudioContext, value = 0): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

/** Disconnect a chain once its longest source has finished, so nothing leaks. */
export function reap(source: AudioScheduledSourceNode, ...nodes: AudioNode[]): void {
  source.onended = (): void => {
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        /* already gone */
      }
    }
  };
}

/* -------------------------------------------------------------------------- */
/* The music instrument                                                       */
/* -------------------------------------------------------------------------- */

export interface MusicSynthOptions {
  /** Seconds per beat, used to convert note durations and set the delay time. */
  secondsPerBeat: number;
}

/**
 * Renders `NoteEvent`s from `music.ts` into sound.
 *
 * Every method takes an absolute `AudioContext.currentTime` value — the
 * scheduler in `engine.ts` computes those from the beat grid, so nothing here
 * ever reads the clock itself and nothing is scheduled "now".
 */
export class MusicSynth {
  private readonly graph: AudioGraph;
  private secondsPerBeat: number;
  /** Sources currently scheduled, so `stopAll` can cut a fade short. */
  private readonly live = new Set<AudioScheduledSourceNode>();
  /** Master brightness, 0..1, driven from arrangement intensity. */
  private brightness = 0.6;
  /**
   * Every voice lands here rather than on the music bus directly, so two
   * instruments can exist at once and `startMusic` can crossfade between
   * arrangements instead of cutting.
   */
  readonly output: GainNode;

  constructor(graph: AudioGraph, options: MusicSynthOptions) {
    this.graph = graph;
    this.secondsPerBeat = options.secondsPerBeat;
    this.output = gainNode(graph.ctx, 1);
    this.output.connect(graph.musicIn);
  }

  /** Linear fade of this instrument's output. Used for track crossfades. */
  fadeTo(value: number, at: number, seconds: number): void {
    const g = this.output.gain;
    const t = Math.max(at, this.graph.ctx.currentTime);
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(clamp01(value), t + Math.max(0.001, seconds));
  }

  /** Stop everything and unhook from the bus. */
  dispose(): void {
    this.stopAll();
    try {
      this.output.disconnect();
    } catch {
      /* already gone */
    }
  }

  setTempo(secondsPerBeat: number): void {
    this.secondsPerBeat = secondsPerBeat;
    // Dotted eighth — the synthwave delay. Always in time with the arrangement.
    this.graph.setDelayTime(secondsPerBeat * 0.75);
  }

  /**
   * Opens the filters up as the arrangement gets busier. This is what makes low
   * intensity read as "filtered and atmospheric" without changing a single note.
   */
  setBrightness(v: number): void {
    this.brightness = clamp01(v);
  }

  /** Schedule one event. `time` is absolute context time. */
  play(event: NoteEvent, time: number): void {
    const duration = Math.max(0.03, event.duration * this.secondsPerBeat);
    const velocity = clamp01(event.velocity);
    switch (event.voice) {
      case 'kick':
        this.kick(time, event.midi, velocity);
        break;
      case 'sub':
        this.sub(time, event.midi, duration, velocity);
        break;
      case 'bass':
        this.bass(time, event.midi, duration, velocity);
        break;
      case 'arp':
        this.arp(time, event.midi, duration, velocity);
        break;
      case 'pad':
        this.pad(time, event.midi, duration, velocity);
        break;
      case 'lead':
        this.lead(time, event.midi, duration, velocity);
        break;
      case 'hat':
        this.hat(time, event.midi, duration, velocity);
        break;
      case 'snare':
        this.percussion(time, event.midi, duration, velocity);
        break;
      case 'riser':
        this.riser(time, event.midi, duration, velocity);
        break;
    }
  }

  /** Kill everything still sounding. Used by `stopMusic` and `dispose`. */
  stopAll(when?: number): void {
    const t = when ?? this.graph.ctx.currentTime;
    for (const source of this.live) {
      try {
        source.stop(t);
      } catch {
        /* already stopped */
      }
    }
    this.live.clear();
  }

  private track(source: AudioScheduledSourceNode): void {
    this.live.add(source);
    const previous = source.onended;
    source.onended = (event): void => {
      this.live.delete(source);
      if (typeof previous === 'function') previous.call(source, event);
    };
  }

  /* -- individual voices --------------------------------------------------- */

  /** Pitch-swept sine with a noise click on top, driven into soft saturation. */
  private kick(time: number, midi: number, velocity: number): void {
    const ctx = this.graph.ctx;
    const base = midiToFreq(midi);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(base * 7.5, time);
    osc.frequency.exponentialRampToValueAtTime(base * 1.8, time + 0.028);
    osc.frequency.exponentialRampToValueAtTime(base, time + 0.09);

    const vca = gainNode(ctx);
    const end = decayEnvelope(vca.gain, time, 0.95 * velocity, 0.003, 0.34);

    const drive = ctx.createWaveShaper();
    drive.curve = createDriveCurve(0.35);
    const trim = gainNode(ctx, 0.8);

    osc.connect(vca);
    vca.connect(drive);
    drive.connect(trim);
    trim.connect(this.output);

    // Click transient: a very short band of noise gives the beater its edge.
    const click = noiseSource(this.graph, time, 0.02);
    const clickFilter = biquad(ctx, 'bandpass', 2400, 0.9);
    const clickVca = gainNode(ctx);
    decayEnvelope(clickVca.gain, time, 0.22 * velocity, 0.001, 0.014);
    click.connect(clickFilter);
    clickFilter.connect(clickVca);
    clickVca.connect(this.output);

    osc.start(time);
    osc.stop(end);
    this.track(osc);
    this.track(click);
    reap(osc, osc, vca, drive, trim);
    reap(click, click, clickFilter, clickVca);

    this.pump(time, velocity);
  }

  /**
   * Sidechain. A short dip on every kick, so the bass and pads duck out of the
   * way of the low end instead of fighting it. This is most of why the genre
   * sounds like it breathes.
   */
  private pump(time: number, velocity: number): void {
    const g = this.graph.musicPump.gain;
    const depth = lerp(0.55, 0.34, 1 - velocity);
    g.cancelScheduledValues(time);
    g.setValueAtTime(1, time);
    g.linearRampToValueAtTime(depth, time + 0.012);
    g.setTargetAtTime(1, time + 0.014, 0.055);
  }

  /** Near-pure sine an octave or two down, gently saturated for presence. */
  private sub(time: number, midi: number, duration: number, velocity: number): void {
    const ctx = this.graph.ctx;
    const freq = midiToFreq(midi);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const harmonic = ctx.createOscillator();
    harmonic.type = 'triangle';
    harmonic.frequency.value = freq * 2;
    const harmonicGain = gainNode(ctx, 0.14);

    const lp = biquad(ctx, 'lowpass', 220, 0.8);
    const vca = gainNode(ctx);
    const end = sustainEnvelope(vca.gain, time, 0.5 * velocity, 0.012, 0.05, 0.85, duration, 0.07);

    osc.connect(lp);
    harmonic.connect(harmonicGain);
    harmonicGain.connect(lp);
    lp.connect(vca);
    vca.connect(this.output);

    osc.start(time);
    harmonic.start(time);
    osc.stop(end);
    harmonic.stop(end);
    this.track(osc);
    this.track(harmonic);
    reap(osc, osc, harmonic, harmonicGain, lp, vca);
  }

  /** Two detuned saws plus a square octave-down, through a resonant sweep. */
  private bass(time: number, midi: number, duration: number, velocity: number): void {
    const ctx = this.graph.ctx;
    const freq = midiToFreq(midi);
    const mix = gainNode(ctx, 1);

    for (const detune of [-9, 9]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(mix);
      osc.start(time);
      osc.stop(time + duration + 0.12);
      this.track(osc);
    }
    const square = ctx.createOscillator();
    square.type = 'square';
    square.frequency.value = freq * 0.5;
    const squareGain = gainNode(ctx, 0.5);
    square.connect(squareGain);
    squareGain.connect(mix);
    square.start(time);
    square.stop(time + duration + 0.12);
    this.track(square);

    const filter = biquad(ctx, 'lowpass', freq * 3, 7);
    const open = clamp(freq * lerp(4, 11, this.brightness), 220, 5200);
    filter.frequency.setValueAtTime(open, time);
    filter.frequency.exponentialRampToValueAtTime(clamp(freq * 2.1, 120, 3000), time + 0.11);

    const drive = ctx.createWaveShaper();
    drive.curve = createDriveCurve(0.22);
    const vca = gainNode(ctx);
    const end = sustainEnvelope(vca.gain, time, 0.3 * velocity, 0.006, 0.06, 0.7, duration, 0.06);

    mix.connect(filter);
    filter.connect(drive);
    drive.connect(vca);
    vca.connect(this.output);

    const send = gainNode(ctx, 0.04);
    vca.connect(send);
    send.connect(this.graph.delayIn);

    square.onended = (): void => {
      for (const n of [mix, filter, drive, vca, send, squareGain]) {
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
    };
    void end;
  }

  /** Bright plucked square — short, filtered, and sent hard to the delay. */
  private arp(time: number, midi: number, duration: number, velocity: number): void {
    const ctx = this.graph.ctx;
    const freq = midiToFreq(midi);
    const mix = gainNode(ctx, 1);

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    osc.connect(mix);
    const shimmer = ctx.createOscillator();
    shimmer.type = 'sawtooth';
    shimmer.frequency.value = freq;
    shimmer.detune.value = 7;
    const shimmerGain = gainNode(ctx, 0.35);
    shimmer.connect(shimmerGain);
    shimmerGain.connect(mix);

    const filter = biquad(ctx, 'lowpass', freq * 4, 9);
    filter.frequency.setValueAtTime(clamp(freq * lerp(3, 9, this.brightness), 400, 9000), time);
    filter.frequency.exponentialRampToValueAtTime(clamp(freq * 1.6, 200, 4000), time + 0.14);

    const vca = gainNode(ctx);
    const end = decayEnvelope(vca.gain, time, 0.16 * velocity, 0.004, Math.max(0.09, duration));

    mix.connect(filter);
    filter.connect(vca);
    vca.connect(this.output);

    const delaySend = gainNode(ctx, 0.28);
    const verbSend = gainNode(ctx, 0.16);
    vca.connect(delaySend);
    delaySend.connect(this.graph.delayIn);
    vca.connect(verbSend);
    verbSend.connect(this.graph.reverbIn);

    osc.start(time);
    shimmer.start(time);
    osc.stop(end);
    shimmer.stop(end);
    this.track(osc);
    this.track(shimmer);
    reap(osc, osc, shimmer, shimmerGain, mix, filter, vca, delaySend, verbSend);
  }

  /** Warm supersaw pad: five detuned saws, slow attack, heavy reverb. */
  private pad(time: number, midi: number, duration: number, velocity: number): void {
    const ctx = this.graph.ctx;
    const freq = midiToFreq(midi);
    const mix = gainNode(ctx, 1);
    const detunes = [-14, -7, 0, 7, 14];
    const end = time + duration + 1.6;

    for (const detune of detunes) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = gainNode(ctx, detune === 0 ? 0.34 : 0.2);
      osc.connect(g);
      g.connect(mix);
      osc.start(time);
      osc.stop(end);
      this.track(osc);
      reap(osc, osc, g);
    }

    const filter = biquad(ctx, 'lowpass', lerp(700, 2600, this.brightness), 0.9);
    // Slow opening over the note gives the pad movement without an LFO.
    filter.frequency.setValueAtTime(lerp(450, 1400, this.brightness), time);
    filter.frequency.linearRampToValueAtTime(lerp(900, 3200, this.brightness), time + duration * 0.7);

    const hp = biquad(ctx, 'highpass', 180, 0.7);
    const vca = gainNode(ctx);
    sustainEnvelope(vca.gain, time, 0.14 * velocity, Math.min(0.9, duration * 0.35), 0.4, 0.75, duration, 1.2);

    mix.connect(filter);
    filter.connect(hp);
    hp.connect(vca);
    vca.connect(this.output);

    const verbSend = gainNode(ctx, 0.5);
    vca.connect(verbSend);
    verbSend.connect(this.graph.reverbIn);
  }

  /** Three saws and an FM sparkle — cuts through a full arrangement. */
  private lead(time: number, midi: number, duration: number, velocity: number): void {
    const ctx = this.graph.ctx;
    const freq = midiToFreq(midi);
    const mix = gainNode(ctx, 1);
    const end = time + duration + 0.5;

    for (const detune of [-11, 0, 11]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = gainNode(ctx, detune === 0 ? 0.4 : 0.24);
      osc.connect(g);
      g.connect(mix);
      osc.start(time);
      osc.stop(end);
      this.track(osc);
      reap(osc, osc, g);
    }

    // FM partial: a fast-decaying modulator gives the attack a metallic ping.
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = freq * 2;
    const modulator = ctx.createOscillator();
    modulator.type = 'sine';
    modulator.frequency.value = freq * 3.5;
    const index = gainNode(ctx, 0);
    decayEnvelope(index.gain, time, freq * 2.4, 0.002, 0.14);
    modulator.connect(index);
    index.connect(carrier.frequency);
    const bellGain = gainNode(ctx, 0.12);
    carrier.connect(bellGain);
    bellGain.connect(mix);
    carrier.start(time);
    modulator.start(time);
    carrier.stop(end);
    modulator.stop(end);
    this.track(carrier);
    this.track(modulator);

    const filter = biquad(ctx, 'lowpass', clamp(freq * 6, 900, 8000), 3);
    const vca = gainNode(ctx);
    sustainEnvelope(vca.gain, time, 0.15 * velocity, 0.01, 0.09, 0.72, duration, 0.28);

    mix.connect(filter);
    filter.connect(vca);
    vca.connect(this.output);

    const delaySend = gainNode(ctx, 0.3);
    const verbSend = gainNode(ctx, 0.22);
    vca.connect(delaySend);
    delaySend.connect(this.graph.delayIn);
    vca.connect(verbSend);
    verbSend.connect(this.graph.reverbIn);

    reap(carrier, carrier, modulator, index, bellGain, mix, filter, vca, delaySend, verbSend);
  }

  /** Bandpassed noise. Closed hats are a tick, open hats ring into the beat. */
  private hat(time: number, midi: number, duration: number, velocity: number): void {
    const ctx = this.graph.ctx;
    const open = midi >= DRUM.openHat;
    const decay = open ? Math.max(0.16, duration * 0.9) : 0.035;
    const src = noiseSource(this.graph, time, decay + 0.05);
    const band = biquad(ctx, 'bandpass', open ? 7600 : 9200, open ? 1.1 : 1.8);
    const hp = biquad(ctx, 'highpass', 6000, 0.7);
    const vca = gainNode(ctx);
    decayEnvelope(vca.gain, time, 0.13 * velocity, 0.001, decay);

    src.connect(band);
    band.connect(hp);
    hp.connect(vca);
    vca.connect(this.output);
    if (open) {
      const verbSend = gainNode(ctx, 0.1);
      vca.connect(verbSend);
      verbSend.connect(this.graph.reverbIn);
      reap(src, src, band, hp, vca, verbSend);
    } else {
      reap(src, src, band, hp, vca);
    }
    this.track(src);
  }

  /** Snare, clap and crash all live on the same voice, selected by MIDI note. */
  private percussion(time: number, midi: number, duration: number, velocity: number): void {
    if (midi >= DRUM.crash) this.crash(time, velocity);
    else if (midi >= DRUM.clap) this.clap(time, velocity);
    else this.snare(time, velocity);
    void duration;
  }

  private snare(time: number, velocity: number): void {
    const ctx = this.graph.ctx;
    const src = noiseSource(this.graph, time, 0.24);
    const band = biquad(ctx, 'bandpass', 1900, 1.1);
    const vca = gainNode(ctx);
    decayEnvelope(vca.gain, time, 0.22 * velocity, 0.002, 0.15);
    src.connect(band);
    band.connect(vca);
    vca.connect(this.output);

    // Tuned body under the noise, or it sounds like a hiss rather than a drum.
    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(320, time);
    body.frequency.exponentialRampToValueAtTime(170, time + 0.07);
    const bodyVca = gainNode(ctx);
    const end = decayEnvelope(bodyVca.gain, time, 0.14 * velocity, 0.002, 0.1);
    body.connect(bodyVca);
    bodyVca.connect(this.output);
    body.start(time);
    body.stop(end);

    const verbSend = gainNode(ctx, 0.22);
    vca.connect(verbSend);
    verbSend.connect(this.graph.reverbIn);

    this.track(src);
    this.track(body);
    reap(src, src, band, vca, verbSend);
    reap(body, body, bodyVca);
  }

  private clap(time: number, velocity: number): void {
    const ctx = this.graph.ctx;
    const band = biquad(ctx, 'bandpass', 1500, 1.4);
    const out = gainNode(ctx, 1);
    band.connect(out);
    out.connect(this.output);
    const verbSend = gainNode(ctx, 0.34);
    out.connect(verbSend);
    verbSend.connect(this.graph.reverbIn);

    // Three fast slaps then a short body — that stack is what makes a clap.
    let last: AudioBufferSourceNode | null = null;
    for (const [offset, level, decay] of [
      [0, 1, 0.014],
      [0.011, 0.8, 0.014],
      [0.022, 0.65, 0.02],
      [0.034, 0.55, 0.13],
    ] as const) {
      const src = noiseSource(this.graph, time + offset, decay + 0.04);
      const vca = gainNode(ctx);
      decayEnvelope(vca.gain, time + offset, 0.26 * velocity * level, 0.001, decay);
      src.connect(vca);
      vca.connect(band);
      this.track(src);
      reap(src, src, vca);
      last = src;
    }
    if (last) {
      const previous = last.onended;
      last.onended = (event): void => {
        if (typeof previous === 'function') previous.call(last as AudioBufferSourceNode, event);
        for (const n of [band, out, verbSend]) {
          try {
            n.disconnect();
          } catch {
            /* already gone */
          }
        }
      };
    }
  }

  private crash(time: number, velocity: number): void {
    const ctx = this.graph.ctx;
    const src = noiseSource(this.graph, time, 2.2);
    const hp = biquad(ctx, 'highpass', 4200, 0.7);
    const band = biquad(ctx, 'bandpass', 8200, 0.5);
    const vca = gainNode(ctx);
    decayEnvelope(vca.gain, time, 0.11 * velocity, 0.004, 1.9);
    src.connect(hp);
    hp.connect(band);
    band.connect(vca);
    vca.connect(this.output);
    const verbSend = gainNode(ctx, 0.5);
    vca.connect(verbSend);
    verbSend.connect(this.graph.reverbIn);
    this.track(src);
    reap(src, src, hp, band, vca, verbSend);
  }

  /** Noise and a saw sweeping upward together — the classic pre-drop lift. */
  private riser(time: number, midi: number, duration: number, velocity: number): void {
    const ctx = this.graph.ctx;
    const freq = midiToFreq(midi);
    const end = time + duration;

    const src = noiseSource(this.graph, time, duration + 0.2);
    const band = biquad(ctx, 'bandpass', 400, 5);
    band.frequency.setValueAtTime(360, time);
    band.frequency.exponentialRampToValueAtTime(7200, end);
    const noiseVca = gainNode(ctx);
    noiseVca.gain.setValueAtTime(EPS, time);
    noiseVca.gain.exponentialRampToValueAtTime(Math.max(EPS, 0.1 * velocity), end - 0.02);
    noiseVca.gain.linearRampToValueAtTime(EPS, end + 0.06);
    src.connect(band);
    band.connect(noiseVca);
    noiseVca.connect(this.output);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq * 0.5, time);
    osc.frequency.exponentialRampToValueAtTime(freq * 2, end);
    const oscFilter = biquad(ctx, 'lowpass', 3000, 6);
    const oscVca = gainNode(ctx);
    oscVca.gain.setValueAtTime(EPS, time);
    oscVca.gain.exponentialRampToValueAtTime(Math.max(EPS, 0.07 * velocity), end - 0.02);
    oscVca.gain.linearRampToValueAtTime(EPS, end + 0.06);
    osc.connect(oscFilter);
    oscFilter.connect(oscVca);
    oscVca.connect(this.output);
    osc.start(time);
    osc.stop(end + 0.1);

    const verbSend = gainNode(ctx, 0.4);
    noiseVca.connect(verbSend);
    oscVca.connect(verbSend);
    verbSend.connect(this.graph.reverbIn);

    this.track(src);
    this.track(osc);
    reap(src, src, band, noiseVca);
    reap(osc, osc, oscFilter, oscVca, verbSend);
  }
}

/* -------------------------------------------------------------------------- */
/* Ship engine                                                                */
/* -------------------------------------------------------------------------- */

interface EngineNodes {
  osc: OscillatorNode[];
  sub: OscillatorNode;
  boostOsc: OscillatorNode[];
  noise: AudioBufferSourceNode;
  wobble: OscillatorNode;
  drift: OscillatorNode;
  toneFilter: BiquadFilterNode;
  boostFilter: BiquadFilterNode;
  turbFilter: BiquadFilterNode;
  cleanGain: GainNode;
  driveGain: GainNode;
  boostGain: GainNode;
  turbGain: GainNode;
  subGain: GainNode;
  out: GainNode;
  all: AudioNode[];
}

/**
 * The anti-grav drive.
 *
 * This plays for the entire race, so the priorities are different from every
 * other voice: it has to be interesting enough not to feel like a test tone and
 * calm enough not to be exhausting after twenty minutes. That means a bounded
 * pitch range, low filter resonance, a hard ceiling on the top end, and two
 * very slow LFOs (a detune drift and an amplitude wobble) that keep it alive
 * without ever drawing attention.
 *
 * Every setter smooths through `setTargetAtTime`; nothing here ever assigns to
 * `.value` while running, because a step change on an audio-rate parameter is a
 * click.
 */
export class ShipEngineVoice implements EngineVoice {
  private readonly getGraph: () => AudioGraph | null;
  private nodes: EngineNodes | null = null;
  private running = false;
  private speed = 0;
  private throttle = 0;
  private boost = 0;
  private slip = 0;

  constructor(getGraph: () => AudioGraph | null) {
    this.getGraph = getGraph;
  }

  setSpeed(normalised: number): void {
    this.speed = clamp01(normalised);
    this.apply();
  }

  setThrottle(v: number): void {
    this.throttle = clamp01(v);
    this.apply();
  }

  setBoost(v: number): void {
    this.boost = clamp01(v);
    this.apply();
  }

  setSlip(v: number): void {
    this.slip = clamp01(v);
    this.apply();
  }

  start(): void {
    this.running = true;
    this.build();
  }

  stop(): void {
    this.running = false;
    const graph = this.getGraph();
    const nodes = this.nodes;
    if (!graph || !nodes) return;
    const t = graph.ctx.currentTime;
    // Fade before killing the oscillators, or the cut is a click.
    nodes.out.gain.cancelScheduledValues(t);
    nodes.out.gain.setTargetAtTime(0, t, 0.06);
    const stopAt = t + 0.4;
    for (const source of [...nodes.osc, ...nodes.boostOsc, nodes.sub, nodes.noise, nodes.wobble, nodes.drift]) {
      try {
        source.stop(stopAt);
      } catch {
        /* already stopped */
      }
    }
    const dying = nodes;
    nodes.noise.onended = (): void => {
      for (const node of dying.all) {
        try {
          node.disconnect();
        } catch {
          /* already gone */
        }
      }
    };
    this.nodes = null;
  }

  /** Called by the engine after `unlock()` so a pre-unlock `start()` still works. */
  resumeIfRequested(): void {
    if (this.running && !this.nodes) this.build();
  }

  dispose(): void {
    this.stop();
    this.running = false;
  }

  private build(): void {
    if (this.nodes) return;
    const graph = this.getGraph();
    if (!graph) return; // Not unlocked yet — `resumeIfRequested` picks it up.
    const ctx = graph.ctx;
    const t = ctx.currentTime;

    const mix = gainNode(ctx, 1);
    const osc: OscillatorNode[] = [];
    for (const detune of [-9, 0, 11]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 48;
      o.detune.value = detune;
      const g = gainNode(ctx, 0.3);
      o.connect(g);
      g.connect(mix);
      o.start(t);
      osc.push(o);
    }
    const square = ctx.createOscillator();
    square.type = 'square';
    square.frequency.value = 48;
    const squareGain = gainNode(ctx, 0.12);
    square.connect(squareGain);
    squareGain.connect(mix);
    square.start(t);
    osc.push(square);

    // Sub an octave down gives the craft mass.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 24;
    const subGain = gainNode(ctx, 0.34);
    sub.connect(subGain);
    subGain.connect(mix);
    sub.start(t);

    const toneFilter = biquad(ctx, 'lowpass', 500, 2.2);
    mix.connect(toneFilter);

    // Clean / driven crossfade. Changing a waveshaper curve mid-flight is a
    // click, so we crossfade between two fixed paths instead.
    const cleanGain = gainNode(ctx, 1);
    const drive = ctx.createWaveShaper();
    drive.curve = createDriveCurve(0.55);
    const driveGain = gainNode(ctx, 0);
    toneFilter.connect(cleanGain);
    toneFilter.connect(drive);
    drive.connect(driveGain);

    // Aggressive upper layer, only audible under boost.
    const boostOsc: OscillatorNode[] = [];
    const boostMix = gainNode(ctx, 1);
    for (const detune of [-18, 18]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 96;
      o.detune.value = detune;
      o.connect(boostMix);
      o.start(t);
      boostOsc.push(o);
    }
    const boostFilter = biquad(ctx, 'bandpass', 1800, 4);
    const boostGain = gainNode(ctx, 0);
    boostMix.connect(boostFilter);
    boostFilter.connect(boostGain);

    // Turbulence: filtered noise that only appears when the craft is sliding.
    const noise = ctx.createBufferSource();
    noise.buffer = graph.noise;
    noise.loop = true;
    const turbFilter = biquad(ctx, 'bandpass', 900, 1.6);
    const turbGain = gainNode(ctx, 0);
    noise.connect(turbFilter);
    turbFilter.connect(turbGain);
    noise.start(t);

    // Anti-fatigue motion. Neither of these is consciously audible; without
    // them the tone sounds synthetic and gets tiring within a lap.
    const drift = ctx.createOscillator();
    drift.type = 'sine';
    drift.frequency.value = 0.11;
    const driftDepth = gainNode(ctx, 6);
    drift.connect(driftDepth);
    for (const o of osc) driftDepth.connect(o.detune);
    drift.start(t);

    const wobble = ctx.createOscillator();
    wobble.type = 'sine';
    wobble.frequency.value = 4.7;
    const wobbleDepth = gainNode(ctx, 0.025);
    wobble.connect(wobbleDepth);
    wobble.start(t);

    // Final tone shaping: a fixed lowpass so the engine can never get harsh.
    const tame = biquad(ctx, 'lowpass', 5200, 0.7);
    const out = gainNode(ctx, 0);
    cleanGain.connect(tame);
    driveGain.connect(tame);
    boostGain.connect(tame);
    turbGain.connect(tame);
    tame.connect(out);
    wobbleDepth.connect(out.gain);
    out.connect(graph.sfx);

    const verbSend = gainNode(ctx, 0.08);
    out.connect(verbSend);
    verbSend.connect(graph.reverbIn);

    out.gain.setValueAtTime(0, t);
    out.gain.setTargetAtTime(ENGINE_LEVEL, t, 0.25);

    this.nodes = {
      osc,
      sub,
      boostOsc,
      noise,
      wobble,
      drift,
      toneFilter,
      boostFilter,
      turbFilter,
      cleanGain,
      driveGain,
      boostGain,
      turbGain,
      subGain,
      out,
      all: [
        mix,
        squareGain,
        subGain,
        toneFilter,
        cleanGain,
        drive,
        driveGain,
        boostMix,
        boostFilter,
        boostGain,
        turbFilter,
        turbGain,
        driftDepth,
        wobbleDepth,
        tame,
        out,
        verbSend,
      ],
    };
    this.apply();
  }

  private apply(): void {
    const nodes = this.nodes;
    const graph = this.getGraph();
    if (!nodes || !graph) return;
    const t = graph.ctx.currentTime;
    const { speed, throttle, boost, slip } = this;

    // Pitch: exponential in speed so the top end does not feel compressed, but
    // bounded to roughly two and a half octaves so it never becomes a whistle.
    const base = ENGINE_BASE_HZ * Math.pow(ENGINE_PITCH_RANGE, speed) * (1 + boost * 0.16);
    const smooth = 0.09;
    for (const o of nodes.osc) o.frequency.setTargetAtTime(base, t, smooth);
    nodes.sub.frequency.setTargetAtTime(base * 0.5, t, smooth);
    nodes.subGain.gain.setTargetAtTime(lerp(0.4, 0.22, speed), t, 0.2);

    // Brightness tracks speed first, then throttle and boost on top.
    const cutoff = clamp(
      300 + Math.pow(speed, 1.25) * 3800 + throttle * 900 + boost * 2600,
      220,
      7000,
    );
    nodes.toneFilter.frequency.setTargetAtTime(cutoff, t, 0.07);
    nodes.toneFilter.Q.setTargetAtTime(lerp(1.6, 3.2, speed * 0.6 + boost * 0.4), t, 0.15);

    // Harmonic drive from throttle, equal-power so the level stays put.
    const driveAmount = clamp01(throttle * 0.85 + boost * 0.3);
    nodes.cleanGain.gain.setTargetAtTime(Math.cos(driveAmount * Math.PI * 0.5), t, 0.1);
    nodes.driveGain.gain.setTargetAtTime(Math.sin(driveAmount * Math.PI * 0.5) * 0.85, t, 0.1);

    for (const o of nodes.boostOsc) o.frequency.setTargetAtTime(base * 2, t, smooth);
    nodes.boostFilter.frequency.setTargetAtTime(clamp(1200 + boost * 3200, 400, 6000), t, 0.09);
    nodes.boostGain.gain.setTargetAtTime(boost * boost * 0.28, t, 0.08);

    nodes.turbFilter.frequency.setTargetAtTime(clamp(600 + slip * 2200 + speed * 900, 200, 5000), t, 0.06);
    nodes.turbGain.gain.setTargetAtTime(slip * slip * 0.16 * (0.4 + speed * 0.6), t, 0.05);

    nodes.out.gain.setTargetAtTime(ENGINE_LEVEL * (0.72 + throttle * 0.2 + speed * 0.12), t, 0.12);
  }
}

const ENGINE_BASE_HZ = 44;
const ENGINE_PITCH_RANGE = 4.6;
const ENGINE_LEVEL = 0.24;
