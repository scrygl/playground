import * as THREE from 'three/webgpu';
import { Quaternion, Vector3 } from 'three';
import type { Track } from '../track/runtime';
import type { TrackDefinition } from '../track/types';
import type { QualitySettings } from '../core/quality';
import { buildTrackMesh, type BuiltTrackMesh } from '../render/track-mesh';
import { createEnvironment } from '../render/environment';
import type { BuiltEnvironment } from '../render/environment/types';
import { createFeatureVisuals } from '../render/feature-mesh';
import type { FeatureVisuals, ShipVisual, ShipVisualState } from '../render/types';
import { createShipVisual } from '../render/ship-mesh';
import { createShipTrail, type ShipTrail } from '../render/trail';
import {
  createParticleSystem,
  emitBoostBurst,
  emitEngineSparks,
  emitExplosion,
  emitLandingDust,
  emitWallSparks,
  type ParticleSystem,
} from '../render/particles';
import { getShip } from './ships';
import type { Racer } from './race';
import { clamp01 } from '../core/mathx';

/**
 * Everything visible for one race: the circuit, its sky, its furniture, and one
 * visual per craft.
 *
 * The world is built once when a race loads and thrown away when it ends. It
 * knows how to draw the simulation but never how to run it — the race director
 * hands it transforms and it turns them into pixels, which is what keeps the
 * whole simulation testable in Node with no renderer present.
 */

export interface WorldFrameState {
  dt: number;
  elapsed: number;
  /** 0..1 envelope spiking on each musical beat. */
  beatPulse: number;
  beatPhase: number;
  beatIndex: number;
  /** 0..1 musical intensity. */
  intensity: number;
  cameraPosition: Vector3;
  /** The player's distance along the circuit. */
  playerDistance: number;
  /**
   * Index of the player's craft in the racer list.
   *
   * The player starts at the *back* of the grid, so this is emphatically not
   * zero — anything that wants "the player" and reaches for `racers[0]` is
   * reading whichever rival happens to be on pole.
   */
  playerIndex: number;
  /** 0..1 how hard the player is boosting. */
  playerBoost: number;
  /** 0..1 the player's speed against their craft's top speed. */
  playerSpeed: number;
}

interface ShipSlot {
  visual: ShipVisual;
  trail: ShipTrail;
  position: Vector3;
  quaternion: Quaternion;
  state: ShipVisualState;
  /** Decays after a hit, driving the hull flash. */
  damageFlash: number;
  engineTint: number;
}

export class World {
  readonly group = new THREE.Group();
  readonly track: Track;

  private readonly trackMesh: BuiltTrackMesh;
  private readonly environment: BuiltEnvironment;
  private readonly features: FeatureVisuals;
  private readonly particles: ParticleSystem;
  private readonly ships: ShipSlot[] = [];
  private ghost: ShipSlot | null = null;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly ambient: THREE.AmbientLight;

