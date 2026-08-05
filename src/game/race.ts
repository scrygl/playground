import type { Track } from '../track/runtime';
import type { TrackFeature } from '../track/types';
import type { GameAudio } from '../audio/types';
import type { MedalTier } from './profile';
import { medalFor } from './profile';
import type {
  GameMode,
  HudSnapshot,
  RaceConfig,
  RacePhase,
  RaceResult,
  RacerStanding,
  LapResult,
} from './types';
import { RIVAL_NAMES } from './types';
import { Driver } from './driver';
import { GhostPlayer, GhostRecorder } from './ghost';
import { SHIPS, getShip } from './ships';
import { Vehicle, neutralControls, type ControlState } from './vehicle';
import { Rng } from '../core/rng';
import { clamp, clamp01, lerp, mod } from '../core/mathx';

/**
 * The race director: owns every craft on the circuit and the rules they race
 * under.
 *
 * Simulation runs on a fixed 120 Hz step decoupled from the render rate. A
 * racing game's handling is only as consistent as its timestep — variable-dt
 * integration makes the same corner behave differently on a 144 Hz monitor than
 * on a 60 Hz one, and makes lap records meaningless.
 */

/** Physics tick, seconds. */
const FIXED_STEP = 1 / 120;
/** Never simulate more than this much wall time in one frame; drop the rest. */
const MAX_CATCHUP = 0.25;
/** Seconds of countdown before the lights go out. */
const COUNTDOWN_SECONDS = 3.4;

/** Longitudinal separation below which two craft are considered in contact. */
const CONTACT_LENGTH = 11;
const CONTACT_WIDTH = 8.4;
/** Range over which a craft ahead provides a tow, in metres. */
const SLIPSTREAM_RANGE = 62;
/** Rhythm-gate timing window, as a fraction of a beat. */
const PERFECT_WINDOW = 0.14;
/** Seconds a collected pickup stays gone. */
const PICKUP_RESPAWN = 7;
/** Elimination mode: seconds between culls. */
const ELIMINATION_INTERVAL = 20;

export type RaceEvent =
  | { type: 'countdown'; count: number }
  | { type: 'start' }
  | { type: 'lap'; racer: number; lap: number; time: number }
  | { type: 'finish'; racer: number }
  | { type: 'boostPad'; racer: number }
  | { type: 'gate'; racer: number; feature: number; perfect: boolean }
  | { type: 'gateMiss'; racer: number }
  | { type: 'pickup'; racer: number; feature: number; kind: string }
  | { type: 'impact'; racer: number; strength: number }
  | { type: 'scrape'; racer: number; strength: number }
  | { type: 'land'; racer: number; strength: number }
  | { type: 'destroyed'; racer: number }
  | { type: 'respawn'; racer: number }
  | { type: 'eliminated'; racer: number }
  | { type: 'turbo'; racer: number; tier: number }
  | { type: 'zone'; level: number };

export interface Racer {
  index: number;
  id: string;
  name: string;
  shipId: string;
  isPlayer: boolean;
  vehicle: Vehicle;
  driver: Driver | null;
  position: number;
  finished: boolean;
  finishTime: number;
  eliminated: boolean;
  lapTimes: number[];
  bestLap: number;
  lapStartTime: number;
  /** Consecutive rhythm gates hit. */
  grooveChain: number;
  score: number;
  /** Set while an AI has someone directly in front, to make it go around. */
  avoidDirection: number;
}

export interface RaceOptions {
  track: Track;
  config: RaceConfig;
  audio?: GameAudio | null;
  /** Recorded best lap to race against, if any. */
  ghostData?: number[];
  previousMedal?: MedalTier;
}

export class Race {
  readonly track: Track;
  readonly config: RaceConfig;
  readonly racers: Racer[] = [];
  readonly player: Racer;
  readonly events: RaceEvent[] = [];

  phase: RacePhase = 'countdown';
  /** Milliseconds since the lights went out. Negative during the countdown. */
  time = 0;
  /** Zone mode: the current speed step. */
  zone = 0;
  /** Pursuit mode: 0..1 proximity of the nearest interceptor. */
  threat = 0;

