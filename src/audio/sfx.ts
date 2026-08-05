/**
 * Synthesised sound effects.
 *
 * Every entry in `SfxName` is built here from oscillators and the shared noise
 * buffer — there are no samples anywhere in the project. Impacts get a real
 * three-part construction (noise transient, pitch-swept body, reverb tail) so
 * they have weight; UI sounds are deliberately tiny and dry so they never get
 * tiring; and anything the player hears in a musical context — the countdown,
 * beat gates, lap and finish stingers — is tuned to the track's own key, so it
 * lands as part of the arrangement rather than on top of it.
 */

import { clamp } from '../core/mathx';
import { degreeToMidi, midiToFreq, type ScaleName } from './theory';
import {
  EPS,
  biquad,
  createDriveCurve,
  decayEnvelope,
  gainNode,
  noiseSource,
  reap,
  type AudioGraph,
} from './synth';
import type { SfxName, SfxOptions } from './types';

/** Per-effect trim so the whole set sits at a consistent perceived loudness. */
const LEVELS: Readonly<Record<SfxName, number>> = {
  uiMove: 0.16,
  uiSelect: 0.24,
  uiBack: 0.2,
  uiError: 0.24,
  countdownTick: 0.4,
  countdownGo: 0.6,
  boostPad: 0.34,
  boostFire: 0.55,
  gateHit: 0.34,
  gatePerfect: 0.42,
  gateMiss: 0.3,
  impactSoft: 0.42,
  impactHard: 0.7,
  scrape: 0.2,
  shieldPickup: 0.38,
  shieldLow: 0.3,
  weaponPickup: 0.38,
  weaponFire: 0.42,
  explode: 0.72,
  lapComplete: 0.46,
  finish: 0.6,
  respawn: 0.4,
  eliminated: 0.5,
};

interface Bus {
  /** Connect voices here. */
  input: GainNode;
  /** Nodes to disconnect once the effect has finished. */
  chain: AudioNode[];
}

export class SfxPlayer {
  private readonly graph: AudioGraph;
  private root = 45;
  private scale: ScaleName = 'minor';

  constructor(graph: AudioGraph) {
    this.graph = graph;
  }

  /** Retune the musical effects when a new track's music starts. */
  setKey(root: number, scale: ScaleName): void {
    this.root = root;
    this.scale = scale;
  }

  /**
   * Fire an effect. `when` is an absolute context time; omit it for "now".
   * A few milliseconds of lead-in avoids scheduling in the past, which some
   * browsers turn into a click.
   */
  play(name: SfxName, options: SfxOptions = {}, when?: number): void {
    const ctx = this.graph.ctx;
    const time = Math.max(when ?? ctx.currentTime, ctx.currentTime) + 0.002;
    const rate = clamp(options.rate ?? 1, 0.25, 4);
    const volume = clamp(options.volume ?? 1, 0, 4) * LEVELS[name];
    const pan = clamp(options.pan ?? 0, -1, 1);
    this.render(name, time, rate, volume, pan);
  }

  /* -- routing ------------------------------------------------------------- */

