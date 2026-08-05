import type { Object3D, Vector3, Quaternion } from 'three';
import type { QualitySettings } from '../core/quality';
import type { TrackPalette } from '../track/types';

/**
 * Contracts for the visual representation of things the simulation owns.
 *
 * Nothing in here may read simulation state directly. The render loop pushes a
 * plain-data state struct in once per frame and the visual decides what to do
 * with it, which keeps the physics testable in Node with no renderer at all.
 */

/** Per-frame inputs for a craft's visual. Written by the render loop; never allocated. */
export interface ShipVisualState {
  dt: number;
  position: Vector3;
  quaternion: Quaternion;
  /** 0..1 against this craft's top speed. */
  speedFraction: number;
  /** 0..1 how much boost is currently applied. */
  boost: number;
  /** 0..1 how hard the craft is sliding sideways. */
  slip: number;
  /** 0..1 remaining shield. */
  shieldFraction: number;
  /** Spikes to 1 when hit, decays — drives a damage flash. */
  damageFlash: number;
  airborne: boolean;
  /** Mini-turbo charge tier, 0..3. */
  turboTier: number;
  /** True during post-respawn invulnerability, for a shield shimmer. */
  invulnerable: boolean;
  /** 0..1 envelope spiking on each musical beat. */
  beatPulse: number;
  /** True while the craft is scraping a barrier, for sparks. */
  wallContact: boolean;
  /** Fades the craft out when it is a ghost replay. */
  ghostAlpha: number;
}

export interface ShipVisual {
  object: Object3D;
  update(state: ShipVisualState): void;
  /** Called when the craft is destroyed, for a one-shot burst. */
  explode(): void;
  dispose(): void;
}

export interface ShipVisualOptions {
  colors: { hull: number; trim: number; engine: number };
  quality: QualitySettings;
  /** The player's craft gets the full effect budget; rivals get less. */
  isPlayer: boolean;
  /** Ghost replays render translucent and without particles. */
  isGhost?: boolean;
}

/** Per-frame inputs for track-side features. */
export interface FeatureVisualState {
  dt: number;
  /** 0..1 progress through the current musical beat. */
  beatPhase: number;
  /** Integer beat index; changes exactly once per beat. */
  beatIndex: number;
  /** The player's distance along the track, for proximity effects. */
  playerDistance: number;
  /** 0..1 musical intensity. */
  intensity: number;
}

export interface FeatureVisuals {
  object: Object3D;
  update(state: FeatureVisualState): void;
  /**
   * Marks a pickup as taken; it should fade out and, for respawning pickups,
   * fade back in after `respawnSeconds`.
   */
  consume(featureIndex: number, respawnSeconds: number): void;
  /** Fires the hit animation for a rhythm gate. */
  hitGate(featureIndex: number, perfect: boolean): void;
  dispose(): void;
}

export interface FeatureVisualOptions {
  palette: TrackPalette;
  quality: QualitySettings;
}
