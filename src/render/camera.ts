import { PerspectiveCamera, Quaternion, Vector3, Matrix4 } from 'three';
import type { Track } from '../track/runtime';
import type { Vehicle } from '../game/vehicle';
import { createFrame } from '../track/path';
import type { PathFrame } from '../track/types';
import { clamp, clamp01, damp, dampHalflife, lerp } from '../core/mathx';

/**
 * The chase camera, positioned in track space rather than world space.
 *
 * A conventional spring camera anchored behind the craft in world space falls
 * apart the moment the track inverts: entering a loop it either whips through
 * the geometry or fights its own up-vector until the horizon rolls. Placing the
 * camera at "thirty metres back along the centreline, eight metres up from the
 * surface" instead makes it follow a corkscrew as naturally as a straight,
 * because back and up are defined by the track at that point.
 *
 * Everything the camera does is then smoothing in that space — which stays well
 * behaved through any geometry the builder can produce.
 */

export type CameraMode = 'chase' | 'close' | 'cockpit';

interface ShakeSource {
  amplitude: number;
  frequency: number;
  time: number;
  duration: number;
}

const VIEW_PRESETS: Record<CameraMode, { distance: number; height: number; lookAhead: number; fovBias: number }> = {
  chase: { distance: 15.5, height: 5.4, lookAhead: 34, fovBias: 0 },
  close: { distance: 9.5, height: 3.6, lookAhead: 30, fovBias: 3 },
  cockpit: { distance: -0.6, height: 1.5, lookAhead: 42, fovBias: 6 },
};

export interface CameraOptions {
  baseFov: number;
  /** 0..1 scales all shake; players who dislike it can turn it off entirely. */
  shakeScale: number;
  reducedMotion: boolean;
}

export class ChaseCamera {
  readonly camera: PerspectiveCamera;
  mode: CameraMode = 'chase';

  private options: CameraOptions;
  private readonly frame: PathFrame = createFrame();

  // Track-space state, smoothed toward the ideal follow point.
  private camS = 0;
  private camLateral = 0;
  private camHeight = 6;
  private initialised = false;

  private readonly up = new Vector3(0, 1, 0);
  private readonly lookTarget = new Vector3();
  private readonly position = new Vector3();
  private readonly shakes: ShakeSource[] = [];
  private readonly shakeOffset = new Vector3();
  private fov: number;
  private lookBackBlend = 0;
  /** Extra pull-back that ramps in with boost, for the sense of acceleration. */
  private boostPull = 0;

  constructor(aspect: number, options: CameraOptions) {
    this.options = options;
    this.fov = options.baseFov;
    this.camera = new PerspectiveCamera(options.baseFov, aspect, 0.35, 12000);
    this.camera.up.set(0, 1, 0);
  }