  private readonly audio: GameAudio | null;
  private readonly rng: Rng;
  private accumulator = 0;
  private countdown = COUNTDOWN_SECONDS;
  private lastCountdownTick = 99;
  /** Wall-clock seconds a feature stays consumed, keyed by feature index. */
  private readonly featureCooldown: Float32Array;
  private eliminationTimer = ELIMINATION_INTERVAL;
  private readonly ghost: GhostPlayer | null;
  private readonly recorder = new GhostRecorder();
  private bestLapGhost: number[] | null = null;
  private recordingLap = true;
  private banner = '';
  private bannerKind: HudSnapshot['bannerKind'] = 'none';
  private bannerTimer = 0;
  private zoneTimer = 0;
  private finishOrder = 0;
  private result: RaceResult | null = null;
  private readonly snapshot: HudSnapshot;
  private readonly standings: RacerStanding[] = [];
  private musicIntensity = 0.4;

  constructor(options: RaceOptions) {
    this.track = options.track;
    this.config = options.config;
    this.audio = options.audio ?? null;
    this.rng = new Rng(`${options.config.seed}:race`);
    this.featureCooldown = new Float32Array(this.track.features.length);

    const entrants = this.buildGrid();
    this.player = entrants.player;

    this.ghost =
      options.ghostData && options.ghostData.length > 0 && this.config.useGhost
        ? new GhostPlayer(options.ghostData, this.track.path.length)
        : null;

    this.snapshot = createSnapshot(this.config.mode, this.config.laps, this.racers.length);
    for (const racer of this.racers) {
      this.standings.push({
        id: racer.id,
        name: racer.name,
        shipId: racer.shipId,
        isPlayer: racer.isPlayer,
        position: racer.position,
        lap: 0,
        progress: 0,
        gap: 0,
        finished: false,
        eliminated: false,
        finishTime: 0,
        shield: 1,
        bestLap: Infinity,
      });
    }
    this.snapshot.standings = this.standings;
  }

  private buildGrid(): { player: Racer } {
    const { config, track } = this;
    const rivalCount = config.rivals;
    const total = rivalCount + 1;

    // The player starts at the back of the grid: overtaking is the game, and
    // a race that begins with clear air ahead is a much better one.
    const playerSlot = Math.min(total - 1, Math.max(0, total - 1));
    const names = [...RIVAL_NAMES];
    this.rng.shuffle(names);

    for (let i = 0; i < total; i++) {
      const isPlayer = i === playerSlot;
      const slot = track.gridSlot(i, total);
      const shipId = isPlayer ? config.shipId : this.pickRivalShip(i);
      const stats = getShip(shipId).stats;
      // The grid is behind the start line, so every craft begins on lap -1;
      // its first crossing starts lap one instead of completing it.
      const vehicle = new Vehicle({ track, stats, s: slot.s, lateral: slot.lateral, lap: -1 });

      // Rival skill fans out around the chosen difficulty so the field spreads
      // into a believable order instead of arriving as a single block.
      const spread = (i / Math.max(1, total - 1) - 0.5) * 0.26;
      const skill = clamp(config.difficulty + spread + this.rng.range(-0.05, 0.05), 0.12, 1);

      const racer: Racer = {
        index: i,
        id: isPlayer ? 'player' : `ai-${i}`,
        name: isPlayer ? 'YOU' : (names[i % names.length] ?? `RIVAL ${i}`),
        shipId,
        isPlayer,
        vehicle,
        driver: isPlayer ? null : new Driver(track, { skill, seed: `${config.seed}:ai:${i}` }),
        position: i + 1,
        finished: false,
        finishTime: 0,
        eliminated: false,
        lapTimes: [],
        bestLap: Infinity,
        lapStartTime: 0,
        grooveChain: 0,
        score: 0,
        avoidDirection: 0,
      };
      this.racers.push(racer);
    }
    return { player: this.racers[playerSlot] };
  }

  private pickRivalShip(index: number): string {
    // Deterministic per grid slot so a restarted race faces the same field.
    return SHIPS[(index * 3 + 1) % SHIPS.length].id;
  }

  // --- Main loop ---------------------------------------------------------

