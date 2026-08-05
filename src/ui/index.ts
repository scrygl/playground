/**
 * PULSAR CIRCUIT — the interface.
 *
 * One object implements {@link GameUi}: it owns a screen registry, the
 * transition between screens, the navigation controller, and the three global
 * surfaces (toasts, the confirmation dialog, the fatal error state). Screens
 * themselves are plain factories that receive a narrow {@link UiContext} and
 * hand back a root element plus optional lifecycle hooks.
 *
 * Two rules run through the whole module:
 *
 *   · The game never reaches into the DOM and the UI never reaches into the
 *     simulation. Everything crosses through `UiHost` and `HudSnapshot`.
 *   · Nothing player-authored is ever interpolated into markup. Every node is
 *     built with `createElement` and filled with `textContent`.
 */

import './styles.css';

import type { GameMode, ChampionshipState, HudSnapshot, RaceResult } from '../game/types';
import { SHIPS } from '../game/ships';
import { TRACKS } from '../track/library';
import type { GameUi, ScreenName, UiHost, UiOptions } from './types';
import type { Screen, UiContext, UiState } from './context';
import { NavController } from './nav';
import { Hud } from './hud';
import { icon } from './icons';
import { button, el } from './widgets';

import { createBootScreen, createTitleScreen } from './screens/title';
import { createModeScreen } from './screens/mode';
import { createChampionshipScreen } from './screens/championship';
import { createTrackSelectScreen } from './screens/track-select';
import { createGarageScreen } from './screens/garage';
import { createSettingsScreen } from './screens/settings';
import { createControlsScreen } from './screens/controls';
import { createLoadingScreen, type LoadingScreen } from './screens/loading';
import { createRaceScreen } from './screens/race';
import { createPausedScreen } from './screens/paused';
import { createResultsScreen, type ResultsScreen } from './screens/results';
import { createStandingsScreen, type StandingsScreen } from './screens/standings';
import { createCreditsScreen } from './screens/credits';

/** Where Escape goes from each screen. `null` means the screen swallows it. */
const BACK_TARGETS: Record<ScreenName, ScreenName | null> = {
  boot: null,
  title: null,
  mode: 'title',
  championship: 'mode',
  trackSelect: 'mode',
  garage: 'title',
  settings: 'title',
  controls: 'title',
  loading: null,
  race: null,
  paused: null,
  results: null,
  championshipStandings: null,
  credits: 'title',
};

/** Screens where arrow keys drive a menu rather than a ship. */
const NAVIGABLE: Record<ScreenName, boolean> = {
  boot: true,
  title: true,
  mode: true,
  championship: true,
  trackSelect: true,
  garage: true,
  settings: true,
  controls: true,
  loading: false,
  race: false,
  paused: true,
  results: true,
  championshipStandings: true,
  credits: true,
};

const TRANSITION_MS = 260;

export class PulsarCircuitUi implements GameUi {
  private root: HTMLElement | null = null;
  private host!: UiHost;
  private nav!: NavController;
  private hud!: Hud;

  private screens = new Map<ScreenName, Screen>();
  private screenLayer!: HTMLElement;
  private toastLayer!: HTMLElement;
  private modalLayer: HTMLElement | null = null;
  private fatalLayer: HTMLElement | null = null;

  private currentScreen: ScreenName = 'boot';
  /** Pending unmount per screen root — never one shared handle. See scheduleUnmount. */
  private readonly leaveTimers = new Map<HTMLElement, number>();
  private disposed = false;

  private loading!: LoadingScreen;
  private results!: ResultsScreen;
  private standings!: StandingsScreen;

  private readonly overrides: Partial<UiOptions>;
  private opts: UiOptions = { reducedMotion: false, hudScale: 1, touch: false };

  private readonly state: UiState = {
    mode: 'quick',
    trackId: TRACKS[0]?.id ?? '',
    shipId: SHIPS[0]?.id ?? '',
    championshipId: null,
    round: 0,
    compareShipId: null,
    lastResult: null,
    championship: null,
    returnTo: 'title',
  };

  /**
   * `options` lets the app force reduced motion or touch controls on; anything
   * left out is derived from the player's profile and the platform.
   */
  constructor(options: Partial<UiOptions> = {}) {
    this.overrides = options;
  }