  configure(options: Partial<CameraOptions>): void {
    this.options = { ...this.options, ...options };
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Jump straight to the ideal follow point, skipping all smoothing. */
  snapTo(track: Track, vehicle: Vehicle): void {
    this.initialised = false;
    this.update(track, vehicle, 1 / 60, false);
  }

  /** Adds a decaying shake. `amplitude` is in metres. */
  addShake(amplitude: number, duration = 0.4, frequency = 26): void {
    if (this.options.reducedMotion || this.options.shakeScale <= 0) return;
    this.shakes.push({
      amplitude: amplitude * this.options.shakeScale,
      frequency,
      time: 0,
      duration,
    });
    // A long race can generate a lot of small impacts; keep the list bounded.
    if (this.shakes.length > 12) this.shakes.shift();
  }

  update(track: Track, vehicle: Vehicle, dt: number, lookingBack: boolean): void {
    const path = track.path;
    const preset = VIEW_PRESETS[this.mode];
    const speedFraction = vehicle.normalisedSpeed;

    // Pull back and raise slightly with speed so the craft shrinks in frame as
    // it accelerates — the cheapest and most effective speed cue there is.
    this.boostPull = damp(this.boostPull, vehicle.boostAmount, 0.02, dt);
    const distance = preset.distance * (1 + speedFraction * 0.22 + this.boostPull * 0.2);
    const height = preset.height * (1 + speedFraction * 0.12);

    this.lookBackBlend = damp(this.lookBackBlend, lookingBack ? 1 : 0, 0.0001, dt);
    const behind = lerp(distance, -distance * 1.15, this.lookBackBlend);

    // The ideal point, in track space.
    const targetS = vehicle.s - behind;
    // Follow the craft across the track, but only partly: tracking lateral
    // movement one-for-one makes the camera feel welded on and kills the sense
    // of the craft moving within the frame.
    const targetLateral = vehicle.lateral * 0.62;
    const targetHeight = Math.max(vehicle.height + height, height * 0.6);

    if (!this.initialised) {
      this.camS = targetS;
      this.camLateral = targetLateral;
      this.camHeight = targetHeight;
      this.initialised = true;
    } else {
      // `s` is smoothed on a shorter half-life than lateral/height: lag along
      // the track reads as rubber-banding, lag across it reads as weight.
      this.camS = targetS + shortestWrap(this.camS - targetS, path.length) * Math.pow(0.0015, dt);
      this.camLateral = dampHalflife(this.camLateral, targetLateral, 0.13, dt);
      this.camHeight = dampHalflife(this.camHeight, targetHeight, 0.1, dt);
    }

    path.frameAt(this.camS, this.frame);
    path.toWorld(this.camS, this.camLateral, this.camHeight, this.position);

    // Up comes from the track, which is what carries the camera through an
    // inversion without the horizon tumbling.
    this.up.lerp(this.frame.up, 1 - Math.pow(0.0005, dt)).normalize();

    // Aim ahead of the craft rather than at it, so corners open up early.
    const aheadDistance = preset.lookAhead * (0.75 + speedFraction * 0.5);
    const aimS = vehicle.s + lerp(aheadDistance, -aheadDistance * 0.6, this.lookBackBlend);
    path.toWorld(aimS, vehicle.lateral * 0.4, vehicle.height + 1.4, this.lookTarget);

    this.applyShake(dt);

    this.camera.position.copy(this.position).add(this.shakeOffset);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.lookTarget);

    // Field of view widens with speed. Kept modest — a big FOV swing is
    // nauseating, and reduced-motion players get none of it.
    const kick = this.options.reducedMotion ? 0 : speedFraction * 7 + vehicle.boostAmount * 6;
    const targetFov = this.options.baseFov + preset.fovBias + kick;
    this.fov = damp(this.fov, targetFov, 0.02, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private applyShake(dt: number): void {
    this.shakeOffset.set(0, 0, 0);
    for (let i = this.shakes.length - 1; i >= 0; i--) {
      const shake = this.shakes[i];
      shake.time += dt;
      if (shake.time >= shake.duration) {
        this.shakes.splice(i, 1);
        continue;
      }
      // Linear decay with a couple of different frequencies per axis, so the
      // motion is not a single visible sine wave.
      const decay = 1 - shake.time / shake.duration;
      const a = shake.amplitude * decay * decay;
      const t = shake.time * shake.frequency;
      this.shakeOffset.x += Math.sin(t * 1.0) * a;
      this.shakeOffset.y += Math.sin(t * 1.37 + 1.1) * a;
      this.shakeOffset.z += Math.sin(t * 0.83 + 2.3) * a * 0.6;
    }
  }

  /** 0..1 how much speed distortion the post chain should apply. */
  speedEffect(vehicle: Vehicle): number {
    if (this.options.reducedMotion) return 0;
    return clamp01(vehicle.normalisedSpeed * 0.7 + vehicle.boostAmount * 0.6);
  }

  cycleMode(): CameraMode {
    const order: CameraMode[] = ['chase', 'close', 'cockpit'];
    this.mode = order[(order.indexOf(this.mode) + 1) % order.length];
    return this.mode;
  }
}

/**
 * A slow orbit used behind menus and for the results screen.
 *
 * Deliberately independent of the chase camera so the menus keep moving while
 * no race is loaded.
 */
export class CinematicCamera {
  readonly camera: PerspectiveCamera;
  private angle = 0;
  private readonly centre = new Vector3();
  private radius = 220;
  private elevation = 60;

  constructor(aspect: number, fov = 55) {
    this.camera = new PerspectiveCamera(fov, aspect, 0.35, 12000);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Frames a track so the whole circuit sits comfortably in shot. */
  frameTrack(track: Track): void {
    this.centre.copy(track.centre);
    this.radius = Math.max(180, track.radius * 1.5);
    this.elevation = Math.max(60, track.radius * 0.55);
  }

  /** Frames a single point, e.g. a craft on the garage turntable. */
  framePoint(point: Vector3, radius: number, elevation: number): void {
    this.centre.copy(point);
    this.radius = radius;
    this.elevation = elevation;
  }

  update(dt: number, speed = 0.04): void {
    this.angle += dt * speed;
    this.camera.position.set(
      this.centre.x + Math.cos(this.angle) * this.radius,
      this.centre.y + this.elevation,
      this.centre.z + Math.sin(this.angle) * this.radius,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.centre);
  }
}

/** Wraps a delta into the shortest signed distance around a closed loop. */
function shortestWrap(delta: number, length: number): number {
  let d = delta % length;
  if (d > length * 0.5) d -= length;
  if (d < -length * 0.5) d += length;
  return d;
}

/** Reusable scratch, so per-frame camera work allocates nothing. */
export const _cameraScratch = { quat: new Quaternion(), matrix: new Matrix4(), vec: new Vector3() };

export function clampFov(fov: number): number {
  return clamp(fov, 55, 110);
}
