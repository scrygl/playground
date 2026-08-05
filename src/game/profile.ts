import { TRACKS } from '../track/library';
import { SHIPS } from './ships';

/**
 * Persistent player profile: unlocks, records, settings.
 *
 * Stored as a single versioned JSON blob in localStorage. Every read goes
 * through {@link loadProfile}, which repairs anything missing or malformed
 * rather than throwing — a corrupt save should cost you your records, not stop
 * the game from starting.
 */

export type MedalTier = 'none' | 'bronze' | 'silver' | 'gold' | 'author';

export const MEDAL_ORDER: MedalTier[] = ['none', 'bronze', 'silver', 'gold', 'author'];

export interface TrackRecord {
  /** Best full-race time in milliseconds. */
  bestRace: number;
  /** Best single lap in milliseconds. */
  bestLap: number;
  medal: MedalTier;
  /** Ship used for the best race. */
  ship: string;
  /** Recorded ghost for the best lap, if one was captured. */
  ghost?: number[];
  /** Times the track has been finished. */
  completions: number;
}

export interface ControlBindings {
  [action: string]: string[];
}

export interface GameSettings {
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  /** Auto tier means the adaptive scaler picks and maintains it. */
  qualityTier: 'auto' | 'potato' | 'low' | 'medium' | 'high' | 'ultra';
  adaptiveQuality: boolean;
  targetFps: number;
  cameraShake: number;
  fieldOfView: number;
  /** Suppresses screen shake, heavy flashing, and speed-blur intensity. */
  reducedMotion: boolean;
  /** Forces the WebGL2 backend even where WebGPU is available. */
  forceWebGL: boolean;
  showGhost: boolean;
  invertPitch: boolean;
  steerDeadzone: number;
  bindings: ControlBindings;
  /** Difficulty of computer-controlled racers, 0..1. */
  aiDifficulty: number;
  hudScale: number;
  showSpeedLines: boolean;
}

export interface Profile {
  version: number;
  credits: number;
  unlockedShips: string[];
  unlockedTracks: string[];
  records: Record<string, TrackRecord>;
  /** Championship id → best finishing position. */
  championships: Record<string, number>;
  settings: GameSettings;
  /** Total distance raced, metres. Flavour for the profile screen. */
  totalDistance: number;
  totalRaces: number;
}

export const STORAGE_KEY = 'pulsar-circuit.profile.v1';
/**
 * The key this game shipped under before it was renamed.
 *
 * Read once so anyone who had already played keeps their records, medals and
 * credits across the rename instead of silently starting over.
 */
const LEGACY_STORAGE_KEYS = ['velocity-horizon.profile.v1'];
const PROFILE_VERSION = 1;

export const DEFAULT_BINDINGS: ControlBindings = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  airbrakeLeft: ['KeyQ', 'ShiftLeft'],
  airbrakeRight: ['KeyE', 'ShiftRight'],
  boost: ['Space'],
  lookBack: ['KeyC'],
  cameraMode: ['KeyV'],
  pitchUp: ['KeyI'],
  pitchDown: ['KeyK'],
  restart: ['KeyR'],
  pause: ['Escape'],
};

export function defaultSettings(): GameSettings {
  return {
    masterVolume: 0.85,
    musicVolume: 0.7,
    sfxVolume: 0.85,
    qualityTier: 'auto',
    adaptiveQuality: true,
    targetFps: 60,
    cameraShake: 1,
    fieldOfView: 78,
    reducedMotion: false,
    forceWebGL: false,
    showGhost: true,
    invertPitch: false,
    steerDeadzone: 0.15,
    bindings: structuredClone(DEFAULT_BINDINGS),
    aiDifficulty: 0.62,
    hudScale: 1,
    showSpeedLines: true,
  };
}

export function defaultProfile(): Profile {
  return {
    version: PROFILE_VERSION,
    credits: 0,
    // The starter craft and the teaching track are always available.
    unlockedShips: ['kestrel'],
    unlockedTracks: TRACKS.filter((t) => !t.requires?.length).map((t) => t.id),
    records: {},
    championships: {},
    settings: defaultSettings(),
    totalDistance: 0,
    totalRaces: 0,
  };
}

/**
 * Fills in anything a stored profile is missing.
 *
 * Saves outlive code. A profile written before a setting existed must not
 * produce `undefined` somewhere deep in the render loop, so every field is
 * checked against the defaults on the way in.
 */