  /** A per-hit output chain: level, optional pan, optional reverb send. */
  private bus(volume: number, pan: number, reverbSend = 0): Bus {
    const ctx = this.graph.ctx;
    const input = gainNode(ctx, volume);
    const chain: AudioNode[] = [input];
    let tail: AudioNode = input;
    if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      input.connect(panner);
      chain.push(panner);
      tail = panner;
    }
    tail.connect(this.graph.sfx);
    if (reverbSend > 0) {
      const send = gainNode(ctx, reverbSend);
      tail.connect(send);
      send.connect(this.graph.reverbIn);
      chain.push(send);
    }
    return { input, chain };
  }

  /** Scale degree → frequency, in the current track's key. */
  private degreeHz(degree: number, octaves = 0): number {
    return midiToFreq(degreeToMidi(this.root, this.scale, degree) + octaves * 12);
  }

  /* -- primitives ---------------------------------------------------------- */

  /** A simple decaying oscillator. The workhorse behind the UI sounds. */
  private blip(
    bus: Bus,
    time: number,
    freq: number,
    duration: number,
    level: number,
    type: OscillatorType = 'sine',
    endFreq?: number,
  ): void {
    const ctx = this.graph.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(clamp(freq, 20, 18000), time);
    if (endFreq !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(clamp(endFreq, 20, 18000), time + duration);
    }
    const vca = gainNode(ctx);
    const end = decayEnvelope(vca.gain, time, level, 0.004, duration);
    osc.connect(vca);
    vca.connect(bus.input);
    osc.start(time);
    osc.stop(end);
    reap(osc, osc, vca);
  }

  /** Two-operator FM — metallic, glassy, and cheap. Used for anything "chime". */
  private bell(
    bus: Bus,
    time: number,
    freq: number,
    duration: number,
    level: number,
    ratio = 2.76,
    index = 4,
  ): void {
    const ctx = this.graph.ctx;
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = clamp(freq, 20, 12000);
    const modulator = ctx.createOscillator();
    modulator.type = 'sine';
    modulator.frequency.value = clamp(freq * ratio, 20, 18000);
    const depth = gainNode(ctx, 0);
    decayEnvelope(depth.gain, time, freq * index, 0.002, duration * 0.35);
    modulator.connect(depth);
    depth.connect(carrier.frequency);

    const vca = gainNode(ctx);
    const end = decayEnvelope(vca.gain, time, level, 0.003, duration);
    carrier.connect(vca);
    vca.connect(bus.input);
    carrier.start(time);
    modulator.start(time);
    carrier.stop(end);
    modulator.stop(end);
    reap(carrier, carrier, modulator, depth, vca);
  }

  /** Filtered noise burst — the transient half of every impact. */
  private burst(
    bus: Bus,
    time: number,
    duration: number,
    level: number,
    type: BiquadFilterType,
    freq: number,
    q = 1,
    endFreq?: number,
  ): void {
    const ctx = this.graph.ctx;
    const src = noiseSource(this.graph, time, duration + 0.05);
    const filter = biquad(ctx, type, freq, q);
    if (endFreq !== undefined) {
      filter.frequency.setValueAtTime(clamp(freq, 20, 18000), time);
      filter.frequency.exponentialRampToValueAtTime(clamp(endFreq, 20, 18000), time + duration);
    }
    const vca = gainNode(ctx);
    decayEnvelope(vca.gain, time, level, 0.002, duration);
    src.connect(filter);
    filter.connect(vca);
    vca.connect(bus.input);
    reap(src, src, filter, vca);
  }

  /** Pitch-swept low body — the weight half of every impact. */
  private body(
    bus: Bus,
    time: number,
    fromHz: number,
    toHz: number,
    duration: number,
    level: number,
    drive = 0,
  ): void {
    const ctx = this.graph.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(clamp(fromHz, 20, 8000), time);
    osc.frequency.exponentialRampToValueAtTime(clamp(toHz, 20, 8000), time + duration);
    const vca = gainNode(ctx);
    const end = decayEnvelope(vca.gain, time, level, 0.003, duration);
    osc.connect(vca);
    if (drive > 0) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = createDriveCurve(drive);
      vca.connect(shaper);
      shaper.connect(bus.input);
      reap(osc, osc, vca, shaper);
    } else {
      vca.connect(bus.input);
      reap(osc, osc, vca);
    }
    osc.start(time);
    osc.stop(end);
  }

  /** Noise through a bandpass swept between two frequencies. Whooshes, risers. */
  private sweep(
    bus: Bus,
    time: number,
    duration: number,
    level: number,
    fromHz: number,
    toHz: number,
    q = 3,
    rising = true,
  ): void {
    const ctx = this.graph.ctx;
    const src = noiseSource(this.graph, time, duration + 0.08);
    const filter = biquad(ctx, 'bandpass', fromHz, q);
    filter.frequency.setValueAtTime(clamp(fromHz, 20, 18000), time);
    filter.frequency.exponentialRampToValueAtTime(clamp(toHz, 20, 18000), time + duration);
    const vca = gainNode(ctx);
    vca.gain.setValueAtTime(EPS, time);
    if (rising) {
      vca.gain.exponentialRampToValueAtTime(Math.max(EPS, level), time + duration * 0.9);
      vca.gain.linearRampToValueAtTime(EPS, time + duration + 0.05);
    } else {
      vca.gain.linearRampToValueAtTime(Math.max(EPS, level), time + 0.01);
      vca.gain.exponentialRampToValueAtTime(EPS, time + duration);
    }
    src.connect(filter);
    filter.connect(vca);
    vca.connect(bus.input);
    reap(src, src, filter, vca);
  }

  /* -- the catalogue ------------------------------------------------------- */

  private render(name: SfxName, time: number, rate: number, volume: number, pan: number): void {
    // `rate` behaves like a sample playback rate: pitch up, duration down.
    const s = (seconds: number): number => seconds / rate;
    const hz = (frequency: number): number => frequency * rate;
    const deg = (degree: number, octaves = 0): number => this.degreeHz(degree, octaves) * rate;

    switch (name) {
      /* --- UI: crisp, short, dry ---------------------------------------- */
      case 'uiMove': {
        const bus = this.bus(volume, pan);
        this.blip(bus, time, hz(1180), s(0.04), 0.5, 'triangle');
        this.burst(bus, time, s(0.012), 0.12, 'highpass', hz(4000));
        this.sweepCleanup(bus, time + s(0.1));
        break;
      }
      case 'uiSelect': {
        const bus = this.bus(volume, pan, 0.08);
        this.bell(bus, time, deg(4, 2), s(0.16), 0.5, 2, 3);
        this.bell(bus, time + s(0.045), deg(7, 2), s(0.22), 0.42, 2, 3);
        this.sweepCleanup(bus, time + s(0.35));
        break;
      }
      case 'uiBack': {
        const bus = this.bus(volume, pan);
        this.blip(bus, time, deg(4, 1), s(0.09), 0.45, 'triangle');
        this.blip(bus, time + s(0.04), deg(0, 1), s(0.14), 0.4, 'triangle');
        this.sweepCleanup(bus, time + s(0.25));
        break;
      }
      case 'uiError': {
        const bus = this.bus(volume, pan);
        // Two close squares beat against each other — reads as "wrong".
        this.blip(bus, time, hz(146), s(0.22), 0.34, 'square');
        this.blip(bus, time, hz(155), s(0.22), 0.3, 'square');
        this.sweepCleanup(bus, time + s(0.35));
        break;
      }

      /* --- Countdown: tuned to the track's key -------------------------- */
      case 'countdownTick': {
        const bus = this.bus(volume, pan, 0.22);
        this.bell(bus, time, deg(4, 1), s(0.42), 0.55, 2, 3.2);
        this.burst(bus, time, s(0.015), 0.18, 'bandpass', hz(3200), 1.2);
        this.sweepCleanup(bus, time + s(0.7));
        break;
      }
      case 'countdownGo': {
        const bus = this.bus(volume, pan, 0.4);
        // Root triad two octaves up, plus a sub thump and a cymbal wash.
        for (const [degree, level, delay] of [
          [0, 0.6, 0],
          [2, 0.45, 0.004],
          [4, 0.5, 0.008],
          [7, 0.4, 0.012],
        ] as const) {
          this.bell(bus, time + s(delay), deg(degree, 1), s(1.1), level, 2, 4);
        }
        this.body(bus, time, hz(140), hz(46), s(0.5), 0.6, 0.3);
        this.burst(bus, time, s(1.4), 0.2, 'highpass', hz(4600));
        this.sweepCleanup(bus, time + s(2));
        break;
      }

      /* --- Boost -------------------------------------------------------- */
      case 'boostPad': {
        const bus = this.bus(volume, pan, 0.2);
        this.sweep(bus, time, s(0.26), 0.5, hz(500), hz(6500), 2.5);
        this.bell(bus, time + s(0.18), deg(4, 2), s(0.3), 0.3, 3.5, 3);
        this.sweepCleanup(bus, time + s(0.6));
        break;
      }
      case 'boostFire': {
        const bus = this.bus(volume, pan, 0.25);
        this.burst(bus, time, s(0.5), 0.55, 'lowpass', hz(4200), 0.8, hz(700));
        this.body(bus, time, hz(220), hz(52), s(0.45), 0.7, 0.45);
        this.sweep(bus, time, s(0.35), 0.28, hz(900), hz(5200), 2);
        this.sweepCleanup(bus, time + s(0.8));
        break;
      }

      /* --- Beat gates: musical, so they land inside the arrangement ----- */
      case 'gateHit': {
        const bus = this.bus(volume, pan, 0.12);
        this.blip(bus, time, deg(0, 2), s(0.11), 0.5, 'square');
        this.burst(bus, time, s(0.02), 0.16, 'highpass', hz(5000));
        this.sweepCleanup(bus, time + s(0.25));
        break;
      }
      case 'gatePerfect': {
        const bus = this.bus(volume, pan, 0.3);
        this.bell(bus, time, deg(0, 2), s(0.42), 0.5, 2, 4);
        this.bell(bus, time + s(0.03), deg(4, 2), s(0.5), 0.42, 2, 4);
        this.burst(bus, time, s(0.03), 0.18, 'highpass', hz(6000));
        this.sweepCleanup(bus, time + s(0.9));
        break;
      }
      case 'gateMiss': {
        const bus = this.bus(volume, pan, 0.1);
        // Same rhythm as a hit but dull and falling — clearly the wrong answer.
        this.blip(bus, time, deg(0, 1), s(0.18), 0.4, 'sawtooth', deg(0, 0) * 0.72);
        this.burst(bus, time, s(0.08), 0.16, 'lowpass', hz(900));
        this.sweepCleanup(bus, time + s(0.35));
        break;
      }

      /* --- Impacts: transient + body + tail ----------------------------- */
      case 'impactSoft': {
        const bus = this.bus(volume, pan, 0.22);
        this.burst(bus, time, s(0.16), 0.42, 'bandpass', hz(900), 0.8, hz(320));
        this.body(bus, time, hz(180), hz(62), s(0.26), 0.5, 0.2);
        this.sweepCleanup(bus, time + s(0.6));
        break;
      }
      case 'impactHard': {
        const bus = this.bus(volume, pan, 0.4);
        this.burst(bus, time, s(0.02), 0.5, 'highpass', hz(3000));
        this.burst(bus, time, s(0.45), 0.5, 'lowpass', hz(3400), 0.7, hz(400));
        this.body(bus, time, hz(260), hz(44), s(0.55), 0.85, 0.5);
        this.body(bus, time + s(0.01), hz(90), hz(38), s(0.7), 0.5);
        this.sweepCleanup(bus, time + s(1.4));
        break;
      }
      case 'scrape': {
        // Called repeatedly while grinding a wall, so it must be short and cheap.
        const bus = this.bus(volume, pan, 0.06);
        this.burst(bus, time, s(0.12), 0.4, 'bandpass', hz(2600), 6, hz(1900));
        this.burst(bus, time, s(0.1), 0.2, 'highpass', hz(5200));
        this.sweepCleanup(bus, time + s(0.25));
        break;
      }

      /* --- Pickups and status ------------------------------------------- */
      case 'shieldPickup': {
        const bus = this.bus(volume, pan, 0.32);
        for (let i = 0; i < 3; i++) {
          this.bell(bus, time + s(i * 0.055), deg(i * 2, 1), s(0.5), 0.42, 2, 3);
        }
        this.sweep(bus, time, s(0.3), 0.14, hz(700), hz(5000), 3);
        this.sweepCleanup(bus, time + s(1));
        break;
      }
      case 'shieldLow': {
        const bus = this.bus(volume, pan, 0.1);
        this.blip(bus, time, deg(1, 1), s(0.1), 0.5, 'square');
        this.blip(bus, time + s(0.14), deg(0, 1), s(0.14), 0.5, 'square');
        this.sweepCleanup(bus, time + s(0.4));
        break;
      }
      case 'weaponPickup': {
        const bus = this.bus(volume, pan, 0.22);
        this.bell(bus, time, deg(2, 1), s(0.2), 0.4, 3.5, 5);
        this.bell(bus, time + s(0.06), deg(0, 2), s(0.4), 0.45, 3.5, 5);
        this.sweepCleanup(bus, time + s(0.7));
        break;
      }
      case 'weaponFire': {
        const bus = this.bus(volume, pan, 0.15);
        this.blip(bus, time, hz(2400), s(0.16), 0.4, 'sawtooth', hz(220));
        this.burst(bus, time, s(0.12), 0.3, 'bandpass', hz(3000), 3, hz(600));
        this.sweepCleanup(bus, time + s(0.3));
        break;
      }
      case 'explode': {
        const bus = this.bus(volume, pan, 0.5);
        this.burst(bus, time, s(0.03), 0.55, 'highpass', hz(2600));
        this.burst(bus, time, s(1.1), 0.6, 'lowpass', hz(3000), 0.6, hz(180));
        this.body(bus, time, hz(300), hz(34), s(0.9), 0.9, 0.6);
        this.sweep(bus, time + s(0.05), s(0.7), 0.2, hz(2600), hz(300), 1.5, false);
        this.sweepCleanup(bus, time + s(2.2));
        break;
      }

      /* --- Race events: fanfares in the track's key --------------------- */
      case 'lapComplete': {
        const bus = this.bus(volume, pan, 0.35);
        for (let i = 0; i < 3; i++) {
          this.bell(bus, time + s(i * 0.075), deg([0, 2, 4][i], 1), s(0.55), 0.45, 2, 3.5);
        }
        this.burst(bus, time, s(0.5), 0.12, 'highpass', hz(5200));
        this.sweepCleanup(bus, time + s(1.2));
        break;
      }
      case 'finish': {
        const bus = this.bus(volume, pan, 0.45);
        for (const [degree, octave, delay] of [
          [0, 1, 0],
          [2, 1, 0.06],
          [4, 1, 0.12],
          [0, 2, 0.18],
        ] as const) {
          this.bell(bus, time + s(delay), deg(degree, octave), s(1.6), 0.5, 2, 4);
        }
        this.body(bus, time, hz(150), hz(48), s(0.7), 0.6, 0.35);
        this.burst(bus, time, s(1.8), 0.16, 'highpass', hz(4800));
        this.sweepCleanup(bus, time + s(2.6));
        break;
      }
      case 'respawn': {
        const bus = this.bus(volume, pan, 0.3);
        this.sweep(bus, time, s(0.45), 0.35, hz(300), hz(4000), 3);
        this.bell(bus, time + s(0.4), deg(0, 2), s(0.5), 0.45, 2, 3);
        this.sweepCleanup(bus, time + s(1.1));
        break;
      }
      case 'eliminated': {
        const bus = this.bus(volume, pan, 0.4);
        // A falling minor cluster: the harmony itself is the bad news.
        this.blip(bus, time, deg(0, 1), s(1.1), 0.3, 'sawtooth', deg(0, 0) * 0.5);
        this.blip(bus, time, deg(2, 1) * 1.01, s(1.1), 0.24, 'sawtooth', deg(2, 0) * 0.5);
        this.body(bus, time, hz(120), hz(36), s(0.8), 0.5, 0.3);
        this.sweepCleanup(bus, time + s(1.8));
        break;
      }
    }
  }

  /**
   * Tear a hit's output chain down once its tail has passed. Voices disconnect
   * themselves via `reap`; this catches the shared bus nodes behind them.
   */
  private sweepCleanup(bus: Bus, at: number): void {
    const ctx = this.graph.ctx;
    const marker = ctx.createBufferSource();
    // A one-sample silent buffer is the cheapest way to get an `onended` at a
    // scheduled time without keeping a JS timer alive.
    marker.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    marker.start(Math.max(at, ctx.currentTime));
    marker.onended = (): void => {
      for (const node of bus.chain) {
        try {
          node.disconnect();
        } catch {
          /* already gone */
        }
      }
    };
  }
}
