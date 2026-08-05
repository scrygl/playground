import type { Vector3 } from 'three';

/**
 * Tracks are authored as a list of driving instructions rather than raw 3D
 * points. A cursor walks the list carrying a full orientation frame, so a
 * corkscrew or a vertical loop is just "roll while advancing" — the geometry
 * and the ship's notion of "down" stay consistent through any inversion.
 */
/** Modifiers every segment accepts, controlling the surface rather than the path. */
export interface SegmentSurface {
  /** Multiplies the track's base half-width over this segment. */
  width?: number;
  /**
   * 0 drops the guardrails entirely (fall off the edge), 1 is a full containing
   * wall. Rainbow-Road-style sections live at 0; tunnels live at 1.
   */
  wall?: number;
}

export type TrackSegment = SegmentSurface &
  (
    /** Travel forward. `rise` bends the path upward (or down) over its length. */
    | { kind: 'straight'; length: number; rise?: number }
    /** Arc left (negative angle) or right (positive) about the current up axis. */
    | { kind: 'turn'; angle: number; radius: number; bank?: number }
    /** Pitch the path up or down about the current right axis, following terrain. */
    | { kind: 'pitch'; angle: number; radius: number }
    /** Bank the surface without changing heading — sets up an off-camber section. */
    | { kind: 'roll'; angle: number; length: number }
    /** A full vertical loop, Rainbow-Road style. */
    | { kind: 'loop'; radius: number; direction?: 1 | -1 }
    /** Travel forward while rolling `turns` full rotations about the path. */
    | { kind: 'corkscrew'; length: number; turns: number }
    /** A gap the ship must jump. Emits no surface; used for big air moments. */
    | { kind: 'gap'; length: number }
    /** Bend heading and pitch simultaneously — a banked climbing sweeper. */
    | { kind: 'helix'; angle: number; radius: number; rise: number; bank?: number }
  );

/** Things placed along the track that the race actually interacts with. */
export type FeatureKind =
  | 'boost'
  | 'beatgate'
  | 'shield'
  | 'weapon'
  | 'hazard'
  | 'checkpoint';

export interface TrackFeature {
  kind: FeatureKind;
  /** Distance along the centreline, in metres. */
  s: number;
  /** Lateral offset from the centreline, normalised to [-1, 1] of half-width. */
  lateral: number;
  /** Fraction of the track half-width this feature covers. */
  size: number;
  /** For beat gates: which beat of the music bar this one belongs to. */
  beat?: number;
}

/** A control point on the centreline, carrying its own surface orientation. */
export interface ControlPoint {
  position: Vector3;
  /** Surface normal — the direction the ship's roof points. Survives inversions. */
  up: Vector3;
  /** Half-width of the driveable surface at this point, in metres. */
  halfWidth: number;
  /** 0 = open ledge, 1 = full containing wall. Lets a track drop its guardrails. */
  wall: number;
  /** True where the surface is absent entirely (a jump gap). */
  gap: boolean;
}

/** Visual identity for a track — drives sky, lighting, materials and grading. */
export interface TrackPalette {
  /** Primary track energy colour. */
  primary: number;
  /** Secondary/accent, used on rails and rim light. */
  secondary: number;
  /** Deep background tint of the nebula. */
  deep: number;
  /** Bright nebula highlight. */
  glow: number;
  /** Colour of the dominant key light. */
  sun: number;
  /** Fog / atmospheric scattering tint. */
  haze: number;
}

export type EnvironmentArchetype =
  | 'nebula'
  | 'megastructure'
  | 'prismatic'
  | 'starfield'
  | 'ringworld'
  | 'void';

export interface MusicProfile {
  bpm: number;
  /** Root note as a MIDI number. */
  root: number;
  scale: 'minor' | 'phrygian' | 'dorian' | 'harmonicMinor' | 'majorPent' | 'minorPent';
  /** 0 = sparse and atmospheric, 1 = relentless. Drives arrangement density. */
  intensity: number;
}

export interface TrackDefinition {
  id: string;
  name: string;
  /** Short evocative subtitle shown in track select. */
  tagline: string;
  seed: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  laps: number;
  segments: TrackSegment[];
  palette: TrackPalette;
  environment: EnvironmentArchetype;
  music: MusicProfile;
  /** Base half-width in metres; segments scale from this. */
  halfWidth: number;
  /**
   * Cycles the surface and rails through the spectrum along the circuit.
   *
   * A palette with a white primary has nothing to say on its own; this is what
   * turns one into an actual rainbow road rather than a pale grey ribbon.
   */
  iridescent?: boolean;
  /**
   * Optional per-track nudge to the medal thresholds.
   *
   * Medal times are derived at load from the track's own computed speed
   * profile — the time a perfect lap of the ideal line would take — multiplied
   * by a fixed set of skill factors. Deriving rather than authoring them means
   * a geometry tweak can never silently make a gold medal unobtainable, and a
   * new track needs no lap-time guessing at all. Values here scale the derived
   * thresholds if a particular circuit wants to be stingier or kinder.
   */
  medalScale?: number;
  /** Tracks the player must beat before this unlocks. */
  requires?: string[];
}

/** One resolved sample of the centreline. All vectors are unit length. */
export interface PathFrame {
  s: number;
  position: Vector3;
  tangent: Vector3;
  up: Vector3;
  right: Vector3;
  halfWidth: number;
  wall: number;
  gap: boolean;
  /** Signed horizontal curvature, positive turning right. 1/metres. */
  curvature: number;
}
