import { PerspectiveCamera, Vector3 } from 'three';
import { GameRenderer } from './render/renderer';
import { ChaseCamera, CinematicCamera } from './render/camera';
import { World, type WorldFrameState } from './game/world';
import { Race } from './game/race';
import { Track } from './track/runtime';
import { TRACKS_BY_ID, CHAMPIONSHIPS, getTrack } from './track/library';
import { generateTrack } from './track/generator';
import type { TrackDefinition } from './track/types';
import { InputManager } from './game/input';
import { Driver } from './game/driver';
import { neutralControls } from './game/vehicle';
import { SHIPS_BY_ID } from './game/ships';
import {
  STORAGE_KEY,
  betterMedal,
  creditsForFinish,
  loadProfile,
  resolveUnlocks,
  saveProfile,
  type GameSettings,
  type Profile,
} from './game/profile';
import type { ChampionshipState, RaceConfig, RaceResult } from './game/types';
import { pointsForPosition } from './game/types';
import { createUi } from './ui';
import type { GameUi, ScreenName, TrackSummary, UiHost } from './ui/types';
import { createGameAudio } from './audio';
import type { GameAudio } from './audio/types';
import { PerformanceGovernor, detectDevice, type DeviceProfile, type QualityTierName } from './core/quality';
import { clamp01 } from './core/mathx';

declare global {
  interface Window {
    __GAME_DEBUG__: Record<string, unknown>;
  }
}

/**
 * The application: owns the renderer, the interface, the audio, and the
 * lifetime of a race.
 *
 * It is also the only thing that knows about all of those at once. The
 * interface talks to it through {@link UiHost} and never touches the
 * simulation; the simulation emits events and never touches the DOM.
 */
export class App implements UiHost {
  private readonly renderer: GameRenderer;
  private readonly ui: GameUi;
  private readonly audio: GameAudio;
  private readonly input: InputManager;
  private readonly governor: PerformanceGovernor;
  private readonly camera: PerspectiveCamera;
  private readonly chase: ChaseCamera;
  private readonly cinematic: CinematicCamera;

  private profile: Profile;
  private device: DeviceProfile;
  private world: World | null = null;
  private race: Race | null = null;
  private trackDefinition: TrackDefinition | null = null;
  private championship: ChampionshipState | null = null;
  private pendingConfig: RaceConfig | null = null;

  private screen: ScreenName = 'title';
  private paused = false;
  private lastFrame = 0;
  private elapsed = 0;
  private menuTrack: Track | null = null;
  /**
   * Hands the player's craft to the AI.
   *
   * Enabled with `?autopilot=1`. It exists so the capture harness can film
   * real racing rather than a craft parked against the first barrier, and it
   * is the same code path a demo/attract mode would use.
   */
  private autopilot: Driver | null = null;
  /** Latch so a finished race is committed to the profile exactly once. */
  private resultApplied = false;
  private damageFlash = 0;
  private readonly cameraPosition = new Vector3();

