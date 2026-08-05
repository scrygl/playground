import { Vector3 } from 'three';
import { buildPath, solveClosure } from './builder';
import { placeFeatures } from './features';
import { TrackPath } from './path';
import type { TrackDefinition, TrackFeature } from './types';
import { clamp, mod } from '../core/mathx';

/** Keep-clear margin from the wall, in metres: roughly half a ship plus slack. */
const EDGE_MARGIN = 5.5;
/** Lateral grip budget used when predicting cornering speed, in m/s². */
const LATERAL_ACCEL = 36;
/** Bounds on the predicted speed profile, in m/s. */
const PROFILE_MAX_SPEED = 240;
const PROFILE_BRAKE = 55;
const PROFILE_ACCEL = 30;
/**
 * Top speed the medal thresholds are reckoned against, in m/s.
 *
 * Deliberately a constant rather than the chosen ship's top speed: a gold on a
 * track should mean the same thing whatever you drove to get it.
 */
const REFERENCE_TOP_SPEED = 165;
/**
 * How much slower than a mathematically perfect lap each medal allows.
 *
 * A perfect lap holds the grip limit through every corner and never wastes a
 * metre of the line, which no one does — author sits a few percent off it,
 * and the lower medals open up from there.
 */
const MEDAL_FACTORS = { author: 1.05, gold: 1.15, silver: 1.29, bronze: 1.48 };
/**
 * Time allowance for the standing start, in milliseconds.
 *
 * The grid sits behind the line, so a race clock started at lights-out includes
 * a launch that no lap contains. Folding it into the thresholds keeps medals
 * honest — without it every target is a couple of seconds tighter than the
 * driving actually requires.
 */
const STANDING_START_MS = 3200;

export interface MedalTimes {
  author: number;
  gold: number;
  silver: number;
  bronze: number;
}

/**
 * A track, fully resolved and ready to race: geometry, features, a racing line,
 * and a speed profile.
 *
 * Everything here is computed once at load. The racing line in particular is
 * far too expensive to derive per frame, but having it precomputed is what lets
 * the AI drive a genuinely good line and lets the HUD show a corner-speed hint.
 */
export class Track {
  readonly path: TrackPath;
  readonly features: TrackFeature[];
  /** Lateral offset of the ideal line at each path sample, in metres. */
  readonly racingLine: Float32Array;
  /** Achievable speed at each path sample given the racing line, in m/s. */
  readonly speedProfile: Float32Array;
  readonly medals: MedalTimes;
  /** Total race distance in metres. */
  readonly raceDistance: number;
  readonly radius: number;
  readonly centre = new Vector3();

  /** Time a flawless lap of the ideal line would take, in milliseconds. */
  readonly idealLapMs: number;

  private constructor(readonly definition: TrackDefinition, path: TrackPath) {
    this.path = path;
    this.racingLine = computeRacingLine(path);
    this.speedProfile = computeSpeedProfile(path, this.racingLine);
    this.raceDistance = path.length * definition.laps;

    // Integrate dt = ds / v along the ideal line, held to a ship's real top
    // speed so a long straight cannot contribute an impossible fraction.
    let lapSeconds = 0;
    for (let i = 0; i < this.speedProfile.length; i++) {
      lapSeconds += path.step / Math.min(this.speedProfile[i], REFERENCE_TOP_SPEED);
    }
    this.idealLapMs = lapSeconds * 1000;

    const raceMs = this.idealLapMs * definition.laps * (definition.medalScale ?? 1);
    this.medals = {
      author: raceMs * MEDAL_FACTORS.author + STANDING_START_MS,
      gold: raceMs * MEDAL_FACTORS.gold + STANDING_START_MS,
      silver: raceMs * MEDAL_FACTORS.silver + STANDING_START_MS,
      bronze: raceMs * MEDAL_FACTORS.bronze + STANDING_START_MS,
    };

    // Beat-gate spacing needs the pace a player will actually carry down a
    // straight, which is the derived lap pace rather than a guess.
    this.features = placeFeatures(path, {
      music: definition.music,
      paceSpeed: path.length / lapSeconds,
      seed: definition.seed,
      laps: definition.laps,
    });

    this.centre.copy(path.bounds.min).add(path.bounds.max).multiplyScalar(0.5);
    this.radius = path.bounds.max.distanceTo(path.bounds.min) * 0.5;
  }

