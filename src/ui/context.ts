/**
 * What a screen is allowed to know.
 *
 * Screens never see the `GameUi` object itself — they get this narrow context
 * instead. That keeps navigation, sound, and the shared selection state in one
 * place, and it means a screen can be written, and reasoned about, without any
 * knowledge of the transition machinery or of its siblings.
 */

import type { GameMode, ChampionshipState, RaceResult } from '../game/types';
import type { ScreenName, UiHost, UiOptions } from './types';

/** Choices carried between screens: what the player is about to race. */
export interface UiState {
  mode: GameMode;
  trackId: string;
  shipId: string;
  /** Set while a series is running. */
  championshipId: string | null;
  round: number;
  /** Second craft pinned in the garage for side-by-side comparison. */
  compareShipId: string | null;
  lastResult: RaceResult | null;
  championship: ChampionshipState | null;
  /** Where Escape goes from the current screen. */
  returnTo: ScreenName;
}

export interface UiContext {
  readonly host: UiHost;
  readonly options: UiOptions;
  readonly state: UiState;
  go(screen: ScreenName): void;
  back(to?: ScreenName): void;
  toast(message: string, kind?: 'info' | 'good' | 'bad'): void;
  confirm(title: string, body: string): Promise<boolean>;
  sound(name: 'uiMove' | 'uiSelect' | 'uiBack' | 'uiError'): void;
  /** Re-reads the profile and refreshes every mounted screen. */
  profileChanged(): void;
}

export interface Screen {
  readonly root: HTMLElement;
  /** Called each time the screen becomes visible. */
  enter?(): void;
  leave?(): void;
  /** Called when the profile changed underneath us. */
  refresh?(): void;
  dispose?(): void;
}