  private constructor(
    canvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
    profile: Profile,
    device: DeviceProfile,
  ) {
    this.profile = profile;
    this.device = device;

    // A URL override exists so the capture harness (and anyone debugging a
    // tier-specific problem) can pin quality without touching the profile.
    const params = new URLSearchParams(location.search);
    const override = params.get('tier') as QualityTierName | null;
    const tier: QualityTierName =
      override ??
      (profile.settings.qualityTier === 'auto' ? device.suggested : profile.settings.qualityTier);
    this.governor = new PerformanceGovernor(tier, {
      targetFps: profile.settings.targetFps,
      // `?adaptive=0` pins resolution. Under software rendering the governor
      // correctly floors the scale, which is useless for judging how the game
      // actually looks.
      enabled: params.get('adaptive') === '0' ? false : profile.settings.adaptiveQuality,
    });

    // `?gpu=webgl` forces the fallback backend. This is not only a debug
    // affordance: headless Chromium can render WebGPU but cannot composite it
    // into a screenshot, so every automated visual check depends on it.
    const forceWebGL = profile.settings.forceWebGL || params.get('gpu') === 'webgl';
    this.renderer = new GameRenderer(canvas, this.governor.settings, forceWebGL);
    this.renderer.bypassPost = params.get('nopost') === '1';
    this.audio = createGameAudio();
    this.input = new InputManager(profile.settings.bindings);
    this.input.configure({
      deadzone: profile.settings.steerDeadzone,
      invertPitch: profile.settings.invertPitch,
    });

    // One camera, two controllers. The post-processing chain binds to a
    // specific camera object, so handing the renderer a different one on every
    // view change would rebuild the whole graph — and a rebuilt chain rendered
    // black, which is how this arrangement was arrived at.
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.camera = new PerspectiveCamera(profile.settings.fieldOfView, aspect, 0.35, 12000);
    this.chase = new ChaseCamera(this.camera, {
      baseFov: profile.settings.fieldOfView,
      shakeScale: profile.settings.cameraShake,
      reducedMotion: profile.settings.reducedMotion,
    });
    this.cinematic = new CinematicCamera(this.camera);

    const touch = matchMedia('(hover: none) and (pointer: coarse)').matches;
    this.ui = createUi({
      reducedMotion: profile.settings.reducedMotion,
      hudScale: profile.settings.hudScale,
      touch,
    });
    this.ui.mount(uiRoot, this);
  }

  static async create(canvas: HTMLCanvasElement, uiRoot: HTMLElement): Promise<App> {
    const profile = loadProfile();
    const device = await detectDevice();
    const app = new App(canvas, uiRoot, profile, device);
    await app.boot();
    return app;
  }

  private async boot(): Promise<void> {
    await this.renderer.init();
    this.applyViewport();
    addEventListener('resize', () => this.applyViewport());
    addEventListener('visibilitychange', () => {
      // Coming back from a background tab must not fast-forward the race.
      if (!document.hidden) this.lastFrame = performance.now();
    });

    this.input.attach();


    // A quiet circuit turning behind the menus, so the title screen is not a
    // still image over a black canvas.
    await this.loadMenuBackdrop();

    // Start on the boot gate, not the menu. Browsers refuse to create an
    // AudioContext without a user gesture, and that gate's keypress is the
    // only thing that calls unlockAudio() — skipping it left the game silent.
    this.ui.show('boot');
    this.screen = 'boot';
    this.lastFrame = performance.now();
    this.renderer.renderer.setAnimationLoop(() => void this.frame());
  }

  private async loadMenuBackdrop(): Promise<void> {
    const definition = getTrack('neon-meridian');
    this.menuTrack = Track.build(definition);
    this.trackDefinition = definition;
    this.world = new World(
      this.renderer.scene,
      this.menuTrack,
      definition,
      this.governor.settings,
      [],
      false,
    );
    this.world.setCamera(this.camera);
    this.cinematic.frameTrack(this.menuTrack);
  }

