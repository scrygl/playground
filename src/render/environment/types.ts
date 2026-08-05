import type { Object3D, Texture, Vector3, PerspectiveCamera } from 'three';
import type { EnvironmentArchetype, TrackPalette } from '../../track/types';
import type { QualitySettings } from '../../core/quality';

export interface EnvironmentOptions {
  archetype: EnvironmentArchetype;
  palette: TrackPalette;
  seed: string;
  quality: QualitySettings;
  /** Radius of the track's bounding sphere, so scenery can be scaled to fit. */
  trackRadius: number;
  /** Centre of the track bounds in world space. */
  trackCentre: Vector3;
}

export interface EnvironmentFrameState {
  dt: number;
  camera: PerspectiveCamera;
  /** 0..1 musical intensity, for beat-reactive scenery. */
  intensity: number;
  /** 0..1 progress through the current beat, from the audio clock. */
  beatPhase: number;
  /** Integer beat index; changes exactly once per beat. */
  beatIndex: number;
  /** 0..1 normalised player speed, for parallax and streak effects. */
  speed: number;
}

export interface BuiltEnvironment {
  /** Everything to add to the scene. Positioned in world space. */
  root: Object3D;
  /** Assign to `scene.background`. */
  background: Texture | null;
  /** Assign to `scene.environment` for image-based lighting, if generated. */
  envMap: Texture | null;
  /** Suggested key light direction and colour, derived from the sky. */
  keyLight: { direction: Vector3; color: number; intensity: number };
  /** Suggested ambient fill. */
  ambient: { color: number; intensity: number };
  /** Linear fog colour and density chosen to match the sky. */
  fog: { color: number; density: number };
  update(state: EnvironmentFrameState): void;
  dispose(): void;
}
