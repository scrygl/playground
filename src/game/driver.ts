import { Vector3 } from 'three';
import type { Track } from '../track/runtime';
import type { ControlState } from './vehicle';
import { Vehicle, neutralControls } from './vehicle';
import { clamp, clamp01, smoothstep } from '../core/mathx';
import { Rng } from '../core/rng';

/**
 * The computer-controlled driver.
 *
 * Pure pursuit against the precomputed racing line, with a separate speed
 * controller reading the precomputed speed profile. Doing the geometry in world
 * space and then projecting the result back into the craft's own frame means
 * corner curvature is handled implicitly — there is no special case for a
 * corkscrew, because "aim at the point forty metres ahead on the line" is still
 * exactly the right instruction when the track is upside down.
 *
 * `skill` scales how close the driver runs to the physical limit, how early it
 * brakes, and how much noise is added to its inputs. A low-skill driver is not
 * a cheating driver — it drives the same line, just worse.
 */

export interface DriverOptions {
  /** 0 (novice) .. 1 (perfect). */
  skill: number;
  /** Deterministic per-driver variation. */
  seed: string;
  /** Personality: >0 favours the inside line and late braking. */
  aggression?: number;
}

export class Driver {
  private readonly controls = neutralControls();
  private readonly rng: Rng;
  private readonly aggression: number;
  private noisePhase: number;
  /** Lateral bias, so a pack of AI cars does not drive in single file. */
  private lineBias = 0;
  private recoverTimer = 0;

  constructor(
    private readonly track: Track,
    private readonly options: DriverOptions,
  ) {
    this.rng = new Rng(options.seed);
    this.aggression = options.aggression ?? this.rng.range(-0.35, 0.6);
    this.noisePhase = this.rng.range(0, 100);
    this.lineBias = this.rng.range(-0.28, 0.28);
  }

  update(vehicle: Vehicle, dt: number, blockedAhead = 0): ControlState {
    const { track } = this;
    const path = track.path;
    const c = this.controls;
    const skill = clamp01(this.options.skill);
    this.noisePhase += dt;

    const speed = Math.max(vehicle.speed, 1);

    // --- Aim point -------------------------------------------------------
    // Lookahead scales with speed: about half a second of travel, floored so
    // the craft still has something to aim at when crawling out of a spin.
    const lookahead = clamp(speed * 0.55, 26, 95);
    const targetS = vehicle.s + lookahead;
    // Blend the ideal line toward the centre for weaker drivers, and offset it
    // slightly per driver so the field spreads across the track.
    const idealLateral = track.racingLineAt(targetS);
    const halfWidth = path.halfWidthAt(targetS);
    const usableWidth = Math.max(0, halfWidth - 6);
    let targetLateral = idealLateral * (0.55 + 0.45 * skill);
    targetLateral += this.lineBias * usableWidth * (1 - skill * 0.4);
    // Swing wide of a craft directly ahead rather than driving into its back.
    if (blockedAhead !== 0) targetLateral += blockedAhead * usableWidth * 0.55;
    targetLateral = clamp(targetLateral, -usableWidth, usableWidth);

    path.toWorld(vehicle.s, vehicle.lateral, 0, _here);
    path.toWorld(targetS, targetLateral, 0, _aim);
    _dir.subVectors(_aim, _here);
    if (_dir.lengthSq() < 1e-6) _dir.copy(vehicle.currentFrame.tangent);
    _dir.normalize();

    // Project the aim direction into the craft's frame to get a heading error.
    const frame = vehicle.currentFrame;
    const along = _dir.dot(frame.tangent);
    const across = _dir.dot(frame.right);
    const desiredYaw = Math.atan2(across, along);
    let yawError = desiredYaw - vehicle.yaw;
    while (yawError > Math.PI) yawError -= Math.PI * 2;
    while (yawError < -Math.PI) yawError += Math.PI * 2;

    // Steering noise gives each driver a human-looking wobble; it shrinks to
    // nothing at the top skill level.
    const noise = Math.sin(this.noisePhase * 2.7 + this.rng.next() * 0.001) * (1 - skill) * 0.09;
    c.steer = clamp(yawError * 2.6 + noise, -1, 1);

    // --- Speed control ----------------------------------------------------
    // Braking distance from the real deceleration figure, widened for weaker
    // drivers so they brake absurdly early rather than crashing.
    const brakeDistance = (speed * speed) / (2 * vehicle.stats.brake) + 18;
    const margin = 1 + (1 - skill) * 0.85 + Math.max(0, -this.aggression) * 0.3;
    const cornerSpeed = track.minSpeedAhead(vehicle.s, brakeDistance * margin);
    const limit = Math.min(vehicle.stats.topSpeed, cornerSpeed) * (0.78 + 0.22 * skill);

    if (speed > limit * 1.04) {
      c.throttle = 0;
      c.brake = clamp01((speed - limit) / 26);
    } else {
      c.brake = 0;
      c.throttle = clamp01((limit - speed) / 8 + 0.35);
    }

    // --- Airbrakes --------------------------------------------------------
    // Used when the steering axis alone cannot rotate the craft fast enough,
    // which is exactly the situation a human uses them for.
    const needed = Math.abs(yawError);
    const airbrakeGate = smoothstep(0.16, 0.5, needed) * smoothstep(30, 60, speed) * skill;
    c.airbrakeLeft = yawError < 0 ? airbrakeGate : 0;
    c.airbrakeRight = yawError > 0 ? airbrakeGate : 0;

    // --- Boost ------------------------------------------------------------
    // Only worth spending where it will not be immediately braked away.
    const straightAhead = track.minSpeedAhead(vehicle.s, 220) > vehicle.stats.topSpeed * 0.86;
    c.boost =
      skill > 0.4 &&
      straightAhead &&
      vehicle.shieldFraction > 0.55 + (1 - this.aggression) * 0.1 &&
      speed > vehicle.stats.topSpeed * 0.55;

    // --- Recovery ---------------------------------------------------------
    // Facing the wrong way or stopped against a wall: back off and re-aim.
    if (Math.abs(yawError) > 1.4 || speed < 8) {
      this.recoverTimer += dt;
    } else {
      this.recoverTimer = 0;
    }
    if (this.recoverTimer > 1.2) {
      c.throttle = 0.45;
      c.brake = 0;
      c.boost = false;
      c.steer = clamp(yawError * 3.5, -1, 1);
    }

    c.pitch = vehicle.airborne ? clamp(-vehicle.pitch * 2.5, -1, 1) : 0;
    c.useItem = false;
    return c;
  }
}

const _here = new Vector3();
const _aim = new Vector3();
const _dir = new Vector3();
