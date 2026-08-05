import { Quaternion, Vector3, Matrix4 } from 'three';
import type { Track } from '../track/runtime';
import { createFrame } from '../track/path';
import type { PathFrame } from '../track/types';
import type { ShipStats } from './ships';
import { clamp, clamp01, damp, loopDelta, mod, smoothstep } from '../core/mathx';

/**
 * Anti-gravity craft physics, solved entirely in track space.
 *
 * The ship's state is (s, lateral, height) — distance along the centreline,
 * offset across it, and altitude above the surface — plus a heading `yaw`
 * measured *relative to the track tangent*. Gravity points along the track's
 * own down axis rather than the world's.
 *
 * That single decision is what makes the genre work. Through a vertical loop or
 * a corkscrew the surface normal swings all the way round to face the world
 * floor, and none of the code below has to know: cornering, grip, collision and
 * the racing line are all the same maths they were on the opening straight.
 * Solving this in world space would mean special-casing every inversion.
 */

/** Half the hull width, in metres — the collision footprint. */
export const SHIP_HALF_WIDTH = 4.2;
/** Track-space gravity, m/s². Heavier than Earth so landings feel decisive. */
const GRAVITY = 24;
/** Height at which the hover field starts pushing back, in metres. */
const HOVER_RANGE = 3;
/**
 * Ceiling on how far the hover spring is allowed to be compressed.
 *
 * Without this the restoring force scales with depth without limit, so a craft
 * that somehow ends up well below the surface gets flung out at thousands of
 * metres per second squared. Clamping keeps the worst case to a firm shove.
 */
const MAX_HOVER_COMPRESSION = 4.5;
/** Spring rate of the hover field. Equilibrium sits at HOVER_RANGE − GRAVITY/k. */
const HOVER_STIFFNESS = 24;
const HOVER_DAMPING = 7.5;
/** Above this altitude the craft is considered airborne and loses grip. */
const AIRBORNE_HEIGHT = 4.6;
/** Fall this far below the surface and the run is over. */
const FALL_LIMIT = -70;
/** Sideslip beyond this (m/s) counts as a drift for turbo charging. */
const DRIFT_THRESHOLD = 7;
/** Seconds of sustained drift for each mini-turbo tier. */
const TURBO_TIERS = [0.55, 1.15, 1.9];

export interface ControlState {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1 (left) .. 1 (right) */
  steer: number;
  /** 0..1 */
  airbrakeLeft: number;
  /** 0..1 */
  airbrakeRight: number;
  /** Manual boost, burns shield while held. */
  boost: boolean;
  /** -1 (nose down) .. 1 (nose up), only meaningful while airborne. */
  pitch: number;
  useItem: boolean;
}

export function neutralControls(): ControlState {
  return {
    throttle: 0,
    brake: 0,
    steer: 0,
    airbrakeLeft: 0,
    airbrakeRight: 0,
    boost: false,
    pitch: 0,
    useItem: false,
  };
}

export type VehicleEvent =
  | { type: 'wallImpact'; strength: number }
  | { type: 'scrape'; strength: number }
  | { type: 'land'; strength: number }
  | { type: 'takeoff'; strength: number }
  | { type: 'turboCharged'; tier: number }
  | { type: 'turboFired'; tier: number }
  | { type: 'destroyed' }
  | { type: 'respawn' }
  | { type: 'lap'; lap: number };

export interface VehicleInit {
  track: Track;
  stats: ShipStats;
  s: number;
  lateral: number;
  /**
   * Laps already completed. Craft on the starting grid sit *behind* the line
   * and begin at -1, so their first crossing starts lap one rather than
   * finishing it.
   */
  lap?: number;
}

export class Vehicle {
  readonly track: Track;
  readonly stats: ShipStats;

  // --- Track-space state ---
  /** Arc position along the centreline, metres. */
  s = 0;
  /** Offset from the centreline, metres. Positive is to the right. */
  lateral = 0;
  /** Altitude above the surface, metres. */
  height = 2;
  /** Velocity along the track tangent, m/s. */
  velocityAlong = 0;
  /** Velocity across the track, m/s. */
  velocityLateral = 0;
  /** Vertical velocity, m/s. */
  velocityVertical = 0;
  /** Heading relative to the track tangent, radians. Positive points right. */
  yaw = 0;
  yawRate = 0;
  /** Nose attitude, radians. Only controllable while airborne. */
  pitch = 0;