  private applyViewport(): void {
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // --- Frame -------------------------------------------------------------

  private async frame(): Promise<void> {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.25);
    this.lastFrame = now;
    this.elapsed += dt;

    if (this.governor.update(dt)) {
      this.renderer.setQuality(this.governor.settings);
    }
    this.renderer.setResolutionScale(this.governor.resolutionScale);

    this.audio.update(dt);
    const clock = this.audio.clock;
    const beatPhase = clock.running ? clock.beatPhase : (this.elapsed * 2) % 1;
    const beatIndex = clock.running ? clock.beatIndex : Math.floor(this.elapsed * 2);
    // Sharp attack, quick decay — a pulse the eye reads as "on the beat"
    // rather than a sine that is always half-on.
    const beatPulse = Math.max(0, 1 - beatPhase * 3.2);

    const camera = this.camera;
    const racing = this.race !== null && this.screen === 'race';

    if (racing && this.race) {
      this.stepRace(dt);
    } else {
      this.cinematic.update(dt);
    }

    this.cameraPosition.copy(camera.position);
    if (this.world) {
      const player = this.race?.player;
      const frame: WorldFrameState = {
        dt,
        elapsed: this.elapsed,
        beatPulse,
        beatPhase,
        beatIndex,
        intensity: clock.running ? 0.55 : 0.3,
        cameraPosition: this.cameraPosition,
        playerDistance: player?.vehicle.s ?? 0,
        playerIndex: player?.index ?? 0,
        playerBoost: player?.vehicle.boostAmount ?? 0,
        playerSpeed: player?.vehicle.normalisedSpeed ?? 0,
      };
      this.world.setCamera(camera);
      this.world.update(this.race?.racers ?? [], frame);
      if (this.race) this.world.updateGhost(this.race.ghostPose(), frame);
    }

    this.updatePostEffects(dt);
    await this.renderer.render(camera, this.elapsed);
    this.input.endFrame();

    const debug = window.__GAME_DEBUG__;
    debug.frames = ((debug.frames as number) ?? 0) + 1;
    debug.fps = Math.round(this.governor.fps);
    // Report where the interface actually is; `this.screen` only tracks the
    // transitions the app drives, not menu navigation the UI does itself.
    debug.screen = this.ui.current;
    debug.backend = this.renderer.backend;
    debug.sceneChildren = this.renderer.scene.children.length;
    debug.hasBackground = this.renderer.scene.background !== null;
    debug.fade = this.renderer.post.fade.value;
    debug.camPos = `${camera.position.x.toFixed(0)},${camera.position.y.toFixed(0)},${camera.position.z.toFixed(0)}`;
    debug.camFar = camera.far;
    debug.pixelRatio = this.renderer.currentPixelRatio;
    debug.canvas = `${this.renderer.renderer.domElement.width}x${this.renderer.renderer.domElement.height}`;
    debug.groupChildren = this.world ? this.world.group.children.length : -1;
    if (this.race) {
      debug.phase = this.race.phase;
      debug.speed = Math.round(this.race.player.vehicle.speed);
      debug.lap = this.race.player.vehicle.lap;
      debug.position = this.race.player.position;
    }
  }

  private stepRace(dt: number): void {
    const race = this.race!;
    const settings = this.profile.settings;

    if (this.input.consumePress('pause') || this.input.padJustPressed('start')) {
      this.paused ? this.resumeRace() : this.pauseRace();
    }
    if (this.input.consumePress('restart')) this.restartRace();
    if (this.input.consumePress('cameraMode') || this.input.padJustPressed('square')) {
      const mode = this.chase.cycleMode();
      this.ui.toast(CAMERA_LABELS[mode], 'info');
      this.audio.play('uiSelect');
    }

    if (this.paused) return;

    let controls = race.phase === 'racing' ? this.input.sample(dt) : neutralControls();
    if (this.autopilot && race.phase === 'racing') {
      controls = this.autopilot.update(race.player.vehicle, dt);
    }
    const debug = window.__GAME_DEBUG__;
    debug.throttle = Number(controls.throttle.toFixed(2));
    debug.steer = Number(controls.steer.toFixed(2));
    debug.keys = [...this.input.rawPressed()].join('+');
    debug.source = this.input.lastSource;
    race.update(dt, controls);
    this.drainRaceEvents(dt);

    this.chase.configure({
      shakeScale: settings.cameraShake,
      reducedMotion: settings.reducedMotion,
      baseFov: settings.fieldOfView,
    });
    this.chase.update(race.track, race.player.vehicle, dt, this.input.isLookingBack());
    this.ui.updateHud(race.hud);

    if (race.isOver) this.finishRace();
  }