function repair(raw: unknown): Profile {
  const base = defaultProfile();
  if (!raw || typeof raw !== 'object') return base;
  const input = raw as Partial<Profile>;

  const settings = { ...base.settings, ...(input.settings ?? {}) };
  settings.bindings = { ...base.settings.bindings, ...(input.settings?.bindings ?? {}) };
  // Drop bindings for actions that no longer exist.
  for (const key of Object.keys(settings.bindings)) {
    if (!(key in DEFAULT_BINDINGS)) delete settings.bindings[key];
  }

  const validShips = new Set(SHIPS.map((s) => s.id));
  const validTracks = new Set(TRACKS.map((t) => t.id));

  const records: Record<string, TrackRecord> = {};
  for (const [id, rec] of Object.entries(input.records ?? {})) {
    if (!validTracks.has(id) || !rec) continue;
    records[id] = {
      bestRace: Number.isFinite(rec.bestRace) ? rec.bestRace : Infinity,
      bestLap: Number.isFinite(rec.bestLap) ? rec.bestLap : Infinity,
      medal: MEDAL_ORDER.includes(rec.medal) ? rec.medal : 'none',
      ship: validShips.has(rec.ship) ? rec.ship : 'kestrel',
      ghost: Array.isArray(rec.ghost) ? rec.ghost : undefined,
      completions: Number.isFinite(rec.completions) ? rec.completions : 0,
    };
  }

  return {
    version: PROFILE_VERSION,
    credits: Number.isFinite(input.credits) ? Math.max(0, input.credits as number) : 0,
    unlockedShips: [...new Set(['kestrel', ...(input.unlockedShips ?? []).filter((s) => validShips.has(s))])],
    unlockedTracks: [
      ...new Set([...base.unlockedTracks, ...(input.unlockedTracks ?? []).filter((t) => validTracks.has(t))]),
    ],
    records,
    championships: input.championships ?? {},
    settings,
    totalDistance: Number.isFinite(input.totalDistance) ? (input.totalDistance as number) : 0,
    totalRaces: Number.isFinite(input.totalRaces) ? (input.totalRaces as number) : 0,
  };
}

export function loadProfile(): Profile {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      for (const legacy of LEGACY_STORAGE_KEYS) {
        const found = localStorage.getItem(legacy);
        if (found) {
          raw = found;
          // Migrate on read so the next save lands under the current key.
          localStorage.setItem(STORAGE_KEY, found);
          localStorage.removeItem(legacy);
          break;
        }
      }
    }
    if (!raw) return defaultProfile();
    return repair(JSON.parse(raw));
  } catch {
    // Private browsing, quota, or garbage in the slot — start fresh rather
    // than refusing to boot.
    return defaultProfile();
  }
}

export function saveProfile(profile: Profile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    /* Storage unavailable; the session still plays, it just will not persist. */
  }
}

export function medalFor(timeMs: number, medals: { author: number; gold: number; silver: number; bronze: number }): MedalTier {
  if (timeMs <= medals.author) return 'author';
  if (timeMs <= medals.gold) return 'gold';
  if (timeMs <= medals.silver) return 'silver';
  if (timeMs <= medals.bronze) return 'bronze';
  return 'none';
}

export function betterMedal(a: MedalTier, b: MedalTier): MedalTier {
  return MEDAL_ORDER.indexOf(a) >= MEDAL_ORDER.indexOf(b) ? a : b;
}

/** Tracks whose prerequisites the player has now satisfied. */
export function resolveUnlocks(profile: Profile): string[] {
  const freshly: string[] = [];
  for (const track of TRACKS) {
    if (profile.unlockedTracks.includes(track.id)) continue;
    const met = (track.requires ?? []).every((r) => (profile.records[r]?.completions ?? 0) > 0);
    if (met) {
      profile.unlockedTracks.push(track.id);
      freshly.push(track.id);
    }
  }
  return freshly;
}

/** Credits awarded for a finish, before any bonuses. */
export function creditsForFinish(position: number, entrants: number, medal: MedalTier): number {
  const placement = Math.max(0, entrants - position + 1) * 120;
  const medalBonus = { none: 0, bronze: 250, silver: 600, gold: 1200, author: 2500 }[medal];
  return Math.round(placement + medalBonus);
}