  // --- Status ---
  shield: number;
  /** 0..1 blend of the boost multiplier currently applied. */
  boostAmount = 0;
  boostTimer = 0;
  turboCharge = 0;
  turboTier = 0;
  airborne = false;
  destroyed = false;
  /** Seconds of post-respawn invulnerability remaining. */
  invulnerable = 0;
  /** Laps completed. */
  lap = 0;
  /** Total distance covered, metres — the sort key for race position. */
  progress = 0;
  /** 0..1, how much drag the slipstream of a leading ship is removing. */
  slipstream = 0;
  /** Set by the race director when this craft is shoved by another. */
  private externalLateralImpulse = 0;

  // --- Visual-only state ---
  /** Banking lean, radians. Purely cosmetic but sells the cornering. */
  visualRoll = 0;
  /** 0..1 how hard the craft is sliding, for tyre-smoke-equivalent effects. */
  slip = 0;
  /** Set for the frame a wall is being scraped. */
  wallContact = false;

  readonly events: VehicleEvent[] = [];
  private readonly frame: PathFrame = createFrame();
  private lastCheckpointS = 0;
  private wasAirborne = false;
  private scrapeCooldown = 0;

  constructor(init: VehicleInit) {
    this.track = init.track;
    this.stats = init.stats;
    this.s = init.s;
    this.lateral = init.lateral;
    this.lap = init.lap ?? 0;
    this.shield = init.stats.shield;
    this.progress = this.lap * this.track.path.length + this.s;
    this.track.path.frameAt(this.s, this.frame);
  }

  /** Current speed through the water, so to speak — magnitude in the track plane. */
  get speed(): number {
    return Math.hypot(this.velocityAlong, this.velocityLateral);
  }

  /** 0..1 against this craft's own top speed, for HUD and audio. */
  get normalisedSpeed(): number {
    return clamp01(this.speed / this.stats.topSpeed);
  }

  get shieldFraction(): number {
    return clamp01(this.shield / this.stats.shield);
  }

  get currentFrame(): PathFrame {
    return this.frame;
  }

  /** Applied by the race director for ship-to-ship contact. */
  addLateralImpulse(v: number): void {
    this.externalLateralImpulse += v;
  }

  /** Grants a boost, e.g. from a pad. `seconds` at full strength. */
  applyBoost(seconds: number, strength = 1): void {
    this.boostTimer = Math.max(this.boostTimer, seconds);
    this.boostAmount = Math.max(this.boostAmount, strength);
  }

  damage(amount: number): void {
    if (this.invulnerable > 0) return;
    this.shield -= amount * this.stats.fragility;
    if (this.shield <= 0 && !this.destroyed) {
      this.shield = 0;
      this.destroyed = true;
      this.events.push({ type: 'destroyed' });
    }
  }

  heal(amount: number): void {
    this.shield = Math.min(this.stats.shield, this.shield + amount);
  }