  private readonly scratchPosition = new Vector3();
  private readonly scratchQuaternion = new Quaternion();
  private readonly scratchVector = new Vector3();
  private readonly scratchBackward = new Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    track: Track,
    definition: TrackDefinition,
    quality: QualitySettings,
    racers: Racer[],
    withGhost: boolean,
  ) {
    this.track = track;
    this.group.name = 'world';

    this.trackMesh = buildTrackMesh(track, definition.palette, quality, definition.iridescent);
    this.group.add(this.trackMesh.group);

    this.environment = createEnvironment({
      archetype: definition.environment,
      palette: definition.palette,
      seed: definition.seed,
      quality,
      trackRadius: track.radius,
      trackCentre: track.centre,
    });
    this.group.add(this.environment.root);

    this.features = createFeatureVisuals(track, { palette: definition.palette, quality });
    this.group.add(this.features.object);

    this.particles = createParticleSystem({ quality, seed: definition.seed });
    this.group.add(this.particles.object);

    for (const racer of racers) {
      this.ships.push(this.createSlot(racer.shipId, quality, racer.isPlayer, false));
    }
    if (withGhost) {
      this.ghost = this.createSlot(racers[0]?.shipId ?? 'kestrel', quality, false, true);
    }

    // Lighting is derived from the sky that was actually generated, so the key
    // direction matches the visible sun rather than being authored separately.
    this.keyLight = new THREE.DirectionalLight(
      this.environment.keyLight.color,
      this.environment.keyLight.intensity,
    );
    this.keyLight.position.copy(this.environment.keyLight.direction).multiplyScalar(900).add(track.centre);
    this.keyLight.target.position.copy(track.centre);
    this.group.add(this.keyLight, this.keyLight.target);

    this.ambient = new THREE.AmbientLight(this.environment.ambient.color, this.environment.ambient.intensity);
    this.group.add(this.ambient);

    scene.add(this.group);
    scene.background = this.environment.background;
    scene.environment = this.environment.envMap;
    scene.fog = new THREE.FogExp2(this.environment.fog.color, this.environment.fog.density);
  }

  private createSlot(shipId: string, quality: QualitySettings, isPlayer: boolean, isGhost: boolean): ShipSlot {
    const colors = getShip(shipId).colors;
    const visual = createShipVisual({ colors, quality, isPlayer, isGhost });
    const trail = createShipTrail({ quality, color: colors.engine });
    this.group.add(visual.object, trail.object);
    return {
      visual,
      trail,
      position: new Vector3(),
      quaternion: new Quaternion(),
      damageFlash: 0,
      engineTint: colors.engine,
      state: {
        dt: 0,
        position: new Vector3(),
        quaternion: new Quaternion(),
        speedFraction: 0,
        boost: 0,
        slip: 0,
        shieldFraction: 1,
        damageFlash: 0,
        airborne: false,
        turboTier: 0,
        invulnerable: false,
        beatPulse: 0,
        wallContact: false,
        ghostAlpha: isGhost ? 0.42 : 1,
      },
    };
  }

  /** Pushes one frame of simulation state into the visuals. */
  update(racers: Racer[], frame: WorldFrameState): void {
    for (let i = 0; i < racers.length && i < this.ships.length; i++) {
      const racer = racers[i];
      const slot = this.ships[i];
      const vehicle = racer.vehicle;

      vehicle.writeTransform(slot.position, slot.quaternion);
      slot.damageFlash = Math.max(0, slot.damageFlash - frame.dt * 3.5);

      const state = slot.state;
      state.dt = frame.dt;
      state.position.copy(slot.position);
      state.quaternion.copy(slot.quaternion);
      state.speedFraction = vehicle.normalisedSpeed;
      state.boost = vehicle.boostAmount;
      state.slip = vehicle.slip;
      state.shieldFraction = vehicle.shieldFraction;
      state.damageFlash = slot.damageFlash;
      state.airborne = vehicle.airborne;
      state.turboTier = vehicle.turboTier;
      state.invulnerable = vehicle.invulnerable > 0;
      state.beatPulse = frame.beatPulse;
      state.wallContact = vehicle.wallContact;

      // An eliminated craft is off the board; hide it rather than leaving a
      // ghost of it drifting round the circuit.
      slot.visual.object.visible = !racer.eliminated;
      slot.trail.object.visible = !racer.eliminated;
      if (racer.eliminated) continue;

      slot.visual.update(state);
      slot.trail.update({
        dt: frame.dt,
        position: slot.position,
        quaternion: slot.quaternion,
        speedFraction: state.speedFraction,
        boost: state.boost,
        cameraPosition: frame.cameraPosition,
      });

      // Engine sparks only for craft near the camera; a full grid emitting at
      // range would spend the whole particle budget on specks two hundred
      // metres away.
      if (this.particles.budget > 0 && state.speedFraction > 0.25) {
        const distance = slot.position.distanceTo(frame.cameraPosition);
        if (distance < 220) {
          this.scratchBackward.set(0, 0, 1).applyQuaternion(slot.quaternion);
          vehicle.writeVelocityDirection(this.scratchVector).multiplyScalar(vehicle.speed);
          emitEngineSparks(
            this.particles,
            slot.position,
            this.scratchBackward,
            this.scratchVector,
            slot.engineTint,
            state.speedFraction * (0.35 + state.boost),
            frame.dt,
          );
        }
      }
    }

    this.features.update({
      dt: frame.dt,
      beatPhase: frame.beatPhase,
      beatIndex: frame.beatIndex,
      playerDistance: frame.playerDistance,
      intensity: frame.intensity,
    });

    this.particles.update(frame.dt);

    this.trackMesh.uniforms.beatPulse.value = frame.beatPulse;
    this.trackMesh.uniforms.intensity.value = frame.intensity;
    this.trackMesh.uniforms.playerDistance.value = frame.playerDistance;
    this.trackMesh.uniforms.boostGlow.value = clamp01(frame.playerBoost);

    if (this.camera) {
      this.environment.update({
        dt: frame.dt,
        camera: this.camera,
        intensity: frame.intensity,
        beatPhase: frame.beatPhase,
        beatIndex: frame.beatIndex,
        speed: frame.playerSpeed,
      });
    }
  }

  /** The environment needs the live camera; the app supplies it once. */
  private camera: THREE.PerspectiveCamera | null = null;
  setCamera(camera: THREE.PerspectiveCamera): void {
    this.camera = camera;
  }

  /** Places the ghost replay craft, or hides it. */
  updateGhost(pose: { s: number; lateral: number; height: number; yaw: number; roll: number; pitch: number } | null, frame: WorldFrameState): void {
    if (!this.ghost) return;
    if (!pose) {
      this.ghost.visual.object.visible = false;
      this.ghost.trail.object.visible = false;
      return;
    }
    this.ghost.visual.object.visible = true;

    const path = this.track.path;
    path.toWorld(pose.s, pose.lateral, pose.height, this.scratchPosition);
    const f = path.sample(pose.s);
    _basis.makeBasis(f.right, f.up, this.scratchVector.copy(f.tangent).negate());
    this.scratchQuaternion.setFromRotationMatrix(_basis);
    _yaw.setFromAxisAngle(_upAxis, -pose.yaw);
    _roll.setFromAxisAngle(_forwardAxis, pose.roll);
    this.scratchQuaternion.multiply(_yaw).multiply(_roll);

    const state = this.ghost.state;
    state.dt = frame.dt;
    state.position.copy(this.scratchPosition);
    state.quaternion.copy(this.scratchQuaternion);
    state.beatPulse = frame.beatPulse;
    state.speedFraction = 0.7;
    this.ghost.visual.update(state);
  }

  // --- Effect triggers, called from race events ---------------------------

  wallImpact(racerIndex: number, strength: number, dt: number): void {
    const slot = this.ships[racerIndex];
    if (!slot) return;
    slot.damageFlash = Math.max(slot.damageFlash, strength);
    if (this.particles.budget === 0) return;
    // Sparks fly off the barrier along the hull's side, carried forward by
    // whatever the craft was doing when it made contact.
    this.scratchVector.set(1, 0, 0).applyQuaternion(slot.quaternion);
    this.scratchBackward.set(0, 0, -1).applyQuaternion(slot.quaternion).multiplyScalar(strength * 40);
    emitWallSparks(this.particles, slot.position, this.scratchVector, this.scratchBackward, dt);
  }

  boostPad(racerIndex: number): void {
    const slot = this.ships[racerIndex];
    if (!slot || this.particles.budget === 0) return;
    this.scratchVector.set(0, 0, -1).applyQuaternion(slot.quaternion);
    emitBoostBurst(this.particles, slot.position, this.scratchVector, slot.engineTint);
  }

  land(racerIndex: number, strength: number): void {
    const slot = this.ships[racerIndex];
    if (!slot || this.particles.budget === 0) return;
    this.scratchVector.set(0, 1, 0).applyQuaternion(slot.quaternion);
    emitLandingDust(this.particles, slot.position, this.scratchVector, strength, slot.engineTint);
  }

  destroyed(racerIndex: number): void {
    const slot = this.ships[racerIndex];
    if (!slot) return;
    slot.visual.explode();
    if (this.particles.budget > 0) emitExplosion(this.particles, slot.position, slot.engineTint);
  }

  gateHit(featureIndex: number, perfect: boolean): void {
    this.features.hitGate(featureIndex, perfect);
  }

  pickupTaken(featureIndex: number, respawnSeconds: number): void {
    this.features.consume(featureIndex, respawnSeconds);
  }

  respawn(racerIndex: number): void {
    this.ships[racerIndex]?.trail.reset();
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.scene.background = null;
    this.scene.environment = null;
    this.scene.fog = null;
    for (const slot of this.ships) {
      slot.visual.dispose();
      slot.trail.dispose();
    }
    this.ghost?.visual.dispose();
    this.ghost?.trail.dispose();
    this.ships.length = 0;
    this.ghost = null;
    this.features.dispose();
    this.particles.dispose();
    this.trackMesh.dispose();
    this.environment.dispose();
    this.group.clear();
  }
}

const _basis = new THREE.Matrix4();
const _yaw = new Quaternion();
const _roll = new Quaternion();
const _upAxis = new Vector3(0, 1, 0);
const _forwardAxis = new Vector3(0, 0, 1);