  /**
   * Turns simulation events into sound and effects.
   *
   * The race director does not know a renderer exists; it emits what happened
   * and this decides what that should look and sound like.
   */
  private drainRaceEvents(dt: number): void {
    const race = this.race!;
    const world = this.world;
    for (const event of race.events) {
      switch (event.type) {
        case 'impact': {
          world?.wallImpact(event.racer, event.strength, dt);
          if (event.racer === race.player.index) {
            this.chase.addShake(event.strength * 1.5, 0.45);
            this.damageFlash = Math.max(this.damageFlash, event.strength);
            this.audio.play(event.strength > 0.5 ? 'impactHard' : 'impactSoft', { volume: event.strength });
          }
          break;
        }
        case 'scrape':
          if (event.racer === race.player.index) {
            this.audio.play('scrape', { volume: 0.3 + event.strength * 0.4 });
          }
          break;
        case 'land':
          world?.land(event.racer, event.strength);
          if (event.racer === race.player.index && event.strength > 0.2) {
            this.chase.addShake(event.strength * 1.1, 0.3);
          }
          break;
        case 'boostPad':
          world?.boostPad(event.racer);
          break;
        case 'gate':
          world?.gateHit(event.feature, event.perfect);
          break;
        case 'pickup':
          world?.pickupTaken(event.feature, 7);
          break;
        case 'destroyed':
          world?.destroyed(event.racer);
          if (event.racer === race.player.index) {
            this.chase.addShake(2.4, 0.8);
            this.audio.play('explode');
            this.audio.duck(0.6, 0.6);
          }
          break;
        case 'respawn':
          world?.respawn(event.racer);
          if (event.racer === race.player.index) this.audio.play('respawn');
          break;
        case 'turbo':
          if (event.racer === race.player.index) {
            this.audio.play('boostFire', { rate: 0.9 + event.tier * 0.12 });
            this.chase.addShake(0.35, 0.25);
          }
          break;
        case 'eliminated':
          if (event.racer === race.player.index) this.audio.play('eliminated');
          break;
        default:
          break;
      }
    }
    race.events.length = 0;
  }

  private updatePostEffects(dt: number): void {
    const post = this.renderer.post;
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.2);