  step(controls: ControlState, dt: number): void {
    if (dt <= 0) return;
    const { stats, track } = this;
    const path = track.path;

    if (this.destroyed) {
      this.respawn();
      return;
    }

    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.scrapeCooldown = Math.max(0, this.scrapeCooldown - dt);
    path.frameAt(this.s, this.frame);

    // --- Resolve the boost multiplier for this step ---------------------
    this.boostTimer = Math.max(0, this.boostTimer - dt);
    let manualBoost = false;
    if (controls.boost && this.shield > 6 && !this.airborne) {
      this.shield = Math.max(0, this.shield - stats.boostDrain * dt);
      manualBoost = true;
      this.boostAmount = Math.min(1, this.boostAmount + dt * 4);
    }
    if (this.boostTimer <= 0 && !manualBoost) {
      // Bleed off rather than cutting, so the end of a boost is a glide.
      this.boostAmount = damp(this.boostAmount, 0, 0.02, dt);
    }
    const boostMul = 1 + (stats.boostPower - 1) * this.boostAmount;

    // --- Decompose velocity into the craft's own frame -------------------
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    let vLong = this.velocityAlong * cos + this.velocityLateral * sin;
    let vLat = -this.velocityAlong * sin + this.velocityLateral * cos;

    // --- Longitudinal forces ---------------------------------------------
    const topSpeed = stats.topSpeed * boostMul;
    // Quadratic drag scaled so full throttle settles exactly at top speed.
    const dragK = (stats.thrust * boostMul) / (topSpeed * topSpeed);
    const slipstreamRelief = 1 - this.slipstream * 0.42;
    const airbrakeTotal = controls.airbrakeLeft + controls.airbrakeRight;

    let longAccel = stats.thrust * boostMul * clamp01(controls.throttle);
    longAccel -= dragK * vLong * Math.abs(vLong) * slipstreamRelief;
    longAccel -= stats.brake * clamp01(controls.brake) * Math.sign(vLong);
    longAccel -= stats.airbrakeDrag * airbrakeTotal * 0.5 * Math.sign(vLong);
    // Thrust cannot push the craft along while it is not touching the track.
    if (this.airborne) longAccel = -dragK * vLong * Math.abs(vLong) * 0.4;
    vLong += longAccel * dt;
    if (vLong < 0) vLong = Math.max(vLong, -28);

    // --- Lateral grip -----------------------------------------------------
    // Sideslip decays exponentially. Airbrakes deliberately break traction —
    // that is the whole point of them — and airborne craft have none at all.
    let grip = stats.grip;
    if (airbrakeTotal > 0) grip *= 1 - 0.45 * clamp01(airbrakeTotal);
    if (this.airborne) grip *= 0.12;
    vLat *= Math.exp(-grip * dt);

    // --- Steering ---------------------------------------------------------
    // Authority fades in from a standstill and tapers at speed, so the craft
    // is controllable off the line without being twitchy on the straight.
    const speedGate = smoothstep(0, 45, Math.abs(vLong));
    const highSpeedTaper = 1 - 0.42 * clamp01(Math.abs(vLong) / stats.topSpeed);
    let targetYawRate = clamp(controls.steer, -1, 1) * stats.turnRate * speedGate * highSpeedTaper;
    targetYawRate += (controls.airbrakeRight - controls.airbrakeLeft) * stats.airbrakeYaw * speedGate;
    this.yawRate = damp(this.yawRate, targetYawRate, 0.0004, dt);
    this.yaw += this.yawRate * dt;

    // --- Recompose into track-frame velocity ------------------------------
    const cos2 = Math.cos(this.yaw);
    const sin2 = Math.sin(this.yaw);
    this.velocityAlong = vLong * cos2 - vLat * sin2;
    this.velocityLateral = vLong * sin2 + vLat * cos2;

    if (this.externalLateralImpulse !== 0) {
      this.velocityLateral += this.externalLateralImpulse;
      this.externalLateralImpulse = 0;
    }

    // --- Integrate along the track ---------------------------------------
    // A craft offset from the centreline covers a different amount of
    // centreline arc than it travels: the inside of a corner is genuinely
    // shorter. Without this the racing line would be worth nothing.
    const curvature = this.frame.curvature;
    const arcScale = clamp(1 - curvature * this.lateral, 0.35, 2.2);
    const ds = (this.velocityAlong * dt) / arcScale;
    const previousS = this.s;
    this.s = path.wrap(this.s + ds);
    this.lateral += this.velocityLateral * dt;

    // The heading is relative to the tangent, and the tangent rotates as we
    // advance through a corner. This is a change of coordinates, not an
    // assist — steering input is untouched.
    this.yaw -= curvature * ds;
    this.yaw = mod(this.yaw + Math.PI, Math.PI * 2) - Math.PI;

    this.trackLap(previousS, ds);

    // --- Vertical: hover suspension and gravity ---------------------------
    // The surface only exists where there is track under the craft. Off the
    // side of an unwalled ledge, or over a gap, there is nothing to hover
    // above and nothing to stand on — which is exactly how falling works.
    const overSurface = !path.isGapAt(this.s) && Math.abs(this.lateral) < this.frame.halfWidth + 2;
    this.velocityVertical -= GRAVITY * dt;
    if (overSurface && this.height < HOVER_RANGE) {
      const compression = Math.min(HOVER_RANGE - this.height, MAX_HOVER_COMPRESSION);
      this.velocityVertical += (compression * HOVER_STIFFNESS - this.velocityVertical * HOVER_DAMPING) * dt;
    }
    this.height += this.velocityVertical * dt;
    if (overSurface && this.height < 0.2) {
      this.height = 0.2;
      if (this.velocityVertical < 0) this.velocityVertical *= -0.15;
    }

    this.wasAirborne = this.airborne;
    this.airborne = !overSurface || this.height > AIRBORNE_HEIGHT;
    if (this.airborne && !this.wasAirborne) {
      this.events.push({ type: 'takeoff', strength: clamp01(this.velocityVertical / 14) });
    } else if (!this.airborne && this.wasAirborne) {
      const impact = clamp01(-this.velocityVertical / 26);
      this.events.push({ type: 'land', strength: impact });
      // A heavy landing costs speed; a feathered one costs nothing.
      this.velocityAlong *= 1 - impact * 0.16;
      if (impact > 0.72) this.damage(impact * 13);
    }

    // Pitch: steerable in the air, self-levelling once the field re-engages.
    if (this.airborne) {
      this.pitch = clamp(this.pitch + controls.pitch * this.stats.pitchRate * dt, -0.85, 0.85);
    } else {
      this.pitch = damp(this.pitch, 0, 0.001, dt);
    }

    this.resolveEdges(dt);
    this.updateTurbo(controls, vLat, dt);

    if (!manualBoost && this.shield < stats.shield) {
      this.shield = Math.min(stats.shield, this.shield + stats.shieldRegen * dt);
    }

    if (this.height < FALL_LIMIT) {
      this.destroyed = true;
      this.events.push({ type: 'destroyed' });
    }

    // --- Visual state ------------------------------------------------------
    this.slip = clamp01(Math.abs(vLat) / 26);
    const leanTarget =
      -clamp(controls.steer, -1, 1) * 0.42 -
      clamp(vLat / 30, -1, 1) * 0.3 +
      (controls.airbrakeRight - controls.airbrakeLeft) * 0.22;
    this.visualRoll = damp(this.visualRoll, leanTarget, 0.0006, dt);

    this.progress = this.lap * path.length + this.s;
  }

