import type { MedalTier } from './profile';

/**
 * The vocabulary shared between the simulation and everything that displays it.
 *
 * The UI never reaches into the race director; it reads a {@link HudSnapshot}
 * once a frame and renders it. Keeping that boundary narrow is what allows the
 * HUD to be rebuilt, scaled, or turned off without touching game logic.
 */

export type GameMode =
  | 'quick'
  | 'championship'
  | 'timetrial'
  | 'elimination'
  | 'pursuit'
  | 'zone'
  | 'endless';

export interface ModeInfo {
  id: GameMode;
  name: string;
  tagline: string;
  description: string;
  /** Whether the mode fields a field of rivals. */
  hasRivals: boolean;
  /** Whether finishing contributes to unlocks and credits. */
  scored: boolean;
}

export const MODES: ModeInfo[] = [
  {
    id: 'championship',
    name: 'Championship',
    tagline: 'Three circuits, one trophy',
    description:
      'A series of races scored on points. Finish every round; the standings carry between them. This is where ships and circuits are unlocked.',
    hasRivals: true,
    scored: true,
  },
  {
    id: 'quick',
    name: 'Quick Race',
    tagline: 'Any circuit, any craft',
    description: 'A single race against a full grid. Pick anything you have unlocked and go.',
    hasRivals: true,
    scored: true,
  },
  {
    id: 'timetrial',
    name: 'Time Trial',
    tagline: 'You, the clock, and your ghost',
    description:
      'An empty circuit and your best lap replayed alongside you. Four medals per track — bronze through author. Restart is instant.',
    hasRivals: false,
    scored: true,
  },
  {
    id: 'elimination',
    name: 'Elimination',
    tagline: 'Last place is removed. Repeatedly.',
    description:
      'Every twenty seconds the craft in last place is knocked out of the race. Survive to the end to win it.',
    hasRivals: true,
    scored: true,
  },
  {
    id: 'pursuit',
    name: 'Pursuit',
    tagline: 'Outrun the interceptors',
    description:
      'Circuit enforcement is on the track and it is faster than you. Reach the finish before they wear your shield down.',
    hasRivals: true,
    scored: true,
  },
  {
    id: 'zone',
    name: 'Zone',
    tagline: 'The throttle is not yours',
    description:
      'Speed climbs by itself, one zone at a time, and it never comes back down. Steering is all you have. How far can you hold on?',
    hasRivals: false,
    scored: true,
  },
  {
    id: 'endless',
    name: 'Endless',
    tagline: 'A circuit that never repeats',
    description:
      'A track generated from a seed, running on forever. Share the seed and someone else can race the same one.',
    hasRivals: true,
    scored: false,
  },
];

export const MODES_BY_ID = new Map(MODES.map((m) => [m.id, m]));

export interface RaceConfig {
  mode: GameMode;
  trackId: string;
  shipId: string;
  /** Number of computer-controlled rivals. */
  rivals: number;
  laps: number;
  /** 0..1 — feeds into rival skill. */
  difficulty: number;
  /** Seed for procedural tracks and rival variation. */
  seed: string;
  /** Race against the stored ghost, when one exists. */
  useGhost: boolean;
  /** Championship context, when running a series. */
  championshipId?: string;
  round?: number;
}

export type RacePhase = 'loading' | 'countdown' | 'racing' | 'finished' | 'failed';

export interface RacerStanding {
  id: string;
  name: string;
  shipId: string;
  isPlayer: boolean;
  position: number;
  lap: number;
  /** Total metres covered — the underlying sort key. */
  progress: number;
  /** Gap to the leader in seconds; zero for the leader. */
  gap: number;
  finished: boolean;
  eliminated: boolean;
  finishTime: number;
  shield: number;
  bestLap: number;
}

/** Everything the HUD needs for one frame. Read-only from the UI's side. */
export interface HudSnapshot {
  phase: RacePhase;
  mode: GameMode;
  /** Countdown seconds remaining; 3, 2, 1, 0 = GO. */
  countdown: number;
  /** Elapsed race time in milliseconds. */
  time: number;
  lap: number;
  totalLaps: number;
  position: number;
  entrants: number;
  /** Metres per second. */
  speed: number;
  /** 0..1 against the craft's top speed. */
  speedFraction: number;
  shield: number;
  shieldFraction: number;
  boost: number;
  /** Mini-turbo charge tier, 0..3. */
  turboTier: number;
  currentLapTime: number;
  lastLapTime: number;
  bestLapTime: number;
  /** Difference to the stored best at the current point on the track, ms. */
  ghostDelta: number;
  /** Consecutive rhythm gates hit; drives the Groove multiplier. */
  grooveChain: number;
  grooveMultiplier: number;
  score: number;
  standings: RacerStanding[];
  /** Progress round the lap, 0..1, for the track map. */
  lapProgress: number;
  /** Zone mode: which speed step we are on. */
  zone: number;
  /** Pursuit mode: 0..1 how close the nearest interceptor is. */
  threat: number;
  /** Transient messages: 'PERFECT', 'WRONG WAY', 'FINAL LAP'. */
  banner: string;
  bannerKind: 'none' | 'good' | 'bad' | 'info';
}

export interface LapResult {
  lap: number;
  time: number;
  best: boolean;
}

export interface RaceResult {
  finished: boolean;
  position: number;
  entrants: number;
  totalTime: number;
  bestLap: number;
  laps: LapResult[];
  medal: MedalTier;
  previousMedal: MedalTier;
  creditsEarned: number;
  newRecord: boolean;
  score: number;
  /** Tracks unlocked as a direct result of this race. */
  unlockedTracks: string[];
  standings: RacerStanding[];
  /** Championship points awarded, when in a series. */
  points?: number;
}

export interface ChampionshipStanding {
  racerId: string;
  name: string;
  points: number;
  isPlayer: boolean;
}

export interface ChampionshipState {
  id: string;
  round: number;
  tracks: string[];
  standings: ChampionshipStanding[];
  finished: boolean;
}

/** Points per finishing position, Formula-style. */
export const POINTS_TABLE = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

export function pointsForPosition(position: number): number {
  return POINTS_TABLE[position - 1] ?? 0;
}

/** Rival names, drawn in order so a grid is stable within a session. */
export const RIVAL_NAMES = [
  'AURIC',
  'KESTREL-9',
  'VANTA',
  'SOLARIS',
  'RIPTIDE',
  'MERIDIAN',
  'OBSIDIAN',
  'CINDER',
  'HALO',
  'NOVA',
  'TESSERACT',
];