    if (this.race && this.screen === 'race' && !this.paused) {
      const vehicle = this.race.player.vehicle;
      const reduced = this.profile.settings.reducedMotion;
      post.speed.value = reduced ? 0 : this.chase.speedEffect(vehicle);
      post.aberration.value = reduced ? 0 : clamp01(vehicle.normalisedSpeed * 0.5 + vehicle.boostAmount * 0.8);
      post.boost.value = vehicle.boostAmount;
      post.damage.value = this.damageFlash;
    } else {
      post.speed.value = 0;
      post.aberration.value = 0;
      post.boost.value = 0;
      post.damage.value = 0;
    }
    // Menus sit over a dimmed circuit so the interface stays legible.
    post.fade.value = this.screen === 'race' && !this.paused ? 0 : 0.45;
  }

  // --- UiHost ------------------------------------------------------------

  startRace(config: RaceConfig): void {
    void this.loadRace(config);
  }

  private async loadRace(config: RaceConfig): Promise<void> {
    this.pendingConfig = config;
    this.syncChampionship(config);
    this.setScreen('loading');
    this.ui.setLoading(0.05, 'Plotting circuit');
    await nextFrame();

    const definition = this.resolveTrack(config);
    this.trackDefinition = definition;

    this.ui.setLoading(0.25, 'Building geometry');
    await nextFrame();
    const track = Track.build(definition);

    this.ui.setLoading(0.55, 'Placing the grid');
    await nextFrame();

    this.disposeWorld();

    const record = this.profile.records[definition.id];
    const race = new Race({
      track,
      config: { ...config, laps: config.laps || definition.laps },
      audio: this.audio,
      ghostData: config.useGhost ? record?.ghost : undefined,
      previousMedal: record?.medal ?? 'none',
    });
    this.race = race;

    this.ui.setLoading(0.75, 'Rendering environment');
    await nextFrame();

    this.world = new World(
      this.renderer.scene,
      track,
      definition,
      this.governor.settings,
      race.racers,
      Boolean(config.useGhost && record?.ghost?.length),
    );
    this.world.setCamera(this.camera);

    this.ui.setLoading(0.95, 'Spooling engines');
    await nextFrame();

    this.autopilot =
      new URLSearchParams(location.search).get('autopilot') === '1'
        ? new Driver(track, { skill: 0.86, seed: 'autopilot' })
        : null;

    this.chase.snapTo(track, race.player.vehicle);
    this.audio.startMusic(definition.music, definition.seed);
    this.audio.engine.start();

    this.paused = false;
    this.damageFlash = 0;
    this.resultApplied = false;
    this.lastFrame = performance.now();
    this.setScreen('race');
  }

  /**
   * Opens a championship when the interface starts one, and leaves an existing
   * series alone.
   *
   * The interface signals a series by putting a `championshipId` on the race
   * config rather than calling a separate entry point, so this is where a cup
   * actually begins. Without it every round would be scored as round one and
   * the series could never advance.
   */
  private syncChampionship(config: RaceConfig): void {
    if (!config.championshipId) {
      this.championship = null;
      return;
    }
    if (this.championship?.id === config.championshipId && !this.championship.finished) return;
    const cup = CHAMPIONSHIPS.find((c) => c.id === config.championshipId);
    if (!cup) {
      this.championship = null;
      return;
    }
    this.championship = {
      id: cup.id,
      round: config.round ?? 0,
      tracks: [...cup.tracks],
      standings: [],
      finished: false,
    };
  }

  private resolveTrack(config: RaceConfig): TrackDefinition {
    if (config.mode === 'endless' || config.trackId.startsWith('generated:')) {
      return generateTrack({ seed: config.seed, laps: Math.max(config.laps, 3) });
    }
    return TRACKS_BY_ID.get(config.trackId) ?? getTrack('neon-meridian');
  }

  private pauseRace(): void {
    this.paused = true;
    this.audio.engine.stop();
    this.setScreen('paused');
  }

  resumeRace(): void {
    if (!this.race) return;
    this.paused = false;
    this.audio.engine.start();
    this.lastFrame = performance.now();
    this.setScreen('race');
  }

  restartRace(): void {
    if (this.pendingConfig) void this.loadRace(this.pendingConfig);
  }

  abandonRace(): void {
    this.race?.abandon();
    this.race = null;
    this.audio.engine.stop();
    this.audio.stopMusic(0.6);
    this.disposeWorld();
    void this.loadMenuBackdrop();
    this.setScreen('title');
  }

  private finishRace(): void {
    const race = this.race;
    // Committing a result twice would double the credits and the completion
    // count, so this is latched rather than relying on the caller stopping.
    if (!race || this.resultApplied) return;
    const result = race.getResult();
    if (!result) return;
    this.resultApplied = true;

    this.audio.engine.stop();
    this.applyResultToProfile(race, result);
    this.ui.showResults(result);
    this.screen = 'results';
  }

  /**
   * Commits a finished race to the profile: records, medals, credits, unlocks.
   *
   * Runs exactly once per race, and only ever improves a stored record — a slow
   * run can never overwrite a fast one.
   */
  private applyResultToProfile(race: Race, result: RaceResult): void {
    const definition = this.trackDefinition;
    if (!definition) return;

    const existing = this.profile.records[definition.id];
    const previousMedal = existing?.medal ?? 'none';
    result.previousMedal = previousMedal;

    if (result.finished) {
      const bestRace = Math.min(existing?.bestRace ?? Infinity, result.totalTime);
      const bestLap = Math.min(existing?.bestLap ?? Infinity, result.bestLap);
      result.newRecord = result.totalTime < (existing?.bestRace ?? Infinity);

      const ghost = race.recordedGhost;
      this.profile.records[definition.id] = {
        bestRace,
        bestLap,
        medal: betterMedal(previousMedal, result.medal),
        ship: result.newRecord ? race.config.shipId : (existing?.ship ?? race.config.shipId),
        // Only keep a ghost that actually represents the best lap on record.
        ghost: ghost && result.bestLap <= (existing?.bestLap ?? Infinity) ? ghost : existing?.ghost,
        completions: (existing?.completions ?? 0) + 1,
      };

      result.creditsEarned = creditsForFinish(result.position, result.entrants, result.medal);
      this.profile.credits += result.creditsEarned;
      this.profile.totalRaces++;
      this.profile.totalDistance += race.track.raceDistance;
      result.unlockedTracks = resolveUnlocks(this.profile);

      if (this.championship) {
        result.points = pointsForPosition(result.position);
        this.recordChampionshipRound(race, result);
      }
    }

    saveProfile(this.profile);
    this.ui.profileChanged();
    for (const id of result.unlockedTracks) {
      const track = TRACKS_BY_ID.get(id);
      if (track) this.ui.toast(`${track.name} unlocked`, 'good');
    }
  }

  private recordChampionshipRound(race: Race, result: RaceResult): void {
    const state = this.championship;
    if (!state) return;
    for (const standing of result.standings) {
      const row = state.standings.find((s) => s.racerId === standing.id);
      const points = pointsForPosition(standing.position);
      if (row) row.points += points;
      else
        state.standings.push({
          racerId: standing.id,
          name: standing.name,
          points,
          isPlayer: standing.isPlayer,
        });
    }
    state.standings.sort((a, b) => b.points - a.points);
    state.round++;
    state.finished = state.round >= state.tracks.length;
    void race;
  }

  advanceChampionship(): void {
    const state = this.championship;
    if (!state) {
      this.abandonRace();
      return;
    }
    if (state.finished) {
      // Series over: record the player's placing, show the final table, and
      // let the standings screen return to the menus.
      const placing = state.standings.findIndex((s) => s.isPlayer) + 1;
      if (placing > 0) {
        const best = this.profile.championships[state.id];
        this.profile.championships[state.id] = best ? Math.min(best, placing) : placing;
        saveProfile(this.profile);
        this.ui.profileChanged();
      }
      this.race = null;
      this.audio.engine.stop();
      this.audio.stopMusic(0.8);
      this.disposeWorld();
      void this.loadMenuBackdrop();
      this.ui.showChampionship(state);
      this.screen = 'championshipStandings';
      this.championship = null;
      return;
    }
    const trackId = state.tracks[state.round];
    this.startRace({
      mode: 'championship',
      trackId,
      shipId: this.pendingConfig?.shipId ?? 'kestrel',
      rivals: this.pendingConfig?.rivals ?? 5,
      laps: TRACKS_BY_ID.get(trackId)?.laps ?? 3,
      difficulty: this.profile.settings.aiDifficulty,
      seed: `${state.id}-${state.round}`,
      useGhost: false,
      championshipId: state.id,
      round: state.round,
    });
  }

  applySettings(settings: GameSettings): void {
    this.profile.settings = settings;
    saveProfile(this.profile);

    this.audio.setMix({ master: settings.masterVolume, music: settings.musicVolume, sfx: settings.sfxVolume });
    this.input.configure({
      bindings: settings.bindings,
      deadzone: settings.steerDeadzone,
      invertPitch: settings.invertPitch,
    });
    this.chase.configure({
      baseFov: settings.fieldOfView,
      shakeScale: settings.cameraShake,
      reducedMotion: settings.reducedMotion,
    });
    this.governor.configure({ targetFps: settings.targetFps, enabled: settings.adaptiveQuality });

    const tier: QualityTierName = settings.qualityTier === 'auto' ? this.device.suggested : settings.qualityTier;
    if (tier !== this.governor.baseTier) {
      this.governor.setTier(tier);
      this.renderer.setQuality(this.governor.settings);
      // Geometry and particle budgets are baked in at build time, so a tier
      // change during a race needs the world rebuilding to take full effect.
      // Between races it will simply be picked up by the next load.
      if (this.screen !== 'race') void this.loadMenuBackdrop();
    }
  }

  purchaseShip(shipId: string): boolean {
    const ship = SHIPS_BY_ID.get(shipId);
    if (!ship || this.profile.unlockedShips.includes(shipId)) return false;
    if (this.profile.credits < ship.cost) {
      this.audio.play('uiError');
      return false;
    }
    this.profile.credits -= ship.cost;
    this.profile.unlockedShips.push(shipId);
    saveProfile(this.profile);
    this.ui.profileChanged();
    this.ui.toast(`${ship.name} acquired`, 'good');
    return true;
  }

  resetProfile(): void {
    localStorage.removeItem(STORAGE_KEY);
    this.profile = loadProfile();
    this.ui.profileChanged();
    this.ui.toast('Profile reset', 'info');
  }

  getProfile(): Profile {
    return this.profile;
  }

  getDevice(): DeviceProfile {
    return this.device;
  }

  getPerformance() {
    return {
      fps: this.governor.fps,
      tier: this.governor.baseTier,
      resolutionScale: this.governor.resolutionScale,
      backend: this.renderer.backend,
    };
  }

  sound(name: 'uiMove' | 'uiSelect' | 'uiBack' | 'uiError'): void {
    this.audio.play(name);
  }

  unlockAudio(): void {
    void this.audio.unlock().then(() => {
      this.audio.setMix({
        master: this.profile.settings.masterVolume,
        music: this.profile.settings.musicVolume,
        sfx: this.profile.settings.sfxVolume,
      });
    });
  }

  getTrackSummary(trackId: string): TrackSummary {
    const definition = TRACKS_BY_ID.get(trackId) ?? getTrack('neon-meridian');
    const record = this.profile.records[trackId];
    // Building the whole track just to summarise it is far too expensive for a
    // menu, so the outline comes from the raw recipe rather than the sampled
    // path — same shape, a fraction of the work.
    const track = summaryCache.get(trackId) ?? buildSummaryTrack(definition);
    summaryCache.set(trackId, track);

    return {
      id: definition.id,
      name: definition.name,
      tagline: definition.tagline,
      difficulty: definition.difficulty,
      laps: definition.laps,
      length: track.path.length,
      environment: definition.environment,
      palette: definition.palette,
      medals: track.medals,
      bestRace: record?.bestRace ?? Infinity,
      bestLap: record?.bestLap ?? Infinity,
      medal: record?.medal ?? 'none',
      unlocked: this.profile.unlockedTracks.includes(trackId),
      requires: definition.requires ?? [],
      outline: buildOutline(track),
    };
  }

  private setScreen(screen: ScreenName): void {
    this.screen = screen;
    this.ui.show(screen);
  }

  private disposeWorld(): void {
    this.world?.dispose();
    this.world = null;
  }
}