  /**
   * Lap counting by signed movement across the start line.
   *
   * Comparing raw `s` values would miscount the instant a craft nudges
   * backwards over the line, so this tests the direction of travel too.
   */
  private trackLap(previousS: number, ds: number): void {
    const length = this.track.path.length;
    const crossed = loopDelta(previousS, this.s, length);
    if (ds > 0 && previousS > length * 0.75 && this.s < length * 0.25 && crossed > 0) {
      this.lap++;
      this.events.push({ type: 'lap', lap: this.lap });
    } else if (ds < 0 && previousS < length * 0.25 && this.s > length * 0.75) {
      // Reversing back over the line un-counts the lap. The floor is -1, not
      // 0, because that is the legitimate pre-start state.
      this.lap = Math.max(-1, this.lap - 1);
    }
  }

  /**
   * Walls, ledges, and falling off.
   *
   * A track's `wall` value is a continuous 0..1, so the same code handles a
   * tunnel that contains you completely and a Rainbow-Road ledge that does not
   * catch you at all.
   */
  private resolveEdges(dt: number): void {
    const limit = this.frame.halfWidth - SHIP_HALF_WIDTH;
    const over = Math.abs(this.lateral) - limit;
    if (over <= 0) {
      this.wallContact = false;
      return;
    }

    const side = Math.sign(this.lateral);
    const wall = this.frame.wall;

    if (wall < 0.35) {
      // No guardrail: the craft simply runs out of track and drops.
      this.wallContact = false;
      return;
    }

    this.lateral = side * limit;
    const closingSpeed = Math.abs(this.velocityLateral);
    const glancing = closingSpeed < 12;

    // Restitution is deliberately low. A wall that bounces you across the
    // track is infuriating; a wall that costs you time is a lesson.
    this.velocityLateral = -this.velocityLateral * 0.22 * wall;

    if (glancing) {
      // Scraping: bleed speed continuously and chirp occasionally.
      this.velocityAlong *= 1 - 1.5 * dt * wall;
      this.wallContact = true;
      if (this.scrapeCooldown <= 0) {
        this.events.push({ type: 'scrape', strength: clamp01(this.speed / this.stats.topSpeed) });
        this.scrapeCooldown = 0.18;
      }
      this.damage(6 * dt * wall);
    } else {
      const strength = clamp01(closingSpeed / 34);
      this.velocityAlong *= 1 - strength * 0.3;
      // Deflect the nose away from the wall so the craft slides along it
      // rather than burying itself and stopping dead.
      this.yaw -= side * strength * 0.25;
      this.damage(strength * 22 * wall);
      this.events.push({ type: 'wallImpact', strength });
      this.wallContact = true;
    }
  }

