/* SCRATCH HARNESS — not part of the game. Mounts the UI with a stub host so
   every screen can be screenshotted. Deleted once the UI is signed off. */

import { VelocityHorizonUi } from './ui/index';
import type { TrackSummary, UiHost } from './ui/types';
import type { ChampionshipState, HudSnapshot, RaceConfig, RaceResult } from './game/types';
import type { GameSettings, Profile } from './game/profile';
import { defaultProfile } from './game/profile';
import { TRACKS, TRACKS_BY_ID } from './track/library';
import type { TrackDefinition } from './track/types';

// --- fake outlines ---------------------------------------------------------

interface P {
  x: number;
  y: number;
}

function outlineFor(track: TrackDefinition): P[] {
  const pts: P[] = [];
  let x = 0;
  let y = 0;
  let heading = 0;
  const push = (): void => pts.push({ x, y });
  const advance = (dist: number, steps: number): void => {
    for (let i = 0; i < steps; i++) {
      x += Math.cos(heading) * (dist / steps);
      y += Math.sin(heading) * (dist / steps);
      push();
    }
  };
  push();
  for (const seg of track.segments) {
    switch (seg.kind) {
      case 'straight':
        advance(seg.length, Math.max(2, Math.round(seg.length / 60)));
        break;
      case 'gap':
        advance(seg.length, 2);
        break;
      case 'corkscrew':
        advance(seg.length, Math.max(2, Math.round(seg.length / 60)));
        break;
      case 'loop':
        advance(seg.radius * 1.6, 3);
        break;
      case 'roll':
        advance(seg.length, 2);
        break;
      case 'pitch':
        advance((Math.abs(seg.angle) * Math.PI * seg.radius) / 180, 3);
        break;
      case 'turn':
      case 'helix': {
        const total = (seg.angle * Math.PI) / 180;
        const steps = Math.max(3, Math.round(Math.abs(seg.angle) / 8));
        for (let i = 0; i < steps; i++) {
          heading += total / steps;
          x += Math.cos(heading) * ((Math.abs(total) * seg.radius) / steps);
          y += Math.sin(heading) * ((Math.abs(total) * seg.radius) / steps);
          push();
        }
        break;
      }
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  return pts.map((p) => ({ x: (p.x - minX) / span, y: (p.y - minY) / span }));
}

function lengthOf(track: TrackDefinition): number {
  let total = 0;
  for (const seg of track.segments) {
    if (seg.kind === 'straight' || seg.kind === 'gap' || seg.kind === 'corkscrew' || seg.kind === 'roll') total += seg.length;
    else if (seg.kind === 'turn' || seg.kind === 'helix') total += (Math.abs(seg.angle) * Math.PI * seg.radius) / 180;
    else if (seg.kind === 'pitch') total += (Math.abs(seg.angle) * Math.PI * seg.radius) / 180;
    else if (seg.kind === 'loop') total += 2 * Math.PI * seg.radius;
  }
  return Math.round(total);
}

// --- stub host -------------------------------------------------------------

const profile: Profile = defaultProfile();
profile.credits = 12450;
profile.totalRaces = 37;
profile.totalDistance = 412_800;
profile.unlockedShips = ['kestrel', 'vyper', 'anvil'];
profile.unlockedTracks = ['neon-meridian', 'solstice-ring', 'helix-gate', 'ironbound', 'cascade-run'];
profile.records = {
  'neon-meridian': { bestRace: 187_420, bestLap: 61_180, medal: 'gold', ship: 'kestrel', completions: 6 },
  'solstice-ring': { bestRace: 214_900, bestLap: 70_240, medal: 'silver', ship: 'vyper', completions: 3 },
  'helix-gate': { bestRace: 198_300, bestLap: 64_760, medal: 'bronze', ship: 'kestrel', completions: 2 },
  'ironbound': { bestRace: 231_040, bestLap: 75_010, medal: 'author', ship: 'anvil', completions: 4 },
};
profile.championships = { vector: 1, ascent: 4 };

const summaries = new Map<string, TrackSummary>();
for (const track of TRACKS) {
  const length = lengthOf(track);
  const base = (length / 118) * 1000;
  const record = profile.records[track.id];
  summaries.set(track.id, {
    id: track.id,
    name: track.name,
    tagline: track.tagline,
    difficulty: track.difficulty,
    laps: track.laps,
    length,
    environment: track.environment,
    palette: {
      primary: track.palette.primary,
      secondary: track.palette.secondary,
      deep: track.palette.deep,
      glow: track.palette.glow,
    },
    medals: {
      author: Math.round(base * 0.9 * track.laps),
      gold: Math.round(base * 0.97 * track.laps),
      silver: Math.round(base * 1.05 * track.laps),
      bronze: Math.round(base * 1.16 * track.laps),
    },
    bestRace: record?.bestRace ?? Infinity,
    bestLap: record?.bestLap ?? Infinity,
    medal: record?.medal ?? 'none',
    unlocked: profile.unlockedTracks.includes(track.id),
    requires: track.requires ?? [],
    outline: outlineFor(track),
  });
}

const host: UiHost = {
  startRace(config: RaceConfig) {
    console.log('startRace', config);
    ui.show('loading');
  },
  abandonRace() {
    ui.show('title');
  },
  resumeRace() {
    ui.show('race');
  },
  restartRace() {
    ui.show('race');
  },
  advanceChampionship() {
    ui.show('loading');
  },
  applySettings(settings: GameSettings) {
    profile.settings = settings;
  },
  purchaseShip(shipId: string) {
    if (shipId === 'zenith') return false;
    if (!profile.unlockedShips.includes(shipId)) profile.unlockedShips.push(shipId);
    return true;
  },
  resetProfile() {},
  getProfile: () => profile,
  getDevice: () => ({
    webgpu: true,
    adapter: 'NVIDIA GeForce RTX 4070 Laptop GPU (ANGLE Vulkan)',
    klass: 'discrete',
    mobile: false,
    cores: 16,
    memoryGb: 32,
    suggested: 'ultra',
  }),
  getPerformance: () => ({ fps: 141 + Math.round(Math.sin(Date.now() / 800) * 4), tier: 'ultra', resolutionScale: 1, backend: 'webgpu' }),
  sound: () => {},
  unlockAudio: () => {},
  getTrackSummary: (id: string) => summaries.get(id) ?? summaries.get(TRACKS[0].id)!,
};

const ui = new VelocityHorizonUi();
const root = document.getElementById('ui') as HTMLElement;
ui.mount(root, host);

// --- synthetic HUD feed ----------------------------------------------------

const snapshot: HudSnapshot = {
  phase: 'racing',
  mode: 'championship',
  countdown: 0,
  time: 132_460,
  lap: 2,
  totalLaps: 3,
  position: 3,
  entrants: 8,
  speed: 148.6,
  speedFraction: 0.92,
  shield: 68,
  shieldFraction: 0.68,
  boost: 0.44,
  turboTier: 2,
  currentLapTime: 41_260,
  lastLapTime: 63_940,
  bestLapTime: 61_180,
  ghostDelta: -840,
  grooveChain: 14,
  grooveMultiplier: 2.4,
  score: 18400,
  standings: [],
  lapProgress: 0.62,
  zone: 12,
  threat: 0.55,
  banner: 'FINAL LAP',
  bannerKind: 'info',
};

let t = 0;
function tick(): void {
  t += 1 / 60;
  if (ui.current === 'race') {
    snapshot.time = 132_460 + t * 1000;
    snapshot.currentLapTime = 41_260 + t * 1000;
    snapshot.speed = 140 + Math.sin(t * 1.4) * 18;
    snapshot.lapProgress = (0.62 + t * 0.04) % 1;
    snapshot.shieldFraction = 0.5 + Math.sin(t * 0.6) * 0.28;
    snapshot.boost = 0.4 + Math.sin(t * 0.9) * 0.3;
    snapshot.ghostDelta = Math.sin(t * 0.5) * 1600;
    ui.updateHud(snapshot);
  }
  requestAnimationFrame(tick);
}
tick();

const result: RaceResult = {
  finished: true,
  position: 2,
  entrants: 8,
  totalTime: 187_420,
  bestLap: 61_180,
  laps: [
    { lap: 1, time: 64_120, best: false },
    { lap: 2, time: 62_120, best: false },
    { lap: 3, time: 61_180, best: true },
  ],
  medal: 'gold',
  previousMedal: 'silver',
  creditsEarned: 2040,
  newRecord: true,
  score: 18_400,
  unlockedTracks: ['rainbow-vector'],
  standings: [],
  points: 18,
};

const champ: ChampionshipState = {
  id: 'vector',
  round: 2,
  tracks: ['neon-meridian', 'solstice-ring', 'helix-gate'],
  standings: [
    { racerId: 'p', name: 'You', points: 43, isPlayer: true },
    { racerId: 'a', name: 'AURIC', points: 50, isPlayer: false },
    { racerId: 'k', name: 'KESTREL-9', points: 36, isPlayer: false },
    { racerId: 'v', name: 'VANTA', points: 28, isPlayer: false },
    { racerId: 's', name: 'SOLARIS', points: 22, isPlayer: false },
    { racerId: 'r', name: 'RIPTIDE', points: 16, isPlayer: false },
    { racerId: 'm', name: 'MERIDIAN', points: 10, isPlayer: false },
    { racerId: 'o', name: 'OBSIDIAN', points: 4, isPlayer: false },
  ],
  finished: false,
};

interface TestApi {
  ui: VelocityHorizonUi;
  show(name: string): void;
  results(): void;
  standings(): void;
  loading(p: number, label: string): void;
  toast(): void;
  fatal(): void;
  confirm(): void;
  mode(m: HudSnapshot['mode']): void;
  countdown(): void;
  track(id: string): void;
}

(window as unknown as { __UI: TestApi }).__UI = {
  ui,
  show: (name) => ui.show(name as never),
  results: () => ui.showResults(result),
  standings: () => ui.showChampionship(champ),
  loading: (p, label) => ui.setLoading(p, label),
  toast: () => {
    ui.toast('Rainbow Vector unlocked', 'good');
    ui.toast('Not enough credits for the Zenith', 'bad');
  },
  fatal: () => ui.fatal('The renderer could not start', 'GPUAdapter request failed: no compatible adapter found.\nTried: webgpu → webgl2 → software'),
  confirm: () => void ui.confirm('Abandon the race?', 'Your progress in this race will be lost.'),
  mode: (m) => {
    snapshot.mode = m;
  },
  countdown: () => {
    snapshot.phase = 'countdown';
    snapshot.countdown = 2;
    snapshot.banner = '';
    ui.updateHud(snapshot);
  },
  track: (id) => {
    (ui as unknown as { state: { trackId: string } }).state.trackId = id;
  },
};

console.log('ui-test ready');