const CAMERA_LABELS: Record<string, string> = {
  chase: 'Chase camera',
  close: 'Close camera',
  cockpit: 'Cockpit camera',
};

/** Summary tracks are cached: building one is ~200 ms and menus revisit them. */
const summaryCache = new Map<string, Track>();

function buildSummaryTrack(definition: TrackDefinition): Track {
  // Coarse sampling — the summary only needs length, medals and a silhouette.
  return Track.build(definition, 12);
}

/**
 * Projects a circuit onto its dominant horizontal plane and normalises it to
 * the unit square, for the track-select preview.
 */
function buildOutline(track: Track): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  const STEPS = 140;
  const p = new Vector3();
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < STEPS; i++) {
    track.path.positionAt((i / STEPS) * track.path.length, p);
    points.push({ x: p.x, y: p.z });
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }

  // Uniform scale on both axes so the circuit keeps its real proportions.
  const span = Math.max(maxX - minX, maxZ - minZ) || 1;
  const offsetX = (span - (maxX - minX)) * 0.5;
  const offsetZ = (span - (maxZ - minZ)) * 0.5;
  return points.map((pt) => ({
    x: (pt.x - minX + offsetX) / span,
    y: (pt.y - minZ + offsetZ) / span,
  }));
}

/** Yields to the browser so the loading screen can actually paint. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
