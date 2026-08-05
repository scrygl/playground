import type { GameSettings, MedalTier, Profile } from '../game/profile';
import type { GameMode, HudSnapshot, RaceConfig, RaceResult, ChampionshipState } from '../game/types';
import type { DeviceProfile, QualityTierName } from '../core/quality';

/**
 * The boundary between the game and its interface.
 *
 * The app owns simulation and rendering; the UI owns every pixel of DOM. They
 * talk through this contract only — the UI never imports the race director, and
 * the game never queries the DOM. That separation is what lets the HUD be
 * rescaled, restyled, or hidden entirely without any risk to the simulation.
 */

export type ScreenName =
  | 'boot'
  | 'title'
  | 'mode'
  | 'championship'
  | 'trackSelect'
  | 'garage'
  | 'settings'
  | 'controls'
  | 'loading'
  | 'race'
  | 'paused'
  | 'results'
  | 'championshipStandings'
  | 'credits';

/** Everything the UI may ask the game to do. */
export interface UiHost {
  /** Begin a race with this configuration. */
  startRace(config: RaceConfig): void;
  /** Leave the current race and return to the menus. */
  abandonRace(): void;
  resumeRace(): void;
  restartRace(): void;
  /** Advance to the next round of a championship. */
  advanceChampionship(): void;
  /** Persist changed settings and apply them immediately. */
  applySettings(settings: GameSettings): void;
  /** Buy a ship; returns false when the player cannot afford it. */
  purchaseShip(shipId: string): boolean;
  /** Wipe the profile after confirmation. */
  resetProfile(): void;
  /** Current profile — always read fresh, never cached by the UI. */
  getProfile(): Profile;
  /** Best-known device capabilities, for the settings screen. */
  getDevice(): DeviceProfile;
  /** Live performance readout for the settings screen. */
  getPerformance(): { fps: number; tier: QualityTierName; resolutionScale: number; backend: string };
  /** Play a UI sound. Fire-and-forget. */
  sound(name: 'uiMove' | 'uiSelect' | 'uiBack' | 'uiError'): void;
  /** Unlocks the audio context; must be called from a real user gesture. */
  unlockAudio(): void;
  /** Medal thresholds and derived times for a track, for the select screen. */
  getTrackSummary(trackId: string): TrackSummary;
}

export interface TrackSummary {
  id: string;
  name: string;
  tagline: string;
  difficulty: number;
  laps: number;
  /** Metres. */
  length: number;
  environment: string;
  palette: { primary: number; secondary: number; deep: number; glow: number };
  medals: { author: number; gold: number; silver: number; bronze: number };
  bestRace: number;
  bestLap: number;
  medal: MedalTier;
  unlocked: boolean;
  /** Ids of tracks that must be completed first, when locked. */
  requires: string[];
  /** A simple top-down outline of the circuit for the preview, normalised to 0..1. */
  outline: { x: number; y: number }[];
}

export interface GameUi {
  /** Attach to the DOM. Called once. */
  mount(root: HTMLElement, host: UiHost): void;
  /** Switch screens. Implementations should animate transitions. */
  show(screen: ScreenName): void;
  readonly current: ScreenName;
  /** Called every frame while racing. Must not allocate. */
  updateHud(snapshot: HudSnapshot): void;
  /** Progress 0..1 with a human-readable stage label. */
  setLoading(progress: number, label: string): void;
  /** Populate and show the results screen. */
  showResults(result: RaceResult): void;
  /** Populate and show championship standings between rounds. */
  showChampionship(state: ChampionshipState): void;
  /** Transient toast, e.g. "Rainbow Vector unlocked". */
  toast(message: string, kind?: 'info' | 'good' | 'bad'): void;
  /** Blocking confirmation dialog. */
  confirm(title: string, body: string): Promise<boolean>;
  /** Called when the profile changes so screens can refresh. */
  profileChanged(): void;
  /** Which mode the player last chose, for the track-select header. */
  setPendingMode(mode: GameMode): void;
  /** Full-screen error state, for an unrecoverable failure. */
  fatal(message: string, detail?: string): void;
  dispose(): void;
}

/** Result payload passed back when the results screen is dismissed. */
export type ResultsAction = 'retry' | 'next' | 'menu';

export interface UiOptions {
  /** Reduced-motion users get no parallax, no shake, no big transitions. */
  reducedMotion: boolean;
  /** Multiplier on HUD element sizes. */
  hudScale: number;
  /** Touch controls are added when the device is primarily touch-driven. */
  touch: boolean;
}

export type { RaceConfig, RaceResult, HudSnapshot, GameSettings, Profile };
