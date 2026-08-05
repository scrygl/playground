import type { Vehicle } from './vehicle';
import { lerpAngle, loopDelta } from '../core/mathx';

/**
 * Records and replays a lap.
 *
 * Samples are transforms rather than inputs. Replaying inputs would be a
 * fraction of the size, but it requires the simulation to be bit-identical
 * forever — one tuning change to grip and every stored ghost silently drives
 * into a wall. Storing where the craft actually was costs a few kilobytes and
 * can never rot.
 *
 * Samples live in track space, so a ghost interpolates correctly through loops
 * and needs no quaternion machinery to store or blend.
 */

/** Samples per second. Fast enough that interpolation is invisible at speed. */
const SAMPLE_RATE = 20;
/** Fields per sample: time, s, lateral, height, yaw, roll, pitch. */
const STRIDE = 7;

export class GhostRecorder {
  private readonly samples: number[] = [];
  private nextSampleAt = 0;

  reset(): void {
    this.samples.length = 0;
    this.nextSampleAt = 0;
  }

  /** `time` is milliseconds since the lap started. */
  record(vehicle: Vehicle, time: number): void {
    if (time < this.nextSampleAt) return;
    this.nextSampleAt = time + 1000 / SAMPLE_RATE;
    this.samples.push(
      time,
      vehicle.s,
      vehicle.lateral,
      vehicle.height,
      vehicle.yaw,
      vehicle.visualRoll,
      vehicle.pitch,
    );
  }

  /** Rounded to keep the stored JSON small; the loss is far below visible. */
  finish(): number[] {
    return this.samples.map((v, i) => (i % STRIDE === 0 ? Math.round(v) : Math.round(v * 1000) / 1000));
  }

  get sampleCount(): number {
    return this.samples.length / STRIDE;
  }
}

export interface GhostPose {
  s: number;
  lateral: number;
  height: number;
  yaw: number;
  roll: number;
  pitch: number;
}

export class GhostPlayer {
  private readonly data: number[];
  private cursor = 0;
  readonly duration: number;
  readonly pose: GhostPose = { s: 0, lateral: 0, height: 2, yaw: 0, roll: 0, pitch: 0 };

  constructor(data: number[], private readonly trackLength: number) {
    // Guard against a truncated or hand-edited save.
    const usable = Math.floor(data.length / STRIDE) * STRIDE;
    this.data = data.slice(0, usable);
    this.duration = usable >= STRIDE ? this.data[usable - STRIDE] : 0;
  }

  get valid(): boolean {
    return this.data.length >= STRIDE * 2;
  }

  /** Advances to `time` (ms since lap start) and fills {@link pose}. */
  seek(time: number): GhostPose {
    if (!this.valid) return this.pose;
    const count = this.data.length / STRIDE;

    // Cursor usually moves forward one step at a time; only a scrub costs more.
    if (time < this.data[this.cursor * STRIDE]) this.cursor = 0;
    while (this.cursor < count - 2 && this.data[(this.cursor + 1) * STRIDE] <= time) this.cursor++;

    const i = this.cursor * STRIDE;
    const j = Math.min(this.cursor + 1, count - 1) * STRIDE;
    const t0 = this.data[i];
    const t1 = this.data[j];
    const f = t1 > t0 ? Math.min(1, Math.max(0, (time - t0) / (t1 - t0))) : 0;

    // `s` wraps at the start line, so interpolate the short way round.
    const s0 = this.data[i + 1];
    this.pose.s = s0 + loopDelta(s0, this.data[j + 1], this.trackLength) * f;
    this.pose.lateral = lerp(this.data[i + 2], this.data[j + 2], f);
    this.pose.height = lerp(this.data[i + 3], this.data[j + 3], f);
    this.pose.yaw = lerpAngle(this.data[i + 4], this.data[j + 4], f);
    this.pose.roll = lerpAngle(this.data[i + 5], this.data[j + 5], f);
    this.pose.pitch = lerpAngle(this.data[i + 6], this.data[j + 6], f);
    return this.pose;
  }

  /**
   * Time the ghost took to reach `s` on its lap.
   *
   * This is what the live delta readout compares against, so it answers
   * "when was the ghost here", not "where is the ghost now".
   */
  timeAtDistance(s: number): number {
    if (!this.valid) return 0;
    const count = this.data.length / STRIDE;
    // The recording is monotonic in distance apart from the start-line wrap,
    // so a linear scan from the start is both correct and fast enough at 20 Hz.
    let best = 0;
    for (let k = 0; k < count; k++) {
      const sampleS = this.data[k * STRIDE + 1];
      if (sampleS <= s) best = this.data[k * STRIDE];
      else break;
    }
    return best;
  }

  reset(): void {
    this.cursor = 0;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
