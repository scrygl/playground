import type { TrackDefinition } from './types';

/**
 * The handcrafted circuit roster.
 *
 * Each recipe is authored so its turn angles sum to 360° and its net elevation
 * change returns to zero — that makes the loop close on itself geometrically,
 * leaving the auto-closer with only a small positional gap to sweep through.
 *
 * The design intent per track is called out in comments, because the segment
 * numbers alone don't say what a corner is *for*.
 */

export const TRACKS: TrackDefinition[] = [
  {
    id: 'neon-meridian',
    name: 'Neon Meridian',
    tagline: 'The opening straight of the whole circuit',
    seed: 'neon-meridian-01',
    difficulty: 1,
    laps: 3,
    halfWidth: 26,
    environment: 'nebula',
    // Teaching track: everything is wide, well-banked, and visible early. There
    // is exactly one place to lose time (the double apex) and no way to fall off.
    segments: [
      { kind: 'straight', length: 380 },
      { kind: 'turn', angle: 90, radius: 200, bank: 20 },
      { kind: 'straight', length: 260 },
      // Double apex: two 45s with a short breath between them, so a player who
      // brakes once and holds a line is rewarded over one who saws at it.
      { kind: 'turn', angle: 45, radius: 180, bank: 18 },
      { kind: 'straight', length: 200, rise: 35 },
      { kind: 'turn', angle: 45, radius: 180, bank: 18 },
      { kind: 'straight', length: 300 },
      { kind: 'turn', angle: 90, radius: 200, bank: 22 },
      { kind: 'straight', length: 340 },
      { kind: 'straight', length: 220, rise: -35 },
      { kind: 'turn', angle: 60, radius: 220, bank: 20 },
      { kind: 'straight', length: 180 },
      { kind: 'turn', angle: 30, radius: 200, bank: 15 },
      { kind: 'straight', length: 260 },
    ],
    palette: {
      primary: 0x35e0ff,
      secondary: 0xff2d75,
      deep: 0x050a1e,
      glow: 0x8ef6ff,
      sun: 0xbfe4ff,
      haze: 0x123055,
    },
    music: { bpm: 128, root: 45, scale: 'minor', intensity: 0.5 },
  },

  {
    id: 'solstice-ring',
    name: 'Solstice Ring',
    tagline: 'Flat out around a dying star',
    seed: 'solstice-ring-02',
    difficulty: 2,
    laps: 3,
    halfWidth: 30,
    environment: 'ringworld',
    // A top-speed track. Huge radii mean the corners are taken at full throttle
    // if — and only if — you commit to the bank early. Punishes lifting.
    segments: [
      { kind: 'straight', length: 520 },
      { kind: 'turn', angle: 55, radius: 320, bank: 26 },
      { kind: 'straight', length: 420 },
      { kind: 'turn', angle: 70, radius: 300, bank: 28 },
      { kind: 'straight', length: 380, rise: 60 },
      { kind: 'helix', angle: 80, radius: 280, rise: 40, bank: 30 },
      { kind: 'straight', length: 460 },
      { kind: 'turn', angle: 65, radius: 310, bank: 26 },
      { kind: 'straight', length: 400, rise: -100 },
      { kind: 'turn', angle: 90, radius: 280, bank: 30 },
      { kind: 'straight', length: 480 },
    ],
    palette: {
      primary: 0xffc24a,
      secondary: 0x4fd2ff,
      deep: 0x1a0d04,
      glow: 0xfff2c4,
      sun: 0xfff0d0,
      haze: 0x5c3612,
    },
    music: { bpm: 126, root: 44, scale: 'dorian', intensity: 0.55 },
    requires: ['neon-meridian'],
  },

  {
    id: 'helix-gate',
    name: 'Helix Gate',
    tagline: 'Two barrel rolls and a climbing sweeper',
    seed: 'helix-gate-03',
    difficulty: 2,
    laps: 3,
    halfWidth: 24,
    environment: 'nebula',
    // Introduces inversion. The corkscrews are on straights so the player only
    // has to deal with one new idea at a time.
    segments: [
      { kind: 'straight', length: 280 },
      { kind: 'turn', angle: 90, radius: 170, bank: 25 },
      { kind: 'straight', length: 120 },
      { kind: 'corkscrew', length: 240, turns: 1, wall: 0.5 },
      { kind: 'straight', length: 160 },
      { kind: 'turn', angle: 90, radius: 150, bank: 30 },
      { kind: 'straight', length: 200, rise: 50 },
      { kind: 'helix', angle: 90, radius: 160, rise: 40, bank: 30 },
      { kind: 'straight', length: 220 },
      { kind: 'turn', angle: 45, radius: 180, bank: 25 },
      { kind: 'corkscrew', length: 200, turns: -1, wall: 0.5 },
      { kind: 'straight', length: 180, rise: -90 },
      { kind: 'turn', angle: 45, radius: 160, bank: 20 },
      { kind: 'straight', length: 240 },
    ],
    palette: {
      primary: 0xff8a1f,
      secondary: 0x27e5c4,
      deep: 0x0d0603,
      glow: 0xffd08a,
      sun: 0xffd9a8,
      haze: 0x3a1c08,
    },
    music: { bpm: 134, root: 43, scale: 'dorian', intensity: 0.6 },
    requires: ['neon-meridian'],
  },

  {
    id: 'ironbound',
    name: 'Ironbound',
    tagline: 'Through the bones of a dead freighter',
    seed: 'ironbound-04',
    difficulty: 3,
    laps: 3,
    halfWidth: 25,
    environment: 'megastructure',
    // Claustrophobic. Narrow walled sections reward precision over bravery;
    // the long back straight gives the shield time to recover.
    segments: [
      { kind: 'straight', length: 300 },
      { kind: 'turn', angle: 90, radius: 160, bank: 20 },
      { kind: 'straight', length: 200, width: 0.68, wall: 1 },
      { kind: 'turn', angle: -45, radius: 140, bank: 22, width: 0.68, wall: 1 },
      { kind: 'straight', length: 180, rise: 40 },
      { kind: 'turn', angle: 135, radius: 150, bank: 28 },
      { kind: 'straight', length: 260 },
      { kind: 'turn', angle: 90, radius: 170, bank: 24 },
      { kind: 'straight', length: 220, rise: -40 },
      { kind: 'turn', angle: -30, radius: 180, bank: 18 },
      { kind: 'straight', length: 200 },
      { kind: 'turn', angle: 120, radius: 140, bank: 26, width: 0.8 },
      { kind: 'straight', length: 280 },
    ],
    palette: {
      primary: 0xc9e6ff,
      secondary: 0xff6b1a,
      deep: 0x080a0d,
      glow: 0xe8f4ff,
      sun: 0xd6e8ff,
      haze: 0x1d242e,
    },
    music: { bpm: 132, root: 40, scale: 'minor', intensity: 0.65 },
    requires: ['helix-gate'],
  },

  {
    id: 'cascade-run',
    name: 'Cascade Run',
    tagline: 'Over the top and straight back down',
    seed: 'cascade-run-05',
    difficulty: 3,
    laps: 3,
    halfWidth: 25,
    environment: 'nebula',
    // Built around one signature moment: a plunge straight into a full vertical
    // loop, taken at whatever speed you dared carry into the drop.
    segments: [
      { kind: 'straight', length: 320 },
      { kind: 'turn', angle: 90, radius: 180, bank: 28 },
      { kind: 'straight', length: 240, rise: -60 },
      { kind: 'loop', radius: 95, wall: 0.6 },
      { kind: 'straight', length: 200 },
      { kind: 'turn', angle: 120, radius: 150, bank: 32 },
      { kind: 'straight', length: 180, rise: 60 },
      { kind: 'turn', angle: 90, radius: 170, bank: 26 },
      { kind: 'straight', length: 300 },
      { kind: 'turn', angle: 60, radius: 160, bank: 24 },
      { kind: 'straight', length: 260 },
    ],
    palette: {
      primary: 0x5cff9d,
      secondary: 0xa855f7,
      deep: 0x03110c,
      glow: 0xc9ffe2,
      sun: 0xd8ffe8,
      haze: 0x0d3a2a,
    },
    music: { bpm: 140, root: 41, scale: 'minor', intensity: 0.7 },
    requires: ['helix-gate'],
  },

  {
    id: 'rainbow-vector',
    name: 'Rainbow Vector',
    tagline: 'No walls. No margin. All colour.',
    seed: 'rainbow-vector-06',
    difficulty: 4,
    laps: 3,
    halfWidth: 23,
    iridescent: true,
    environment: 'prismatic',
    // The Rainbow Road homage. Guardrails are gone for the entire lap, so every
    // corner is a genuine risk, and two gaps force the player into the air where
    // there is nothing at all underneath.
    segments: [
      { kind: 'straight', length: 300, wall: 0 },
      { kind: 'turn', angle: 60, radius: 220, bank: 30, wall: 0 },
      { kind: 'straight', length: 260, wall: 0 },
      { kind: 'gap', length: 55 },
      { kind: 'straight', length: 200, wall: 0 },
      { kind: 'corkscrew', length: 260, turns: 1, wall: 0 },
      { kind: 'turn', angle: 90, radius: 180, bank: 35, wall: 0 },
      { kind: 'straight', length: 200, rise: 70, wall: 0 },
      { kind: 'gap', length: 62 },
      { kind: 'straight', length: 180, wall: 0 },
      { kind: 'turn', angle: 120, radius: 160, bank: 38, wall: 0 },
      { kind: 'straight', length: 260, rise: -70, wall: 0 },
      { kind: 'turn', angle: 90, radius: 190, bank: 30, wall: 0 },
      { kind: 'straight', length: 320, wall: 0 },
    ],
    palette: {
      primary: 0xffffff,
      secondary: 0xff3ea5,
      deep: 0x0a0320,
      glow: 0xfff0ff,
      sun: 0xffffff,
      haze: 0x2a1052,
    },
    music: { bpm: 138, root: 47, scale: 'majorPent', intensity: 0.7 },
    requires: ['cascade-run'],
  },

  {
    id: 'vesper-deep',
    name: 'Vesper Deep',
    tagline: 'Tight, dark, and unforgiving',
    seed: 'vesper-deep-07',
    difficulty: 4,
    laps: 3,
    halfWidth: 24,
    environment: 'void',
    // A technical track with almost no rest. Radii sit around 90–110 m, which is
    // below the comfortable cornering speed of every ship — airbrakes mandatory.
    segments: [
      { kind: 'straight', length: 180, width: 0.8 },
      { kind: 'turn', angle: -75, radius: 95, bank: 30, width: 0.78 },
      { kind: 'straight', length: 120, width: 0.78 },
      { kind: 'turn', angle: 110, radius: 90, bank: 34, width: 0.74 },
      { kind: 'straight', length: 100, rise: 30 },
      { kind: 'turn', angle: -60, radius: 100, bank: 28 },
      { kind: 'straight', length: 140 },
      { kind: 'turn', angle: 95, radius: 85, bank: 34, width: 0.74 },
      { kind: 'straight', length: 160, rise: -30 },
      { kind: 'turn', angle: -50, radius: 110, bank: 26 },
      { kind: 'straight', length: 130 },
      { kind: 'turn', angle: 120, radius: 95, bank: 32 },
      { kind: 'straight', length: 180 },
      { kind: 'turn', angle: 45, radius: 120, bank: 24 },
      { kind: 'straight', length: 200 },
      { kind: 'turn', angle: 100, radius: 95, bank: 32 },
      { kind: 'straight', length: 140 },
      { kind: 'turn', angle: 75, radius: 110, bank: 28 },
      { kind: 'straight', length: 160 },
    ],
    palette: {
      primary: 0xff2e63,
      secondary: 0x6c5ce7,
      deep: 0x030308,
      glow: 0xffb3c8,
      sun: 0x9aa8ff,
      haze: 0x140a1f,
    },
    music: { bpm: 146, root: 38, scale: 'phrygian', intensity: 0.75 },
    requires: ['ironbound', 'cascade-run'],
  },

  {
    id: 'the-thresher',
    name: 'The Thresher',
    tagline: 'Everything the circuit has, all at once',
    seed: 'the-thresher-08',
    difficulty: 5,
    laps: 3,
    halfWidth: 23,
    environment: 'starfield',
    // The graduation exam: inversion, a loop, a gap, a climbing helix and a
    // hairpin, with barely a straight long enough to catch a breath.
    segments: [
      { kind: 'straight', length: 260, width: 0.78 },
      { kind: 'turn', angle: 100, radius: 110, bank: 34, width: 0.74 },
      { kind: 'corkscrew', length: 220, turns: 1, width: 0.74, wall: 0.35 },
      { kind: 'straight', length: 140 },
      { kind: 'loop', radius: 80, wall: 0.5 },
      { kind: 'turn', angle: -70, radius: 100, bank: 30 },
      { kind: 'straight', length: 140, width: 0.7 },
      { kind: 'gap', length: 50 },
      { kind: 'straight', length: 160, width: 0.74 },
      { kind: 'turn', angle: 130, radius: 105, bank: 36 },
      { kind: 'straight', length: 180, rise: 55 },
      { kind: 'helix', angle: 100, radius: 120, rise: 45, bank: 34 },
      { kind: 'straight', length: 150 },
      { kind: 'turn', angle: -60, radius: 95, bank: 30, wall: 0.6 },
      { kind: 'straight', length: 200, rise: -100 },
      { kind: 'turn', angle: 160, radius: 115, bank: 36 },
      { kind: 'straight', length: 240 },
    ],
    palette: {
      primary: 0xff1f3d,
      secondary: 0xffffff,
      deep: 0x000000,
      glow: 0xff8fa3,
      sun: 0xffd4d9,
      haze: 0x1a0206,
    },
    music: { bpm: 152, root: 37, scale: 'harmonicMinor', intensity: 0.95 },
    requires: ['rainbow-vector', 'vesper-deep'],
  },
];

export const TRACKS_BY_ID = new Map(TRACKS.map((t) => [t.id, t]));

export function getTrack(id: string): TrackDefinition {
  const t = TRACKS_BY_ID.get(id);
  if (!t) throw new Error(`Unknown track: ${id}`);
  return t;
}

export interface ChampionshipDefinition {
  id: string;
  name: string;
  tagline: string;
  /** Circuits in running order; the length is the number of rounds. */
  tracks: string[];
}

/** Championship running order — difficulty ramps, environments alternate. */
export const CHAMPIONSHIPS: ChampionshipDefinition[] = [
  {
    id: 'vector',
    name: 'Vector Cup',
    tagline: 'Learn the circuit',
    tracks: ['neon-meridian', 'solstice-ring', 'helix-gate'],
  },
  {
    id: 'ascent',
    name: 'Ascent Cup',
    tagline: 'Where it starts to bite',
    tracks: ['ironbound', 'cascade-run', 'rainbow-vector'],
  },
  {
    id: 'horizon',
    name: 'Horizon Cup',
    tagline: 'For the ones who are left',
    tracks: ['vesper-deep', 'rainbow-vector', 'the-thresher'],
  },
];
