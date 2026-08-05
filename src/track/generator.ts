import { solveClosure, traverse } from './builder';
import { Rng } from '../core/rng';
import type {
  EnvironmentArchetype,
  MusicProfile,
  TrackDefinition,
  TrackPalette,
  TrackSegment,
} from './types';

/**
 * Procedural circuit generation from a seed.
 *
 * Endless mode's promise is that a seed is a place: type the same word and get
 * the same circuit, with the same colours and the same music. Everything here
 * is therefore drawn from a single seeded stream, and the generator emits a
 * plain {@link TrackDefinition} so a generated circuit is indistinguishable
 * from a handcrafted one to the rest of the game — same builder, same closure
 * solver, same racing line, same medals.
 */

const ARCHETYPES: EnvironmentArchetype[] = [
  'nebula',
  'megastructure',
  'prismatic',
  'starfield',
  'ringworld',
  'void',
];

const SCALES: MusicProfile['scale'][] = ['minor', 'phrygian', 'dorian', 'harmonicMinor', 'minorPent'];

/** Colour families, chosen so no generated palette is muddy or illegible. */
const PALETTE_SEEDS: { primary: number; secondary: number; deep: number; glow: number }[] = [
  { primary: 0x35e0ff, secondary: 0xff2d75, deep: 0x050a1e, glow: 0x8ef6ff },
  { primary: 0xff8a1f, secondary: 0x27e5c4, deep: 0x120802, glow: 0xffd08a },
  { primary: 0x5cff9d, secondary: 0xa855f7, deep: 0x03110c, glow: 0xc9ffe2 },
  { primary: 0xff2e63, secondary: 0x6c5ce7, deep: 0x08030c, glow: 0xffb3c8 },
  { primary: 0xffd93d, secondary: 0x4fd2ff, deep: 0x14100a, glow: 0xfff2c4 },
  { primary: 0xe0e6ff, secondary: 0xff6b1a, deep: 0x06080e, glow: 0xffffff },
  { primary: 0xb14aff, secondary: 0x2dffd5, deep: 0x0a0418, glow: 0xe3b6ff },
];

/** Evocative two-part names, so a seed reads like a destination. */
const NAME_A = [
  'Vesper', 'Cinder', 'Halcyon', 'Obsidian', 'Aurora', 'Tantalus', 'Perihelion',
  'Umbra', 'Zephyr', 'Erebus', 'Lumen', 'Kepler', 'Sable', 'Meridian', 'Vantage',
];
const NAME_B = [
  'Reach', 'Descent', 'Spiral', 'Verge', 'Cascade', 'Drift', 'Expanse',
  'Crossing', 'Divide', 'Approach', 'Threshold', 'Circuit', 'Run', 'Gate',
];

export interface GeneratorOptions {
  seed: string;
  /** 1 (gentle) .. 5 (brutal). Drives radii, width, and feature density. */
  difficulty?: 1 | 2 | 3 | 4 | 5;
  /** Approximate lap length in metres. */
  targetLength?: number;
  laps?: number;
}

export function generateTrack(options: GeneratorOptions): TrackDefinition {
  const rng = new Rng(`${options.seed}:track`);
  const difficulty = options.difficulty ?? ((rng.int(1, 5) as 1 | 2 | 3 | 4 | 5));
  const targetLength = options.targetLength ?? rng.range(2600, 4200);

  // Harder circuits are tighter and narrower; gentle ones are open and fast.
  const tightness = (difficulty - 1) / 4;
  const minRadius = Math.round(220 - tightness * 120);
  const maxRadius = Math.round(340 - tightness * 150);
  const halfWidth = Math.round(30 - tightness * 8);

  const segments = generateClosableSegments(rng, { targetLength, minRadius, maxRadius, difficulty });

  const paletteSeed = rng.pick(PALETTE_SEEDS);
  const palette: TrackPalette = {
    ...paletteSeed,
    sun: paletteSeed.glow,
    // Haze is a darkened blend of the two hero colours, so fog always belongs.
    haze: blend(paletteSeed.deep, paletteSeed.primary, 0.22),
  };

  const name = `${rng.pick(NAME_A)} ${rng.pick(NAME_B)}`;

  return {
    id: `generated:${options.seed}`,
    name,
    tagline: taglineFor(difficulty, rng),
    seed: options.seed,
    difficulty,
    laps: options.laps ?? 3,
    halfWidth,
    environment: rng.pick(ARCHETYPES),
    segments,
    palette,
    music: {
      bpm: Math.round(rng.range(122, 152)),
      root: rng.int(36, 48),
      scale: rng.pick(SCALES),
      intensity: 0.4 + tightness * 0.5,
    },
  };
}

/**
 * Generates a recipe the closure solver can actually close.
 *
 * Most random layouts close fine, but a minority leave a residual too large to
 * smear across the lap, which falls back to the Hermite bridge and can fold a
 * cusp into the circuit — a corner tighter than anything drivable, which then
 * poisons the racing line and the speed profile. Rather than let a bad seed
 * ship a broken track, generate, check what the solver managed, and try again
 * with a fresh sub-stream if it is not good enough.
 *
 * Retries draw from sub-seeds of the original, so a given seed is still exactly
 * one circuit.
 */
function generateClosableSegments(rng: Rng, budget: SegmentBudget): TrackSegment[] {
  let best: TrackSegment[] | null = null;
  let bestResidual = Infinity;

  for (let attempt = 0; attempt < 10; attempt++) {
    const attemptRng = rng.fork(`layout:${attempt}`);
    const candidate = generateSegments(attemptRng, budget);
    const solved = solveClosure(candidate);
    const residual = traverse(solved).position.length();
    if (residual < bestResidual) {
      bestResidual = residual;
      best = candidate;
    }
    // Comfortably inside the distribute limit, so the seam is just more track.
    if (residual < 35) break;
  }
  return best ?? generateSegments(rng, budget);
}