  static build(definition: TrackDefinition, sampleStep = 2.5): Track {
    // Close the recipe before sampling, so the seam is an ordinary piece of
    // track rather than a bridge spliced across whatever gap was left over.
    const segments = solveClosure(definition.segments);
    const built = buildPath(segments, { halfWidth: definition.halfWidth, close: true });
    return new Track(definition, new TrackPath(built.points, sampleStep));
  }

  /** Lateral offset of the ideal line at arc position `s`, in metres. */
  racingLineAt(s: number): number {
    const x = this.path.wrap(s) / this.path.step;
    const i0 = Math.floor(x) % this.path.count;
    const i1 = (i0 + 1) % this.path.count;
    const f = x - Math.floor(x);
    return this.racingLine[i0] + (this.racingLine[i1] - this.racingLine[i0]) * f;
  }

  /** Speed the ideal line supports at arc position `s`, in m/s. */
  targetSpeedAt(s: number): number {
    const x = this.path.wrap(s) / this.path.step;
    const i0 = Math.floor(x) % this.path.count;
    const i1 = (i0 + 1) % this.path.count;
    const f = x - Math.floor(x);
    return this.speedProfile[i0] + (this.speedProfile[i1] - this.speedProfile[i0]) * f;
  }

  /** Lowest supported speed within `distance` metres ahead — the braking cue. */
  minSpeedAhead(s: number, distance: number): number {
    const steps = Math.max(1, Math.round(distance / this.path.step));
    const start = Math.floor(this.path.wrap(s) / this.path.step);
    let min = Infinity;
    for (let i = 0; i <= steps; i++) {
      const v = this.speedProfile[(start + i) % this.path.count];
      if (v < min) min = v;
    }
    return min;
  }

  /**
   * Starting slot for racer `index` of `total`, staggered two abreast behind
   * the line the way a real grid is.
   */
  gridSlot(index: number, total: number): { s: number; lateral: number } {
    const row = Math.floor(index / 2);
    const side = index % 2 === 0 ? -1 : 1;
    const halfWidth = this.path.halfWidthAt(0);
    const spread = Math.min(halfWidth * 0.45, 9);
    return {
      s: this.path.wrap(-(row * 22 + 30)),
      lateral: side * spread * (total > 1 ? 1 : 0),
    };
  }

  /** Checkpoints in track order, used for respawns and split timing. */
  checkpoints(): TrackFeature[] {
    return this.features.filter((f) => f.kind === 'checkpoint');
  }

  /** Nearest safe (non-gap) arc position at or before `s`, for respawning. */
  safeRespawn(s: number): number {
    let candidate = this.path.wrap(s);
    let guard = 0;
    while (this.path.isGapAt(candidate) && guard++ < 400) {
      candidate = this.path.wrap(candidate - this.path.step);
    }
    return candidate;
  }
}

/**
 * Derives a minimum-curvature line inside the track corridor.
 *
 * This is Laplacian smoothing under a width constraint: repeatedly pull each
 * point toward the midpoint of its neighbours, then clamp it back inside the
 * track. Run at several strides — coarse first — because a single-sample stencil
 * takes thousands of iterations to propagate information along a long corner,
 * while starting at stride 32 finds the broad shape of the line almost at once.
 */