  /**
   * Advances the race by one rendered frame.
   *
   * `frameDt` is real elapsed time; the simulation consumes it in fixed steps
   * and carries the remainder, so physics never sees a variable timestep.
   */
  update(frameDt: number, controls: ControlState): void {
    if (this.phase === 'finished' || this.phase === 'failed') {
      this.refreshSnapshot();
      return;
    }

    const dt = Math.min(frameDt, MAX_CATCHUP);
    this.accumulator += dt;

    let guard = 0;
    while (this.accumulator >= FIXED_STEP && guard++ < 64) {
      this.accumulator -= FIXED_STEP;
      this.step(FIXED_STEP, controls);
    }

    this.updateBanner(dt);
    this.updateMusic(dt);
    this.refreshSnapshot();
  }

  private step(dt: number, controls: ControlState): void {
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      const tick = Math.ceil(this.countdown);
      if (tick !== this.lastCountdownTick && tick >= 0) {
        this.lastCountdownTick = tick;
        this.events.push({ type: 'countdown', count: tick });
        this.audio?.play(tick === 0 ? 'countdownGo' : 'countdownTick');
      }
      if (this.countdown <= 0) {
        this.phase = 'racing';
        this.time = 0;
        this.events.push({ type: 'start' });
        for (const r of this.racers) r.lapStartTime = 0;
      } else {
        // Craft are held on the line, but the engine note should still build.
        for (const racer of this.racers) racer.vehicle.step(neutralControls(), dt);
        return;
      }
    }

    this.time += dt * 1000;

    for (const racer of this.racers) {
      if (racer.eliminated) continue;
      if (racer.finished) {
        // Finished craft keep rolling so they do not stop dead on the line.
        racer.vehicle.step(coastControls, dt);
        continue;
      }
      const input = racer.isPlayer ? this.playerControls(controls, racer) : this.aiControls(racer, dt);
      const previousS = racer.vehicle.s;
      racer.vehicle.step(input, dt);
      this.consumeVehicleEvents(racer);
      this.processFeatures(racer, previousS);
    }

    this.resolveContacts();
    this.updateSlipstream();
    this.updatePositions();
    this.applyModeRules(dt);
    this.tickFeatureCooldowns(dt);