  get current(): ScreenName {
    return this.currentScreen;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  mount(root: HTMLElement, host: UiHost): void {
    this.root = root;
    this.host = host;
    root.classList.add('vh-ui');
    root.setAttribute('data-screen', 'boot');
    root.replaceChildren();

    root.appendChild(buildBackdrop());

    this.screenLayer = el('div', 'vh-screens');
    this.screenLayer.style.position = 'absolute';
    this.screenLayer.style.inset = '0';
    root.appendChild(this.screenLayer);

    this.toastLayer = el('div', 'vh-toasts');
    this.toastLayer.setAttribute('role', 'status');
    this.toastLayer.setAttribute('aria-live', 'polite');
    root.appendChild(this.toastLayer);

    this.readOptions();

    this.nav = new NavController(root, {
      onMove: () => host.sound('uiMove'),
      onSelect: () => host.sound('uiSelect'),
      onBack: () => this.handleBack(),
      onError: () => {
        /* Hitting the edge of a menu should be silent, not scolding. */
      },
    });
    this.nav.attach();

    this.hud = new Hud({ hudScale: this.opts.hudScale, reducedMotion: this.opts.reducedMotion });

    const ctx = this.context();
    this.loading = createLoadingScreen(ctx);
    this.results = createResultsScreen(ctx);
    this.standings = createStandingsScreen(ctx);

    this.register('boot', createBootScreen(ctx));
    this.register('title', createTitleScreen(ctx));
    this.register('mode', createModeScreen(ctx));
    this.register('championship', createChampionshipScreen(ctx));
    this.register('trackSelect', createTrackSelectScreen(ctx));
    this.register('garage', createGarageScreen(ctx));
    this.register('settings', createSettingsScreen(ctx));
    this.register('controls', createControlsScreen(ctx));
    this.register('loading', this.loading);
    this.register('race', createRaceScreen(ctx, this.hud));
    this.register('paused', createPausedScreen(ctx));
    this.register('results', this.results);
    this.register('championshipStandings', this.standings);
    this.register('credits', createCreditsScreen(ctx));

    // Boot is live immediately; every other screen is inert until shown.
    const boot = this.screens.get('boot')!;
    boot.root.classList.add('is-mounted', 'is-active');
    boot.enter?.();
    this.nav.setScope(boot.root, true);
    this.nav.focusFirst();
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.leaveTimers.values()) window.clearTimeout(timer);
    this.leaveTimers.clear();
    this.nav?.detach();
    for (const screen of this.screens.values()) screen.dispose?.();
    this.screens.clear();
    if (this.root) {
      this.root.replaceChildren();
      this.root.classList.remove('vh-ui');
      this.root.removeAttribute('data-screen');
    }
    this.root = null;
  }

  private register(name: ScreenName, screen: Screen): void {
    this.screens.set(name, screen);
    this.screenLayer.appendChild(screen.root);
  }

  private context(): UiContext {
    const ui = this;
    return {
      host: this.host,
      // A getter, not a snapshot: screens read live values after the player
      // changes HUD scale or reduced motion without being rebuilt.
      get options(): UiOptions {
        return ui.opts;
      },
      state: this.state,
      go: (screen) => this.show(screen),
      back: (to) => this.goBack(to),
      toast: (message, kind) => this.toast(message, kind),
      confirm: (title, body) => this.confirm(title, body),
      sound: (name) => this.host.sound(name),
      profileChanged: () => this.profileChanged(),
    };
  }

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  show(screen: ScreenName): void {
    if (this.disposed || !this.root) return;
    const next = this.screens.get(screen);
    if (!next) return;
    if (screen === this.currentScreen) {
      next.enter?.();
      return;
    }

    // The screen coming in is staying, so cancel any unmount still pending
    // against it — going A → B → A inside the transition window otherwise
    // tears down the screen the player is now looking at.
    this.cancelUnmount(next.root);

    const previous = this.screens.get(this.currentScreen);
    if (previous) {
      previous.leave?.();
      previous.root.classList.remove('is-active');
      previous.root.classList.add('is-leaving');
      this.scheduleUnmount(previous.root);
    }

    this.currentScreen = screen;
    this.root.setAttribute('data-screen', screen);
    // The decorative backdrop is a sibling of the screens, so hiding it during
    // a race has to be driven from the root. The live 3D render is behind this
    // DOM and must be the only thing under the HUD.
    this.root.classList.toggle('is-racing', screen === 'race');

    next.root.classList.remove('is-leaving');
    next.root.classList.add('is-mounted');
    next.enter?.();
    // One forced reflow so the entrance transition has a starting frame.
    void next.root.offsetWidth;
    next.root.classList.add('is-active');

    const navigable = NAVIGABLE[screen];
    this.nav.setScope(next.root, navigable);
    if (navigable) this.nav.focusFirst();
    else (document.activeElement as HTMLElement | null)?.blur?.();

    // Invariant: only the incoming screen and the one animating out may be
    // mounted. A stranded screen is invisible but not harmless — every screen
    // is absolutely positioned, full-bleed, and takes pointer events, so one
    // left behind silently swallows every click aimed at the screens below it.
    for (const other of this.screens.values()) {
      if (other === next || other === previous) continue;
      if (other.root.classList.contains('is-mounted')) this.unmount(other.root);
    }
  }