function computeRacingLine(path: TrackPath): Float32Array {
  const n = path.count;
  const lateral = new Float32Array(n);
  const next = new Float32Array(n);
  const limit = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    limit[i] = Math.max(0, path.rawHalfWidth(i) - EDGE_MARGIN);
  }

  const world = new Vector3();
  const prevWorld = new Vector3();
  const nextWorld = new Vector3();
  const mid = new Vector3();
  const origin = new Vector3();
  const right = new Vector3();

  const strides = [32, 16, 8, 4, 2, 1, 1];
  for (const stride of strides) {
    const iterations = stride === 1 ? 90 : 60;
    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < n; i++) {
        const a = mod(i - stride, n);
        const b = mod(i + stride, n);
        path.toWorld(a * path.step, lateral[a], 0, prevWorld);
        path.toWorld(b * path.step, lateral[b], 0, nextWorld);
        mid.addVectors(prevWorld, nextWorld).multiplyScalar(0.5);

        path.rawPosition(i, origin);
        path.rawRight(i, right);
        // Project the smoothed midpoint back into this sample's frame; the
        // component along `right` is the lateral offset we can actually use.
        const target = world.subVectors(mid, origin).dot(right);
        next[i] = clamp(lateral[i] + (target - lateral[i]) * 0.45, -limit[i], limit[i]);
      }
      lateral.set(next);
    }
  }

  // Polish: the width constraint leaves sample-scale jitter wherever the line
  // rides the limit, and a 2.5 m zig-zag registers as a savage corner to any
  // curvature measure even though no ship could feel it. A short blur with
  // re-clamping removes it without disturbing the line's overall shape.
  for (let pass = 0; pass < 24; pass++) {
    for (let i = 0; i < n; i++) {
      const a = lateral[mod(i - 1, n)];
      const b = lateral[i];
      const c = lateral[mod(i + 1, n)];
      next[i] = clamp(b * 0.5 + (a + c) * 0.25, -limit[i], limit[i]);
    }
    lateral.set(next);
  }
  return lateral;
}

/**
 * Predicts the speed the racing line supports at every point.
 *
 * Cornering speed comes from the line's own curvature, then two passes sweep
 * the limit backwards (you must already be slowing before the corner) and
 * forwards (you cannot be at full speed the instant you exit). The loop is
 * circular, so both passes run twice to settle across the start line.
 */
function computeSpeedProfile(path: TrackPath, lateral: Float32Array): Float32Array {
  const n = path.count;
  const speed = new Float32Array(n);
  const step = path.step;

  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const edge1 = new Vector3();
  const edge2 = new Vector3();

  // Measure curvature over a baseline comparable to the ship, not to the sample
  // spacing. A craft eight metres long is steered by the shape of the next ten
  // metres of track; sampling adjacent 2.5 m points instead measures noise and
  // reports corners that nobody has to drive.
  const baseline = Math.max(1, Math.round(5 / step));

  for (let i = 0; i < n; i++) {
    path.toWorld(mod(i - baseline, n) * step, lateral[mod(i - baseline, n)], 0, a);
    path.toWorld(i * step, lateral[i], 0, b);
    path.toWorld(mod(i + baseline, n) * step, lateral[mod(i + baseline, n)], 0, c);

    // Menger curvature from three points: 4 * triangleArea / (product of sides).
    const ab = a.distanceTo(b);
    const bc = b.distanceTo(c);
    const ca = c.distanceTo(a);
    const area = edge1.subVectors(b, a).cross(edge2.subVectors(c, a)).length() * 0.5;
    const denom = ab * bc * ca;
    const curvature = denom > 1e-6 ? (4 * area) / denom : 0;

    speed[i] = curvature > 1e-6 ? Math.sqrt(LATERAL_ACCEL / curvature) : PROFILE_MAX_SPEED;
    if (speed[i] > PROFILE_MAX_SPEED) speed[i] = PROFILE_MAX_SPEED;
  }

  // Light smoothing of the limit itself, so an isolated sample cannot dictate
  // the braking point for the whole approach.
  const smoothed = new Float32Array(n);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {
      smoothed[i] = (speed[mod(i - 1, n)] + speed[i] * 2 + speed[mod(i + 1, n)]) * 0.25;
    }
    speed.set(smoothed);
  }

  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const ahead = speed[mod(i + 1, n)];
      const braked = Math.sqrt(ahead * ahead + 2 * PROFILE_BRAKE * step);
      if (braked < speed[i]) speed[i] = braked;
    }
    for (let i = 0; i < n; i++) {
      const behind = speed[mod(i - 1, n)];
      const accelerated = Math.sqrt(behind * behind + 2 * PROFILE_ACCEL * step);
      if (accelerated < speed[i]) speed[i] = accelerated;
    }
  }
  return speed;
}