    if (this.recordingLap && !this.player.finished) {
      this.recorder.record(this.player.vehicle, this.time - this.player.lapStartTime);
    }
  }

  private playerControls(controls: ControlState, racer: Racer): ControlState {
    if (this.config.mode === 'zone') {
      // Zone mode takes the throttle away: the craft accelerates on its own
      // schedule and the player's only job is to keep it on the track.
      zoneControls.steer = controls.steer;
      zoneControls.airbrakeLeft = controls.airbrakeLeft;
      zoneControls.airbrakeRight = controls.airbrakeRight;
      zoneControls.pitch = controls.pitch;
      zoneControls.throttle = 1;
      zoneControls.brake = 0;
      zoneControls.boost = false;
      zoneControls.useItem = false;
      // Speed target climbs one step per zone and never comes back down.
      const target = lerp(0.55, 1.6, clamp01(this.zone / 24));
      racer.vehicle.slipstream = clamp((target - racer.vehicle.normalisedSpeed) * 2.2, -0.4, 1.2);
      return zoneControls;
    }
    return controls;
  }

  private aiControls(racer: Racer, dt: number): ControlState {
    const driver = racer.driver;
    if (!driver) return neutralControls();

    // Rubber-banding rides on the same drag term the slipstream uses: a craft
    // that has fallen behind gets a tow it did not earn, one that has run away
    // pushes a little more air. It is invisible, bounded, and never touches
    // the AI's line — a rival that is beating you is genuinely driving better.
    const delta = this.player.vehicle.progress - racer.vehicle.progress;
    const band = clamp(delta / 500, -0.32, 0.45) * (this.config.mode === 'timetrial' ? 0 : 1);
    racer.vehicle.slipstream = Math.max(racer.vehicle.slipstream, band);

    return driver.update(racer.vehicle, dt, racer.avoidDirection);
  }

  private consumeVehicleEvents(racer: Racer): void {
    const vehicle = racer.vehicle;
    for (const e of vehicle.events) {
      switch (e.type) {
        case 'wallImpact':
          this.events.push({ type: 'impact', racer: racer.index, strength: e.strength });
          if (racer.isPlayer) {
            racer.grooveChain = 0;
            this.audio?.duck(0.35, 0.25);
          }
          break;
        case 'scrape':
          this.events.push({ type: 'scrape', racer: racer.index, strength: e.strength });
          break;
        case 'land':
          this.events.push({ type: 'land', racer: racer.index, strength: e.strength });
          break;
        case 'destroyed':
          this.events.push({ type: 'destroyed', racer: racer.index });
          if (racer.isPlayer) racer.grooveChain = 0;
          break;
        case 'respawn':
          this.events.push({ type: 'respawn', racer: racer.index });
          break;
        case 'turboFired':
          this.events.push({ type: 'turbo', racer: racer.index, tier: e.tier });
          break;
        case 'lap':
          this.completeLap(racer);
          break;
        default:
          break;
      }
    }
    vehicle.events.length = 0;
  }

  private completeLap(racer: Racer): void {
    // Lap 0 is the run from the grid to the start line. It is not a lap: the
    // clock starts here, and anything recorded on the way is discarded.
    if (racer.vehicle.lap <= 0) {
      racer.lapStartTime = this.time;
      if (racer.isPlayer) this.recorder.reset();
      return;
    }

    const lapTime = this.time - racer.lapStartTime;
    racer.lapStartTime = this.time;
    racer.lapTimes.push(lapTime);
    const isBest = lapTime < racer.bestLap;
    if (isBest) racer.bestLap = lapTime;

    this.events.push({ type: 'lap', racer: racer.index, lap: racer.vehicle.lap, time: lapTime });

    if (racer.isPlayer) {
      // Keep the recording only if this lap beat the previous best; otherwise
      // the ghost would drift toward whatever the player did most recently.
      if (isBest) this.bestLapGhost = this.recorder.finish();
      this.recorder.reset();
      this.audio?.play('lapComplete');
      if (racer.vehicle.lap === this.config.laps - 1) this.setBanner('FINAL LAP', 'info', 2.6);
    }

    if (racer.vehicle.lap >= this.config.laps && this.config.mode !== 'endless' && this.config.mode !== 'zone') {
      this.finishRacer(racer);
    }
  }

  private finishRacer(racer: Racer): void {
    if (racer.finished) return;
    racer.finished = true;
    racer.finishTime = this.time;
    racer.position = ++this.finishOrder;
    this.events.push({ type: 'finish', racer: racer.index });
    if (racer.isPlayer) {
      this.audio?.play('finish');
      this.completeRace(true);
    }
  }

  // --- Features ----------------------------------------------------------

  /**
   * Applies every track feature the craft crossed this step.
   *
   * Scanning all features is cheap enough at this scale (tens of features,
   * eight craft) and is immune to the ordering bugs a moving cursor invites
   * when a craft reverses, respawns, or crosses the start line mid-step.
   */
  private processFeatures(racer: Racer, previousS: number): void {
    const features = this.track.features;
    const length = this.track.path.length;
    const s = racer.vehicle.s;
    if (s === previousS) return;

    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      if (!crossedForward(previousS, s, f.s, length)) continue;
      this.applyFeature(racer, f, i);
    }
  }

  private applyFeature(racer: Racer, feature: TrackFeature, index: number): void {
    const vehicle = racer.vehicle;
    const halfWidth = this.track.path.halfWidthAt(feature.s);
    const featureLateral = feature.lateral * halfWidth;
    const reach = Math.max(5, halfWidth * feature.size);
    const within = Math.abs(vehicle.lateral - featureLateral) <= reach;

    switch (feature.kind) {
      case 'checkpoint':
        vehicle.noteCheckpoint(feature.s);
        break;

      case 'boost':
        if (within && this.featureCooldown[index] <= 0) {
          vehicle.applyBoost(1.5, 1);
          this.events.push({ type: 'boostPad', racer: racer.index });
          if (racer.isPlayer) this.audio?.play('boostPad');
        }
        break;

      case 'beatgate':
        this.applyBeatGate(racer, index, within);
        break;

      case 'shield':
        if (within && this.featureCooldown[index] <= 0) {
          vehicle.heal(vehicle.stats.shield * 0.34);
          this.featureCooldown[index] = PICKUP_RESPAWN;
          this.events.push({ type: 'pickup', racer: racer.index, feature: index, kind: 'shield' });
          if (racer.isPlayer) this.audio?.play('shieldPickup');
        }
        break;

      case 'weapon':
        if (within && this.featureCooldown[index] <= 0) {
          // Weapon pads grant an immediate turbo rather than an inventory item.
          // A held item needs targeting, projectiles, and counterplay to be fair;
          // an instant reward keeps the pads meaningful without half-building
          // a combat system that would not stand up next to the driving.
          vehicle.applyBoost(1.1, 0.8);
          vehicle.heal(vehicle.stats.shield * 0.12);
          this.featureCooldown[index] = PICKUP_RESPAWN;
          this.events.push({ type: 'pickup', racer: racer.index, feature: index, kind: 'weapon' });
          if (racer.isPlayer) this.audio?.play('weaponPickup');
        }
        break;

      case 'hazard':
        if (within) vehicle.damage(14);
        break;
    }
  }

  /**
   * Rhythm gates: the Thumper half of the game.
   *
   * Passing through is worth something; passing through *on the beat* is worth
   * much more, and chains into a multiplier. The timing window is read from the
   * audio clock, which is derived from the hardware clock and already
   * latency-compensated — so it is judged against what the player actually
   * heard, not against when the note was queued.
   */
  private applyBeatGate(racer: Racer, index: number, within: boolean): void {
    if (!within) {
      if (racer.isPlayer && racer.grooveChain > 0) {
        racer.grooveChain = 0;
        this.events.push({ type: 'gateMiss', racer: racer.index });
        this.audio?.play('gateMiss');
      }
      return;
    }

    const clock = this.audio?.clock;
    let perfect = false;
    if (clock?.running) {
      const phase = clock.beatPhase;
      perfect = phase < PERFECT_WINDOW || phase > 1 - PERFECT_WINDOW;
    } else {
      // With no music running (tests, or audio still locked) every gate counts
      // as a clean pass so the mechanic degrades instead of breaking.
      perfect = true;
    }

    racer.grooveChain++;
    const multiplier = grooveMultiplier(racer.grooveChain);
    const bonus = racer.vehicle.stats.grooveBonus;

    if (perfect) {
      racer.vehicle.applyBoost(0.5 * bonus, 0.55);
      racer.score += Math.round(150 * multiplier * bonus);
    } else {
      racer.score += Math.round(40 * multiplier);
    }

    this.events.push({ type: 'gate', racer: racer.index, feature: index, perfect });
    if (racer.isPlayer) {
      this.audio?.play(perfect ? 'gatePerfect' : 'gateHit', { rate: 1 + Math.min(racer.grooveChain, 12) * 0.03 });
      if (perfect && racer.grooveChain % 4 === 0) this.setBanner(`PERFECT ×${racer.grooveChain}`, 'good', 1.1);
    }
  }

  private tickFeatureCooldowns(dt: number): void {
    for (let i = 0; i < this.featureCooldown.length; i++) {
      if (this.featureCooldown[i] > 0) this.featureCooldown[i] = Math.max(0, this.featureCooldown[i] - dt);
    }
  }

  // --- Interactions ------------------------------------------------------

  /** Ship-to-ship contact: shove apart by mass, scrub a little speed. */
  private resolveContacts(): void {
    const length = this.track.path.length;
    for (let i = 0; i < this.racers.length; i++) {
      const a = this.racers[i];
      if (a.eliminated) continue;
      a.avoidDirection = 0;
      for (let j = i + 1; j < this.racers.length; j++) {
        const b = this.racers[j];
        if (b.eliminated) continue;

        const along = Math.abs(shortest(a.vehicle.s, b.vehicle.s, length));
        if (along > CONTACT_LENGTH) continue;
        const across = b.vehicle.lateral - a.vehicle.lateral;
        if (Math.abs(across) > CONTACT_WIDTH) continue;

        const direction = across >= 0 ? 1 : -1;
        const totalMass = a.vehicle.stats.mass + b.vehicle.stats.mass;
        // The heavier craft barely moves; the lighter one gets pushed wide.
        const aShare = b.vehicle.stats.mass / totalMass;
        const bShare = a.vehicle.stats.mass / totalMass;
        const push = (CONTACT_WIDTH - Math.abs(across)) * 2.4;

        a.vehicle.addLateralImpulse(-direction * push * aShare);
        b.vehicle.addLateralImpulse(direction * push * bShare);

        const severity = clamp01(Math.abs(a.vehicle.velocityLateral - b.vehicle.velocityLateral) / 30);
        if (severity > 0.25) {
          a.vehicle.damage(severity * 6 * aShare);
          b.vehicle.damage(severity * 6 * bShare);
          if (a.isPlayer || b.isPlayer) {
            this.events.push({
              type: 'impact',
              racer: a.isPlayer ? a.index : b.index,
              strength: severity * 0.7,
            });
          }
        }
      }
    }

    // Tell each AI which way to go round anything directly in front of it.
    for (const a of this.racers) {
      if (a.isPlayer || a.eliminated) continue;
      for (const b of this.racers) {
        if (b === a || b.eliminated) continue;
        const gap = shortest(a.vehicle.s, b.vehicle.s, length);
        if (gap > 4 && gap < 46 && Math.abs(b.vehicle.lateral - a.vehicle.lateral) < 11) {
          a.avoidDirection = b.vehicle.lateral >= a.vehicle.lateral ? -1 : 1;
          break;
        }
      }
    }
  }

  /** A craft close behind another gets a tow, exactly as in real racing. */
  private updateSlipstream(): void {
    const length = this.track.path.length;
    for (const a of this.racers) {
      if (a.eliminated) continue;
      let best = 0;
      for (const b of this.racers) {
        if (b === a || b.eliminated) continue;
        const gap = shortest(a.vehicle.s, b.vehicle.s, length);
        if (gap <= CONTACT_LENGTH * 0.6 || gap > SLIPSTREAM_RANGE) continue;
        if (Math.abs(b.vehicle.lateral - a.vehicle.lateral) > 9) continue;
        best = Math.max(best, 1 - gap / SLIPSTREAM_RANGE);
      }
      a.vehicle.slipstream = Math.max(a.vehicle.slipstream, best);
    }
  }

  private updatePositions(): void {
    // Finished craft hold the order they crossed the line; everyone still
    // running is ranked by distance covered.
    const running = this.racers.filter((r) => !r.finished && !r.eliminated);
    running.sort((a, b) => b.vehicle.progress - a.vehicle.progress);
    const finishedCount = this.racers.filter((r) => r.finished).length;

    const before = this.player.position;
    running.forEach((racer, i) => {
      racer.position = finishedCount + i + 1;
    });
    // Eliminated craft are ranked behind everyone still in the race.
    const eliminated = this.racers.filter((r) => r.eliminated);
    eliminated.forEach((racer, i) => {
      racer.position = finishedCount + running.length + i + 1;
    });

    if (!this.player.finished && this.player.position < before) {
      this.setBanner(`P${this.player.position}`, 'good', 0.9);
    }
  }

  // --- Mode rules --------------------------------------------------------

  private applyModeRules(dt: number): void {
    switch (this.config.mode) {
      case 'elimination':
        this.eliminationTimer -= dt;
        if (this.eliminationTimer <= 0) {
          this.eliminationTimer = ELIMINATION_INTERVAL;
          this.cullLastPlace();
        }
        break;

      case 'zone': {
        this.zoneTimer += dt;
        // A zone every fifteen seconds; the pace never comes back down.
        if (this.zoneTimer >= 15) {
          this.zoneTimer = 0;
          this.zone++;
          this.player.score += 500 * this.zone;
          this.events.push({ type: 'zone', level: this.zone });
          this.setBanner(`ZONE ${this.zone}`, 'good', 1.6);
        }
        if (this.player.vehicle.shieldFraction <= 0.001) this.completeRace(false);
        break;
      }

      case 'pursuit': {
        // Interceptors are the leading rivals; they hunt the player rather
        // than racing the circuit, and wear the shield down on contact.
        let nearest = Infinity;
        const length = this.track.path.length;
        for (const r of this.racers) {
          if (r.isPlayer || r.eliminated) continue;
          const gap = Math.abs(shortest(this.player.vehicle.s, r.vehicle.s, length));
          nearest = Math.min(nearest, gap);
        }
        this.threat = clamp01(1 - nearest / 140);
        if (this.threat > 0.92) this.player.vehicle.damage(9 * dt);
        if (this.player.vehicle.shieldFraction <= 0.001) this.completeRace(false);
        break;
      }

      default:
        break;
    }

    // Falling to nothing outside a survival mode is a setback, not a failure:
    // the craft respawns and the race carries on.
    if (this.config.mode === 'timetrial' && this.player.vehicle.lap >= this.config.laps) {
      if (!this.player.finished) this.finishRacer(this.player);
    }
  }

  private cullLastPlace(): void {
    const alive = this.racers.filter((r) => !r.eliminated && !r.finished);
    if (alive.length <= 1) return;
    alive.sort((a, b) => a.vehicle.progress - b.vehicle.progress);
    const victim = alive[0];
    victim.eliminated = true;
    this.events.push({ type: 'eliminated', racer: victim.index });
    if (victim.isPlayer) {
      this.audio?.play('eliminated');
      this.completeRace(false);
    } else {
      this.setBanner(`${victim.name} ELIMINATED`, 'info', 2);
      if (alive.length === 2) this.finishRacer(this.player);
    }
  }

  // --- Presentation feeds -------------------------------------------------

  private setBanner(text: string, kind: HudSnapshot['bannerKind'], seconds: number): void {
    this.banner = text;
    this.bannerKind = kind;
    this.bannerTimer = seconds;
  }

  private updateBanner(dt: number): void {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) {
        this.banner = '';
        this.bannerKind = 'none';
      }
    }
  }

  /**
   * Drives the music's arrangement from how the race is actually going.
   *
   * Intensity rises with speed, with proximity to the craft ahead, and with
   * the groove chain — so the track thickens as a battle develops and thins
   * out when the player is cruising alone.
   */
  private updateMusic(dt: number): void {
    const v = this.player.vehicle;
    const battle = clamp01(v.slipstream * 1.4);
    const groove = clamp01(this.player.grooveChain / 16);
    const pace = clamp01(v.normalisedSpeed * 0.75 + battle * 0.3 + groove * 0.25);
    const target = this.phase === 'racing' ? pace : 0.18;
    // Smoothed here as well as in the audio engine; this one stops a single
    // wall impact from audibly dropping the arrangement.
    this.musicIntensity += (target - this.musicIntensity) * clamp01(dt * 1.5);
    this.audio?.setMusicIntensity(this.musicIntensity);

    const engine = this.audio?.engine;
    if (engine) {
      engine.setSpeed(v.normalisedSpeed);
      engine.setThrottle(this.phase === 'racing' ? 1 : 0.15);
      engine.setBoost(v.boostAmount);
      engine.setSlip(v.slip);
    }
  }

  // --- Snapshot ------------------------------------------------------------

  private refreshSnapshot(): void {
    const s = this.snapshot;
    const v = this.player.vehicle;
    const path = this.track.path;

    s.phase = this.phase;
    s.countdown = Math.max(0, Math.ceil(this.countdown));
    s.time = Math.max(0, this.time);
    s.lap = Math.min(v.lap + 1, this.config.laps);
    s.totalLaps = this.config.laps;
    s.position = this.player.position;
    s.entrants = this.racers.length;
    s.speed = v.speed;
    s.speedFraction = v.normalisedSpeed;
    s.shield = v.shield;
    s.shieldFraction = v.shieldFraction;
    s.boost = v.boostAmount;
    s.turboTier = v.turboTier;
    s.currentLapTime = Math.max(0, this.time - this.player.lapStartTime);
    s.lastLapTime = this.player.lapTimes.length ? this.player.lapTimes[this.player.lapTimes.length - 1] : 0;
    s.bestLapTime = this.player.bestLap;
    s.grooveChain = this.player.grooveChain;
    s.grooveMultiplier = grooveMultiplier(this.player.grooveChain);
    s.score = this.player.score;
    s.lapProgress = path.wrap(v.s) / path.length;
    s.zone = this.zone;
    s.threat = this.threat;
    s.banner = this.banner;
    s.bannerKind = this.bannerKind;

    // Ghost delta: how far ahead or behind the stored best lap we are at this
    // exact point on the track — the only comparison that means anything.
    if (this.ghost?.valid) {
      const ghostTime = this.ghost.timeAtDistance(v.s);
      s.ghostDelta = s.currentLapTime - ghostTime;
    } else {
      s.ghostDelta = NaN;
    }

    const leader = this.racers.reduce((a, b) => (b.vehicle.progress > a.vehicle.progress ? b : a));
    for (let i = 0; i < this.racers.length; i++) {
      const racer = this.racers[i];
      const row = this.standings[i];
      row.position = racer.position;
      row.lap = racer.vehicle.lap;
      row.progress = racer.vehicle.progress;
      row.finished = racer.finished;
      row.eliminated = racer.eliminated;
      row.finishTime = racer.finishTime;
      row.shield = racer.vehicle.shieldFraction;
      row.bestLap = racer.bestLap;
      // Gap expressed in seconds at current pace, which is what a driver
      // actually wants to know.
      const behind = leader.vehicle.progress - racer.vehicle.progress;
      row.gap = behind <= 0 ? 0 : behind / Math.max(racer.vehicle.speed, 25);
    }
    this.standings.sort((a, b) => a.position - b.position);
  }

  get hud(): HudSnapshot {
    return this.snapshot;
  }

  /** Ghost recorded for the fastest lap of this race, if it beat the old one. */
  get recordedGhost(): number[] | null {
    return this.bestLapGhost;
  }

  /** Pose of the ghost craft for rendering, or null when there is none. */
  ghostPose(): { s: number; lateral: number; height: number; yaw: number; roll: number; pitch: number } | null {
    if (!this.ghost?.valid || this.phase !== 'racing') return null;
    return this.ghost.seek(this.time - this.player.lapStartTime);
  }

  // --- Completion ----------------------------------------------------------

  private completeRace(finished: boolean): void {
    if (this.result) return;
    this.phase = finished ? 'finished' : 'failed';

    const laps: LapResult[] = this.player.lapTimes.map((time, i) => ({
      lap: i + 1,
      time,
      best: time === this.player.bestLap,
    }));

    const medal: MedalTier =
      finished && this.config.mode !== 'endless' ? medalFor(this.time, this.track.medals) : 'none';

    this.result = {
      finished,
      position: this.player.position,
      entrants: this.racers.length,
      totalTime: this.time,
      bestLap: this.player.bestLap,
      laps,
      medal,
      previousMedal: 'none',
      creditsEarned: 0,
      newRecord: false,
      score: this.player.score,
      unlockedTracks: [],
      standings: this.standings.map((row) => ({ ...row })),
    };
  }

  /** Ends the race early, e.g. when the player quits from the pause menu. */
  abandon(): void {
    this.completeRace(false);
  }

  getResult(): RaceResult | null {
    return this.result;
  }

  get isOver(): boolean {
    return this.phase === 'finished' || this.phase === 'failed';
  }
}