  /**
   * Unmount is deferred so the leaving screen can animate, and the handle is
   * kept **per screen**. A single shared handle meant a second navigation
   * inside the 260 ms window cancelled the first screen's unmount instead of
   * its own — and `loading` and `results` sit above every menu in the stack,
   * so one stranded there left the menus visible but completely unclickable.
   */
  private scheduleUnmount(root: HTMLElement): void {
    this.cancelUnmount(root);
    const timer = window.setTimeout(
      () => this.unmount(root),
      this.opts.reducedMotion ? 0 : TRANSITION_MS,
    );
    this.leaveTimers.set(root, timer);
  }

  private cancelUnmount(root: HTMLElement): void {
    const pending = this.leaveTimers.get(root);
    if (pending === undefined) return;
    window.clearTimeout(pending);
    this.leaveTimers.delete(root);
  }

  private unmount(root: HTMLElement): void {
    this.cancelUnmount(root);
    root.classList.remove('is-mounted', 'is-leaving');
  }

  private goBack(to?: ScreenName): void {
    const target = to ?? BACK_TARGETS[this.currentScreen];
    if (!target) return;
    this.host.sound('uiBack');
    this.show(target);
  }

  /** Escape / gamepad B. Some screens answer it themselves. */
  private handleBack(): void {
    if (this.modalLayer) return;
    switch (this.currentScreen) {
      case 'paused':
        this.host.sound('uiBack');
        this.host.resumeRace();
        return;
      case 'trackSelect':
        this.goBack(this.state.championshipId ? 'championship' : 'mode');
        return;
      case 'garage':
      case 'settings':
        this.goBack(this.state.returnTo);
        this.state.returnTo = 'title';
        return;
      default:
        this.goBack();
    }
  }

  // -------------------------------------------------------------------------
  // GameUi surface
  // -------------------------------------------------------------------------

  updateHud(snapshot: HudSnapshot): void {
    this.hud.update(snapshot);
  }

  setLoading(progress: number, label: string): void {
    this.loading.setProgress(progress, label);
  }

  showResults(result: RaceResult): void {
    this.state.lastResult = result;
    this.results.present(result);
    this.show('results');
  }

  showChampionship(state: ChampionshipState): void {
    this.state.championship = state;
    this.state.championshipId = state.id;
    this.state.round = state.round;
    const nextTrack = state.tracks[state.round];
    if (nextTrack) this.state.trackId = nextTrack;
    this.standings.present(state);
    this.show('championshipStandings');
  }

  setPendingMode(mode: GameMode): void {
    this.state.mode = mode;
    if (mode !== 'championship') this.state.championshipId = null;
  }

  profileChanged(): void {
    this.readOptions();
    for (const screen of this.screens.values()) screen.refresh?.();
  }

  toast(message: string, kind: 'info' | 'good' | 'bad' = 'info'): void {
    if (!this.root) return;
    const node = el('div', `vh-toast vh-toast--${kind}`);
    node.appendChild(icon(kind === 'bad' ? 'warning' : kind === 'good' ? 'check' : 'info', 17));
    node.appendChild(el('span', '', message));
    this.toastLayer.appendChild(node);
    window.setTimeout(() => {
      node.classList.add('is-out');
      window.setTimeout(() => node.remove(), 300);
    }, 3200);
    // More than three at once is noise; drop the oldest.
    while (this.toastLayer.childElementCount > 3) this.toastLayer.firstElementChild?.remove();
  }