  /**
   * Mini-turbo: hold a slide, get a burst on exit.
   *
   * Charging requires genuine sideslip rather than just a held steering input,
   * so it rewards committing to a drift instead of wiggling the stick.
   */
  private updateTurbo(controls: ControlState, sideslip: number, dt: number): void {
    const drifting =
      !this.airborne &&
      Math.abs(sideslip) > DRIFT_THRESHOLD &&
      (Math.abs(controls.steer) > 0.45 || controls.airbrakeLeft > 0.4 || controls.airbrakeRight > 0.4);

    if (drifting) {
      const before = this.turboTier;
      this.turboCharge += dt;
      this.turboTier = TURBO_TIERS.filter((t) => this.turboCharge >= t).length;
      if (this.turboTier > before) this.events.push({ type: 'turboCharged', tier: this.turboTier });
    } else if (this.turboCharge > 0) {
      if (this.turboTier > 0) {
        this.applyBoost(0.45 + this.turboTier * 0.42, 0.55 + this.turboTier * 0.15);
        this.events.push({ type: 'turboFired', tier: this.turboTier });
      }
      this.turboCharge = 0;
      this.turboTier = 0;
    }
  }

  /** Puts the craft back on the track after a fall or a destruction. */
  respawn(): void {
    const path = this.track.path;
    const target = this.track.safeRespawn(Math.max(this.lastCheckpointS, this.s - 30));
    this.s = target;
    this.lateral = clamp(this.track.racingLineAt(target), -8, 8);
    this.height = 2.4;
    this.yaw = 0;
    this.yawRate = 0;
    this.pitch = 0;
    this.velocityLateral = 0;
    this.velocityVertical = 0;
    // Restart with enough speed to be driving rather than crawling, but slow
    // enough that dying is a real cost.
    this.velocityAlong = Math.min(this.velocityAlong * 0.35, this.stats.topSpeed * 0.28);
    this.shield = this.stats.shield * 0.6;
    this.destroyed = false;
    this.invulnerable = 2.2;
    this.boostAmount = 0;
    this.boostTimer = 0;
    this.turboCharge = 0;
    this.turboTier = 0;
    this.progress = this.lap * path.length + this.s;
    this.events.push({ type: 'respawn' });
  }

  /** Records the last checkpoint passed, used as the respawn anchor. */
  noteCheckpoint(s: number): void {
    this.lastCheckpointS = s;
  }

  /** World-space transform for rendering. */
  writeTransform(position: Vector3, quaternion: Quaternion): void {
    const frame = this.frame;
    this.track.path.toWorld(this.s, this.lateral, this.height, position);

    // Build the track basis, then apply the craft's own yaw/pitch/roll on top.
    _basis.makeBasis(frame.right, frame.up, _forward.copy(frame.tangent).negate());
    _trackQuat.setFromRotationMatrix(_basis);

    _yawQuat.setFromAxisAngle(_up, -this.yaw);
    _pitchQuat.setFromAxisAngle(_right, this.pitch);
    _rollQuat.setFromAxisAngle(_forwardAxis, this.visualRoll);

    quaternion.copy(_trackQuat).multiply(_yawQuat).multiply(_pitchQuat).multiply(_rollQuat);
  }

  /** Direction the craft is actually travelling, in world space. */
  writeVelocityDirection(out: Vector3): Vector3 {
    return out
      .copy(this.frame.tangent)
      .multiplyScalar(this.velocityAlong)
      .addScaledVector(this.frame.right, this.velocityLateral)
      .addScaledVector(this.frame.up, this.velocityVertical)
      .normalize();
  }

  drainEvents(sink: VehicleEvent[]): void {
    for (const e of this.events) sink.push(e);
    this.events.length = 0;
  }
}

const _basis = new Matrix4();
const _forward = new Vector3();
const _trackQuat = new Quaternion();
const _yawQuat = new Quaternion();
const _pitchQuat = new Quaternion();
const _rollQuat = new Quaternion();
const _up = new Vector3(0, 1, 0);
const _right = new Vector3(1, 0, 0);
const _forwardAxis = new Vector3(0, 0, 1);