// --- Helpers ----------------------------------------------------------------

/** Multiplier earned by a groove chain, capped so it cannot run away. */
export function grooveMultiplier(chain: number): number {
  return 1 + Math.min(chain, 30) * 0.0667;
}

/**
 * Did a craft moving from `prev` to `next` pass `target` in the forward
 * direction? Handles wrapping across the start line, and ignores the case
 * where the craft went backwards.
 */
export function crossedForward(prev: number, next: number, target: number, length: number): boolean {
  const travelled = mod(next - prev, length);
  // A "forward" move of more than half the lap is really a reverse move.
  if (travelled === 0 || travelled > length * 0.5) return false;
  const toTarget = mod(target - prev, length);
  return toTarget > 0 && toTarget <= travelled;
}

/** Signed forward distance from `a` to `b` around the loop. */
function shortest(a: number, b: number, length: number): number {
  let d = mod(b - a, length);
  if (d > length * 0.5) d -= length;
  return d;
}

function createSnapshot(mode: GameMode, laps: number, entrants: number): HudSnapshot {
  return {
    phase: 'countdown',
    mode,
    countdown: 3,
    time: 0,
    lap: 1,
    totalLaps: laps,
    position: entrants,
    entrants,
    speed: 0,
    speedFraction: 0,
    shield: 100,
    shieldFraction: 1,
    boost: 0,
    turboTier: 0,
    currentLapTime: 0,
    lastLapTime: 0,
    bestLapTime: Infinity,
    ghostDelta: NaN,
    grooveChain: 0,
    grooveMultiplier: 1,
    score: 0,
    standings: [],
    lapProgress: 0,
    zone: 0,
    threat: 0,
    banner: '',
    bannerKind: 'none',
  };
}

/** Shared control objects, so the hot loop never allocates. */
const coastControls: ControlState = { ...neutralControls(), throttle: 0.35 };
const zoneControls: ControlState = neutralControls();