  confirm(title: string, body: string): Promise<boolean> {
    if (!this.root) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const previousFocus = document.activeElement as HTMLElement | null;
      const previousScope = this.screens.get(this.currentScreen)?.root ?? null;

      const layer = el('div', 'vh-modal');
      const dialog = el('div', 'vh-dialog vh-cut');
      dialog.setAttribute('role', 'alertdialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', title);
      dialog.appendChild(el('h2', 'vh-dialog__title', title));
      dialog.appendChild(el('p', 'vh-dialog__body', body));

      const actions = el('div', 'vh-dialog__actions');
      const close = (value: boolean): void => {
        this.host.sound(value ? 'uiSelect' : 'uiBack');
        layer.remove();
        this.modalLayer = null;
        this.nav.setScope(previousScope, previousScope !== null && NAVIGABLE[this.currentScreen]);
        previousFocus?.focus?.();
        window.removeEventListener('keydown', onKey, true);
        resolve(value);
      };

      const onKey = (event: KeyboardEvent): void => {
        if (event.code === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(false);
        }
      };

      actions.appendChild(button({ label: 'Cancel', kind: 'quiet', onClick: () => close(false) }));
      actions.appendChild(
        button({ label: 'Confirm', kind: 'primary', autofocus: true, onClick: () => close(true) }),
      );
      dialog.appendChild(actions);
      layer.appendChild(dialog);
      this.root!.appendChild(layer);
      this.modalLayer = layer;

      // Focus is trapped by scoping the navigator to the dialog subtree.
      this.nav.setScope(dialog, true);
      this.nav.focusFirst();
      window.addEventListener('keydown', onKey, true);
    });
  }

  fatal(message: string, detail?: string): void {
    if (!this.root) return;
    this.fatalLayer?.remove();
    const layer = el('div', 'vh-fatal');
    layer.setAttribute('role', 'alert');
    layer.appendChild(el('p', 'vh-fatal__kicker', 'The circuit is down'));
    layer.appendChild(el('h1', 'vh-fatal__title', message));
    if (detail) layer.appendChild(el('pre', 'vh-fatal__detail', detail));
    const actions = el('div', 'vh-dialog__actions');
    actions.style.justifyContent = 'flex-start';
    actions.appendChild(
      button({
        label: 'Reload',
        kind: 'primary',
        iconName: 'restart',
        autofocus: true,
        onClick: () => location.reload(),
      }),
    );
    layer.appendChild(actions);
    this.root.appendChild(layer);
    this.fatalLayer = layer;
    this.nav.setScope(layer, true);
    this.nav.focusFirst();
  }

  // -------------------------------------------------------------------------

  /** Options come from the profile, the platform, and the caller, in that order. */
  private readOptions(): void {
    const settings = this.host.getProfile().settings;
    const prefersCalm =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

    this.opts = {
      reducedMotion: this.overrides.reducedMotion ?? (settings.reducedMotion || prefersCalm),
      hudScale: this.overrides.hudScale ?? settings.hudScale,
      touch: this.overrides.touch ?? coarse,
    };

    this.root?.classList.toggle('is-calm', this.opts.reducedMotion);
    this.hud?.setScale(this.opts.hudScale);
  }
}

function buildBackdrop(): HTMLElement {
  const backdrop = el('div', 'vh-backdrop');
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.appendChild(el('div', 'vh-backdrop__scrim'));
  backdrop.appendChild(el('div', 'vh-backdrop__stars'));
  const grid = el('div', 'vh-backdrop__grid');
  grid.appendChild(el('div', 'vh-backdrop__plane'));
  backdrop.appendChild(grid);
  backdrop.appendChild(el('div', 'vh-backdrop__horizon'));
  backdrop.appendChild(el('div', 'vh-backdrop__scan'));
  backdrop.appendChild(el('div', 'vh-backdrop__vignette'));
  return backdrop;
}

/** Convenience factory; the app can also construct the class directly. */
export function createUi(options?: Partial<UiOptions>): GameUi {
  return new PulsarCircuitUi(options);
}

export type { GameUi, UiHost, ScreenName, UiOptions } from './types';
export { Hud } from './hud';