interface SegmentBudget {
  targetLength: number;
  minRadius: number;
  maxRadius: number;
  difficulty: number;
}

/**
 * Emits a segment list whose turn angles sum to exactly 360° and whose net
 * elevation returns to zero.
 *
 * Both properties are what let the closure solver finish the job with a small,
 * evenly distributed correction. Generating turns freely and hoping produces
 * recipes that are hundreds of metres and tens of degrees out, which the solver
 * cannot absorb without visibly distorting the circuit.
 */
function generateSegments(rng: Rng, budget: SegmentBudget): TrackSegment[] {
  const segments: TrackSegment[] = [];
  const { minRadius, maxRadius, difficulty } = budget;

  // Plan the corners first: a set of signed angles summing to 360.
  const cornerCount = rng.int(6, 9);
  const angles: number[] = [];
  // A couple of left-handers keep a circuit from feeling like an oval.
  const leftCount = rng.int(1, Math.max(1, Math.floor(cornerCount / 3)));
  let remaining = 360;
  for (let i = 0; i < cornerCount; i++) {
    const isLast = i === cornerCount - 1;
    const left = i > 0 && i <= leftCount;
    if (isLast) {
      angles.push(remaining);
      break;
    }
    if (left) {
      const a = -rng.range(35, 70);
      angles.push(a);
      remaining -= a;
    } else {
      // Leave enough for the remaining corners to stay under 170° each.
      const cornersLeft = cornerCount - i - 1;
      const maxHere = Math.min(165, remaining - cornersLeft * 25);
      const a = rng.range(45, Math.max(50, maxHere));
      angles.push(a);
      remaining -= a;
    }
  }

  // Elevation changes are emitted in matched pairs so the net rise is zero.
  const climbs: number[] = [];
  const climbCount = rng.int(1, 3);
  for (let i = 0; i < climbCount; i++) climbs.push(rng.range(35, 85));

  const straightBudget = budget.targetLength * rng.range(0.42, 0.55);
  const perStraight = straightBudget / (angles.length + 1);

  let climbIndex = 0;
  let pendingDescent = 0;

  segments.push({ kind: 'straight', length: Math.round(perStraight * rng.range(1.1, 1.5)) });

  for (let i = 0; i < angles.length; i++) {
    const angle = angles[i];
    const radius = Math.round(rng.range(minRadius, maxRadius) * (Math.abs(angle) > 110 ? 0.75 : 1));
    const bank = Math.round(Math.min(38, 14 + Math.abs(angle) * 0.16 + difficulty * 2));

    // Occasionally make a corner climb, which is where the helix earns its keep.
    if (climbIndex < climbs.length && rng.bool(0.35)) {
      const rise = climbs[climbIndex++];
      pendingDescent += rise;
      segments.push({ kind: 'helix', angle, radius, rise: Math.round(rise), bank });
    } else {
      segments.push({ kind: 'turn', angle, radius, bank });
    }

    const straight: TrackSegment = {
      kind: 'straight',
      length: Math.round(perStraight * rng.range(0.7, 1.4)),
    };
    // Pay back any climb so the loop closes vertically.
    if (pendingDescent > 0 && rng.bool(0.5)) {
      (straight as { rise?: number }).rise = -Math.round(pendingDescent);
      pendingDescent = 0;
    }
    segments.push(straight);

    // Signature features, rationed by difficulty so an easy seed stays easy.
    const featureChance = 0.1 + difficulty * 0.08;
    if (rng.bool(featureChance)) {
      const roll = rng.next();
      if (roll < 0.4) {
        segments.push({ kind: 'corkscrew', length: Math.round(rng.range(180, 280)), turns: rng.bool() ? 1 : -1, wall: 0.5 });
      } else if (roll < 0.7 && difficulty >= 3) {
        segments.push({ kind: 'loop', radius: Math.round(rng.range(78, 105)), wall: 0.6 });
      } else if (difficulty >= 2) {
        segments.push({ kind: 'gap', length: Math.round(rng.range(38, 62)) });
        segments.push({ kind: 'straight', length: Math.round(perStraight * 0.6) });
      }
      segments.push({ kind: 'straight', length: Math.round(perStraight * 0.7) });
    }
  }

  // Anything still owed vertically is settled on the run to the line.
  if (pendingDescent > 0) {
    segments.push({ kind: 'straight', length: Math.round(perStraight), rise: -Math.round(pendingDescent) });
  }

  return segments;
}

function taglineFor(difficulty: number, rng: Rng): string {
  const byDifficulty: Record<number, string[]> = {
    1: ['Wide open and forgiving', 'A gentle introduction', 'Room to breathe'],
    2: ['Fast, with teeth', 'Flows if you let it', 'Rhythm and commitment'],
    3: ['No obvious line', 'Technical in places', 'Rewards a clean lap'],
    4: ['Very little margin', 'Punishing through the middle sector', 'Bring your shield'],
    5: ['Almost unreasonable', 'Nobody has driven this cleanly', 'Good luck'],
  };
  return rng.pick(byDifficulty[difficulty] ?? byDifficulty[3]);
}

function blend(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Human-friendly random seed, e.g. "amber-drift-914". */
export function randomSeed(): string {
  const rng = new Rng(Math.floor(Math.random() * 0xffffffff));
  return `${rng.pick(NAME_A).toLowerCase()}-${rng.pick(NAME_B).toLowerCase()}-${rng.int(100, 999)}`;
}
