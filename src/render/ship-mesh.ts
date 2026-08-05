import * as THREE from 'three/webgpu';
import {
  attribute,
  color,
  float,
  mix,
  normalLocal,
  normalView,
  positionLocal,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec4,
} from 'three/tsl';
import type { ShipVisual, ShipVisualOptions, ShipVisualState } from './types';

/**
 * Procedurally modelled anti-grav racing craft.
 *
 * The hull is a swept superellipse rather than a bag of primitives: a
 * cross-section whose width, height, shoulder sharpness and chine line all vary
 * independently along the body. That is what gives it a designed silhouette —
 * a drooped dart nose that swells into hard-shouldered flanks, a chine crease
 * running the full length, and a flat load-bearing belly. Everything else
 * (canopy, intakes, nacelles, fins) is the same sweep machinery pointed at a
 * different set of profile curves, so the whole craft shares one language of
 * form instead of looking bolted together.
 *
 * Local axes follow the convention the vehicle writes in `writeTransform`:
 * **-Z is forward**, +Y is up, +X is right. The ship origin sits at the hover
 * point, roughly 2.4 m above the track surface.
 */

// --- Overall dimensions -----------------------------------------------------

/** Nose tip and tail plane in local Z. The craft is ~8.4 m long. */
const NOSE_Z = -4.9;
const TAIL_Z = 3.5;
/** Rings along the hull. 34 is plenty for a 4 m wide body under bloom. */
const HULL_RINGS = 34;
/** Cross-section samples on the belly quadrant and on the deck quadrant. */
const BELLY_STEPS = 5;
const DECK_STEPS = 8;
/** Points in one closed hull ring (see `hullSection`). */
const HULL_RING = 2 * BELLY_STEPS + 2 * DECK_STEPS + 2;

/** Outboard offset of the engine nacelles, in metres. */
const NACELLE_X = 1.94;
const NACELLE_Y = -0.26;
const NACELLE_Z0 = -0.95;
const NACELLE_Z1 = 4.25;
/** Where the exhaust plane sits, in local Z. */
const EXHAUST_Z = NACELLE_Z1 - 0.06;

/** Debris shards thrown by `explode()`. Fixed cost, allocated once. */
const SHARD_COUNT = 22;
const EXPLODE_SECONDS = 1.9;

/**
 * Mini-turbo escalation. Tier 0 is the craft's own engine colour; each tier
 * pushes the core further up the heat scale so the reward reads at a glance
 * even in a wing mirror.
 */
const TURBO_TIER_1 = 0x7fd8ff;
const TURBO_TIER_2 = 0xff58e0;
const TURBO_TIER_3 = 0xffe49a;

// --- Profile curves ---------------------------------------------------------
//
// Each is a list of (t, value) knots with t running 0 at the nose to 1 at the
// tail. Authoring the hull as curves rather than vertices means the silhouette
// can be tuned by eye without touching a single index.

type Curve = readonly (readonly [number, number])[];

/** Half-width of the hull. Slow at the nose, hard shoulder line, clipped tail. */
const HULL_HALF_WIDTH: Curve = [
  [0, 0.03],
  [0.1, 0.2],
  [0.26, 0.44],
  [0.42, 0.66],
  [0.52, 0.82],
  // The knee: the flanks step out over a short run rather than swelling
  // smoothly. That break is what stops the plan view reading as a wedge.
  [0.58, 1.34],
  [0.66, 1.88],
  [0.76, 2.16],
  [0.88, 2.26],
  [1, 1.88],
];
/** Deck height above the section centre. */
const HULL_DECK: Curve = [
  [0, 0.04],
  [0.08, 0.15],
  [0.22, 0.33],
  [0.38, 0.5],
  [0.52, 0.62],
  [0.66, 0.66],
  [0.82, 0.58],
  [1, 0.46],
];
/** Belly depth below the section centre. Shallower than the deck: flat-bottomed. */
const HULL_BELLY: Curve = [
  [0, 0.03],
  [0.1, 0.14],
  [0.28, 0.28],
  [0.5, 0.38],
  [0.74, 0.45],
  [1, 0.41],
];
/** Height of the chine crease, below centre so the flank overhangs. */
const HULL_CHINE: Curve = [
  [0, 0],
  [0.25, -0.05],
  [0.6, -0.14],
  [1, -0.11],
];
/** Spine droop — the nose dips, which is most of why the craft looks fast. */
const HULL_SPINE: Curve = [
  [0, -0.13],
  [0.25, -0.03],
  [0.6, 0.02],
  [1, 0.04],
];
/** Superellipse exponent of the deck quadrant. Higher = harder shoulder. */
const HULL_DECK_EXP: Curve = [
  [0, 2.3],
  [0.3, 3.0],
  [0.6, 3.9],
  [1, 3.2],
];
const HULL_BELLY_EXP: Curve = [
  [0, 2.1],
  [0.5, 2.9],
  [1, 2.5],
];

const CANOPY_T0 = 0.33;
const CANOPY_T1 = 0.74;
const CANOPY_WIDTH: Curve = [
  [0, 0.14],
  [0.22, 0.55],
  [0.5, 0.72],
  [0.78, 0.6],
  [1, 0.18],
];
const CANOPY_HEIGHT: Curve = [
  [0, 0.05],
  [0.25, 0.34],
  [0.5, 0.44],
  [0.78, 0.34],
  [1, 0.07],
];

const NACELLE_RX: Curve = [
  [0, 0.32],
  [0.18, 0.44],
  [0.45, 0.48],
  [0.72, 0.47],
  [1, 0.4],
];
const NACELLE_RY: Curve = [
  [0, 0.25],
  [0.18, 0.35],
  [0.45, 0.38],
  [0.72, 0.37],
  [1, 0.32],
];
/** The pods splay outward toward the tail, widening the stance. */
const NACELLE_SPLAY: Curve = [
  [0, -0.16],
  [0.5, 0.04],
  [1, 0.16],
];

/**
 * Smooth piecewise interpolation across a knot list. Uses a smoothstep between
 * neighbouring knots — C1 at the knots, monotone between them, and it cannot
 * overshoot the way a Catmull-Rom would on a curve like the width profile.
 */
export function curveAt(curve: Curve, t: number): number {
  if (t <= curve[0][0]) return curve[0][1];
  const last = curve[curve.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const [ta, va] = curve[i - 1];
    const [tb, vb] = curve[i];
    if (t <= tb) {
      const f = (t - ta) / (tb - ta);
      return va + (vb - va) * f * f * (3 - 2 * f);
    }
  }
  return last[1];
}

// --- Mesh construction ------------------------------------------------------

/**
 * Accumulates rings of a swept surface and stitches them into an indexed
 * geometry. Normals are supplied by the caller rather than derived, which is
 * the whole trick behind the chine: two coincident vertices carrying different
 * normals produce a genuine hard crease with no extra geometry.
 */
export class SweepBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly sections: number[] = [];
  readonly indices: number[] = [];

  /** Push one ring; returns its base vertex index. */
  ring(
    points: readonly number[],
    normals: readonly number[],
    us: readonly number[],
    v: number,
    section?: readonly number[],
  ): number {
    const base = this.positions.length / 3;
    const n = us.length;
    for (let i = 0; i < n; i++) {
      this.positions.push(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
      this.normals.push(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
      this.uvs.push(us[i], v);
      if (section) this.sections.push(section[i * 2], section[i * 2 + 1]);
    }
    return base;
  }

  /** Bridge two rings of equal size. `closed` wraps the last point to the first. */
  stitch(baseA: number, baseB: number, count: number, closed: boolean): void {
    const span = closed ? count : count - 1;
    for (let k = 0; k < span; k++) {
      const k1 = (k + 1) % count;
      this.indices.push(baseA + k, baseA + k1, baseB + k);
      this.indices.push(baseA + k1, baseB + k1, baseB + k);
    }
  }

  /** Single apex vertex, for nose and tail caps. */
  apex(p: readonly number[], n: readonly number[], u: number, v: number, section?: readonly number[]): number {
    const base = this.positions.length / 3;
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    this.uvs.push(u, v);
    if (section) this.sections.push(section[0], section[1]);
    return base;
  }

  /** Fan a cap. `forward` true when the cap faces +Z (the tail). */
  cap(apexIndex: number, ringBase: number, count: number, forward: boolean): void {
    for (let k = 0; k < count; k++) {
      const k1 = (k + 1) % count;
      if (forward) this.indices.push(apexIndex, ringBase + k, ringBase + k1);
      else this.indices.push(apexIndex, ringBase + k1, ringBase + k);
    }
  }

  build(withSections: boolean): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    if (withSections) {
      geo.setAttribute('aSection', new THREE.Float32BufferAttribute(this.sections, 2));
    }
    geo.setIndex(this.indices);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

/** Scratch arrays for one hull ring, reused across all rings at build time. */
interface RingScratch {
  p: number[];
  n: number[];
  u: number[];
  s: number[];
}

function ringScratch(count: number): RingScratch {
  return { p: new Array(count * 3).fill(0), n: new Array(count * 3).fill(0), u: new Array(count).fill(0), s: new Array(count * 2).fill(0) };
}

/**
 * One hull cross-section, written into `out`.
 *
 * Half the section is generated (bottom centre → chine → deck centre) and then
 * mirrored, which guarantees the craft is exactly symmetric. The chine point
 * appears twice: once carrying the belly's outward normal, once the deck's.
 */
function hullSection(t: number, z: number, out: RingScratch): void {
  const w = curveAt(HULL_HALF_WIDTH, t);
  const deck = curveAt(HULL_DECK, t);
  const belly = curveAt(HULL_BELLY, t);
  const chine = curveAt(HULL_CHINE, t);
  const spine = curveAt(HULL_SPINE, t);
  const nDeck = curveAt(HULL_DECK_EXP, t);
  const nBelly = curveAt(HULL_BELLY_EXP, t);

  const half = BELLY_STEPS + 2 + DECK_STEPS;
  const bellySpan = Math.max(1e-4, chine + belly);
  const deckSpan = Math.max(1e-4, deck - chine);

  const hx = new Array<number>(half);
  const hy = new Array<number>(half);
  const hnx = new Array<number>(half);
  const hny = new Array<number>(half);

  // Belly quadrant, bottom centre (k = 0) out to the chine (k = BELLY_STEPS).
  for (let k = 0; k <= BELLY_STEPS; k++) {
    const theta = (1 - k / BELLY_STEPS) * Math.PI * 0.5;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const e = 2 / nBelly;
    hx[k] = w * Math.pow(c, e);
    hy[k] = chine - bellySpan * Math.pow(s, e);
    const g = 2 - e;
    hnx[k] = Math.pow(c, g) / w;
    hny[k] = -Math.pow(s, g) / bellySpan;
  }
  // Deck quadrant, chine (duplicated, deck normal) up to the spine.
  for (let j = 0; j <= DECK_STEPS; j++) {
    const k = BELLY_STEPS + 1 + j;
    const theta = (j / DECK_STEPS) * Math.PI * 0.5;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const e = 2 / nDeck;
    hx[k] = w * Math.pow(c, e);
    hy[k] = chine + deckSpan * Math.pow(s, e);
    const g = 2 - e;
    hnx[k] = Math.pow(c, g) / w;
    hny[k] = Math.pow(s, g) / deckSpan;
  }

  const write = (idx: number, x: number, y: number, nx: number, ny: number, u: number): void => {
    const len = Math.hypot(nx, ny) || 1;
    out.p[idx * 3] = x;
    out.p[idx * 3 + 1] = y + spine;
    out.p[idx * 3 + 2] = z;
    out.n[idx * 3] = nx / len;
    out.n[idx * 3 + 1] = ny / len;
    out.n[idx * 3 + 2] = 0;
    out.u[idx] = u;
    // Section coordinates: signed across the beam, signed up the section.
    out.s[idx * 2] = w > 1e-4 ? x / w : 0;
    out.s[idx * 2 + 1] = y / Math.max(0.05, Math.max(deck, belly));
  };

  for (let k = 0; k < half; k++) write(k, hx[k], hy[k], hnx[k], hny[k], k / HULL_RING);
  // Mirror everything except the two centreline points.
  for (let k = 1; k < half - 1; k++) {
    const idx = half + (half - 2 - k);
    write(idx, -hx[k], hy[k], -hnx[k], hny[k], idx / HULL_RING);
  }
}

/**
 * The hull: a swept, chined superellipse with a capped nose and tail.
 * Exported so the geometry can be validated without a graphics context.
 */
export function buildHullGeometry(): THREE.BufferGeometry {
  const b = new SweepBuilder();
  const scratch = ringScratch(HULL_RING);
  let previous = -1;
  let firstBase = -1;
  let lastBase = -1;

  for (let i = 0; i < HULL_RINGS; i++) {
    // Bias stations toward the nose, where the section changes fastest.
    const t = Math.pow(i / (HULL_RINGS - 1), 1.22);
    const z = NOSE_Z + t * (TAIL_Z - NOSE_Z);
    hullSection(t, z, scratch);
    const base = b.ring(scratch.p, scratch.n, scratch.u, t, scratch.s);
    if (previous >= 0) b.stitch(previous, base, HULL_RING, true);
    else firstBase = base;
    previous = base;
    lastBase = base;
  }

  const noseY = curveAt(HULL_SPINE, 0);
  const nose = b.apex([0, noseY, NOSE_Z - 0.34], [0, 0.1, -0.99], 0.5, -0.02, [0, 0]);
  b.cap(nose, firstBase, HULL_RING, false);

  const tailY = curveAt(HULL_SPINE, 1) + (curveAt(HULL_DECK, 1) - curveAt(HULL_BELLY, 1)) * 0.5;
  const tail = b.apex([0, tailY, TAIL_Z + 0.05], [0, 0, 1], 0.5, 1.02, [0, 0]);
  b.cap(tail, lastBase, HULL_RING, true);

  return b.build(true);
}

const CANOPY_RING = 19;

/** Bubble canopy blistering out of the deck. Open at the base — it is buried. */
export function buildCanopyGeometry(): THREE.BufferGeometry {
  const b = new SweepBuilder();
  const stations = 16;
  const dome = CANOPY_RING - 2;
  const p = new Array<number>(CANOPY_RING * 3).fill(0);
  const n = new Array<number>(CANOPY_RING * 3).fill(0);
  const u = new Array<number>(CANOPY_RING).fill(0);
  let previous = -1;

  for (let i = 0; i < stations; i++) {
    const q = i / (stations - 1);
    const t = CANOPY_T0 + q * (CANOPY_T1 - CANOPY_T0);
    const z = NOSE_Z + t * (TAIL_Z - NOSE_Z);
    const base = curveAt(HULL_SPINE, t) + curveAt(HULL_DECK, t) * 0.42;
    // Sized in metres rather than as a fraction of the hull: the forebody is
              // deliberately narrow, and a cockpit does not shrink to match it.
    const w = curveAt(CANOPY_WIDTH, q) * 1.15 + 0.06;
    const h = curveAt(CANOPY_HEIGHT, q);
    const e = 2 / 2.7;

    // Skirt point on the right, buried below the deck.
    p[0] = w;
    p[1] = base - 0.3;
    p[2] = z;
    n[0] = 1;
    n[1] = -0.2;
    n[2] = 0;
    u[0] = 0;
    for (let k = 0; k < dome; k++) {
      const phi = (k / (dome - 1)) * Math.PI;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const sx = Math.sign(c) || 1;
      const idx = k + 1;
      p[idx * 3] = w * sx * Math.pow(Math.abs(c), e);
      p[idx * 3 + 1] = base + h * Math.pow(s, e);
      p[idx * 3 + 2] = z;
      const g = 2 - e;
      const nx = (sx * Math.pow(Math.abs(c), g)) / w;
      const ny = Math.pow(s, g) / Math.max(0.05, h);
      const len = Math.hypot(nx, ny) || 1;
      n[idx * 3] = nx / len;
      n[idx * 3 + 1] = ny / len;
      n[idx * 3 + 2] = 0;
      u[idx] = (k + 1) / (CANOPY_RING - 1);
    }
    const lastIdx = CANOPY_RING - 1;
    p[lastIdx * 3] = -w;
    p[lastIdx * 3 + 1] = base - 0.3;
    p[lastIdx * 3 + 2] = z;
    n[lastIdx * 3] = -1;
    n[lastIdx * 3 + 1] = -0.2;
    n[lastIdx * 3 + 2] = 0;
    u[lastIdx] = 1;

    const ring = b.ring(p, n, u, q);
    if (previous >= 0) b.stitch(previous, ring, CANOPY_RING, false);
    previous = ring;
  }
  return b.build(false);
}

const NACELLE_RING = 18;

/**
 * One engine nacelle: a rounded-square tube with a recessed conical intake at
 * the front and an open exhaust plane at the back for the core to sit in.
 *
 * `side` is -1 or +1; the pod is built already offset so both can share one
 * geometry per side without a second matrix.
 */
export function buildNacelleGeometry(side: number): THREE.BufferGeometry {
  const b = new SweepBuilder();
  const stations = 18;
  const p = new Array<number>(NACELLE_RING * 3).fill(0);
  const n = new Array<number>(NACELLE_RING * 3).fill(0);
  const u = new Array<number>(NACELLE_RING).fill(0);
  const sec = new Array<number>(NACELLE_RING * 2).fill(0);
  let previous = -1;
  let firstBase = -1;

  for (let i = 0; i < stations; i++) {
    const q = i / (stations - 1);
    const z = NACELLE_Z0 + q * (NACELLE_Z1 - NACELLE_Z0);
    const rx = curveAt(NACELLE_RX, q);
    const ry = curveAt(NACELLE_RY, q);
    const cx = side * (NACELLE_X + curveAt(NACELLE_SPLAY, q));
    const e = 2 / 3.6;
    for (let k = 0; k < NACELLE_RING; k++) {
      const phi = (k / NACELLE_RING) * Math.PI * 2;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const sx = Math.sign(c) || 1;
      const sy = Math.sign(s) || 1;
      p[k * 3] = cx + rx * sx * Math.pow(Math.abs(c), e);
      p[k * 3 + 1] = NACELLE_Y + ry * sy * Math.pow(Math.abs(s), e);
      p[k * 3 + 2] = z;
      const g = 2 - e;
      const nx = (sx * Math.pow(Math.abs(c), g)) / rx;
      const ny = (sy * Math.pow(Math.abs(s), g)) / ry;
      const len = Math.hypot(nx, ny) || 1;
      n[k * 3] = nx / len;
      n[k * 3 + 1] = ny / len;
      n[k * 3 + 2] = 0;
      u[k] = k / NACELLE_RING;
      sec[k * 2] = sx * Math.pow(Math.abs(c), e);
      sec[k * 2 + 1] = sy * Math.pow(Math.abs(s), e);
    }
    const ring = b.ring(p, n, u, q, sec);
    if (previous >= 0) b.stitch(previous, ring, NACELLE_RING, true);
    else firstBase = ring;
    previous = ring;
  }

  // Intake: the cap apex sits *inside* the pod, so the front reads as a duct
  // rather than a nose cone.
  const intake = b.apex(
    [side * (NACELLE_X + curveAt(NACELLE_SPLAY, 0)), NACELLE_Y, NACELLE_Z0 + 0.75],
    [0, 0, -1],
    0.5,
    -0.05,
    [0, 0],
  );
  b.cap(intake, firstBase, NACELLE_RING, false);
  return b.build(true);
}

/** Spanwise profile of an aerofoil fin, swept along +Y. */
interface FinSpec {
  /** Leading and trailing edge Z at the root and at the tip. */
  leadRoot: number;
  leadTip: number;
  trailRoot: number;
  trailTip: number;
  rootY: number;
  tipY: number;
  rootX: number;
  tipX: number;
  thickness: number;
}

const FIN_CHORD = 9;
const FIN_RING = FIN_CHORD * 2 - 2;

/**
 * A swept aerofoil: a lens cross-section lofted from root to tip. Thin, with a
 * real leading edge, so it catches a specular line the way a shaped fin does.
 */
export function buildFinGeometry(spec: FinSpec): THREE.BufferGeometry {
  const b = new SweepBuilder();
  const stations = 8;
  const p = new Array<number>(FIN_RING * 3).fill(0);
  const n = new Array<number>(FIN_RING * 3).fill(0);
  const u = new Array<number>(FIN_RING).fill(0);
  const sec = new Array<number>(FIN_RING * 2).fill(0);
  let previous = -1;

  for (let i = 0; i < stations; i++) {
    const v = i / (stations - 1);
    const lead = spec.leadRoot + (spec.leadTip - spec.leadRoot) * v;
    const trail = spec.trailRoot + (spec.trailTip - spec.trailRoot) * v;
    const y = spec.rootY + (spec.tipY - spec.rootY) * v;
    const x = spec.rootX + (spec.tipX - spec.rootX) * v;
    const th = spec.thickness * (1 - v * 0.85);
    for (let k = 0; k < FIN_RING; k++) {
      // First half runs the +X surface nose-to-tail, second half returns.
      const upper = k < FIN_CHORD;
      const c = upper ? k / (FIN_CHORD - 1) : (FIN_RING - k) / (FIN_CHORD - 1);
      const shape = Math.pow(Math.sin(Math.PI * c), 0.62);
      const dir = upper ? 1 : -1;
      p[k * 3] = x + dir * th * shape;
      p[k * 3 + 1] = y;
      p[k * 3 + 2] = lead + (trail - lead) * c;
      n[k * 3] = dir;
      n[k * 3 + 1] = 0;
      n[k * 3 + 2] = 0;
      u[k] = c;
      // Put the section crease along the fin's thickest ridge, so the hull
      // material's chine line runs the length of the aerofoil.
      sec[k * 2] = dir * shape;
      sec[k * 2 + 1] = v * 2 - 1;
    }
    const ring = b.ring(p, n, u, v, sec);
    if (previous >= 0) b.stitch(previous, ring, FIN_RING, true);
    previous = ring;
  }

  const geo = b.build(true);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Flat pads under the belly that glow against the track while grounded. */
export function buildHoverPadGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const pads: [number, number, number][] = [
    [-1.35, -0.5, -1.4],
    [1.35, -0.5, -1.4],
    [-1.6, -0.55, 2.0],
    [1.6, -0.55, 2.0],
  ];
  const segments = 12;
  for (const [px, py, pz] of pads) {
    const base = positions.length / 3;
    positions.push(px, py, pz);
    normals.push(0, -1, 0);
    uvs.push(0.5, 0.5);
    const r = 0.34;
    for (let k = 0; k <= segments; k++) {
      const a = (k / segments) * Math.PI * 2;
      positions.push(px + Math.cos(a) * r, py, pz + Math.sin(a) * r * 1.6);
      normals.push(0, -1, 0);
      uvs.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
    }
    for (let k = 0; k < segments; k++) {
      indices.push(base, base + 1 + k + 1, base + 1 + k);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

// --- Shader plumbing --------------------------------------------------------

/**
 * `uniform` is overloaded to death, and `ReturnType<typeof uniform>` resolves
 * to the last overload — an untyped node with no `.mul()`. Routing through a
 * concrete helper keeps the real node type.
 */
function floatUniform(value: number) {
  return uniform(value, 'float');
}
type FloatUniform = ReturnType<typeof floatUniform>;

/** Typed attribute helpers — the bare `attribute()` widens its type parameter. */
function vec2Attribute(name: string) {
  return attribute<'vec2'>(name, 'vec2');
}

interface ShipUniforms {
  speed: FloatUniform;
  boost: FloatUniform;
  turbo: FloatUniform;
  damage: FloatUniform;
  shield: FloatUniform;
  shieldHit: FloatUniform;
  invuln: FloatUniform;
  ghost: FloatUniform;
  beat: FloatUniform;
  grounded: FloatUniform;
  /** The craft's own engine colour. Fixed at build time, not a live uniform. */
  engine: number;
}

/** Blends the engine colour up through the three mini-turbo stages. */
function turboColour(u: ShipUniforms) {
  const tier = u.turbo;
  const a = mix(color(u.engine), color(TURBO_TIER_1), tier.clamp(0, 1));
  const b = mix(a, color(TURBO_TIER_2), tier.sub(1).clamp(0, 1));
  return mix(b, color(TURBO_TIER_3), tier.sub(2).clamp(0, 1));
}

function createHullMaterial(options: ShipVisualOptions, u: ShipUniforms): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  const t = uv().y;
  const section = vec2Attribute('aSection');
  const across = section.x;
  const up = section.y;

  const hull = color(options.colors.hull);
  const trim = color(options.colors.trim);

  // Three tones off one authored colour: a near-black belly, the craft's own
  // colour on the flanks, and a lifted composite deck. A single flat hull
  // colour is the thing that makes procedural vehicles look untextured, and the
  // gradient costs nothing. All three stay dark — the scene is lit by a bright
  // nebula and graded through ACES with bloom on top, so a mid-tone albedo
  // comes back as white.
  const shade = smoothstep(-0.7, 0.45, up);
  const deck = smoothstep(0.35, 0.9, up);
  const base = mix(mix(hull.mul(0.08), hull.mul(0.55), shade), hull.mul(1.1).add(0.012), deck.mul(0.3));

  // Panel breaks. Fine lateral seams plus a few longitudinal ones, both thin
  // enough to survive at distance without shimmering.
  const seamAlong = smoothstep(0.955, 1.0, t.mul(6).fract());
  const seamAcross = smoothstep(0.94, 1.0, across.abs().mul(2.6).fract());
  const panels = seamAlong.add(seamAcross).clamp(0, 1);

  // Two louvred vents on the aft deck. A handful of hard lines in the right
  // place does more for "engineered" than another thousand triangles.
  const ventBand = smoothstep(0.62, 0.68, t).mul(smoothstep(0.86, 0.8, t));
  const ventSide = smoothstep(0.2, 0.3, across.abs()).mul(smoothstep(0.62, 0.52, across.abs()));
  const louvre = smoothstep(0.45, 0.75, t.mul(46).fract());
  const vents = ventBand.mul(ventSide).mul(smoothstep(0.25, 0.6, up));

  // Livery: three marks, and only three. A stripe down the spine, a hot line
  // along the chine crease, and a flash on the nose. Every extra glowing region
  // costs some of the craft's readable silhouette, which is why the widths are
  // narrow and the weights are low — the paint has to survive bloom.
  const spine = smoothstep(0.13, 0.02, across.abs()).mul(smoothstep(0.35, 0.7, up)).mul(smoothstep(0.1, 0.24, t));
  const chine = smoothstep(0.93, 1.0, across.abs()).mul(smoothstep(0.2, 0.45, t));
  const flash = smoothstep(0.22, 0.07, t).mul(smoothstep(-0.2, 0.3, up));

  // View-space fresnel: cheap, backend-agnostic, and it is what gives the hull
  // its wet carbon edge definition. Kept tight — a broad fresnel on a bright
  // trim colour drowns the paint and the craft reads as a glowing blob.
  const fresnel = normalView.z.abs().oneMinus().pow(6);

  // Engine wash: the tail glows with whatever the nacelles are doing.
  const wash = smoothstep(0.78, 1.0, t).mul(u.boost.mul(1.3).add(u.speed.mul(0.25)).add(0.08));

  const beatLift = u.beat.mul(0.45).add(1);
  // The stripes are painted into the albedo and only lightly lit on top. A
  // livery made purely of emissive reads as a light strip stuck to the hull.
  const paint = spine.max(chine).max(flash).clamp(0, 1);
  const emissive = trim
    .mul(paint.mul(beatLift).mul(0.22).add(fresnel.mul(0.16)).add(vents.mul(louvre).mul(0.5)))
    .add(turboColour(u).mul(wash).mul(0.3))
    .add(color(0xffffff).mul(u.damage.mul(1.7)))
    .add(trim.mul(u.ghost.mul(1.6)));

  mat.colorNode = mix(base, trim.mul(0.3), paint.mul(0.9))
    .mul(panels.mul(0.6).oneMinus())
    .mul(vents.mul(louvre.oneMinus()).mul(0.8).oneMinus())
    .mul(u.ghost.mul(0.85).oneMinus());
  mat.emissiveNode = emissive;
  mat.roughnessNode = float(0.5).add(panels.mul(0.28)).add(vents.mul(0.15)).sub(deck.mul(0.14));
  mat.metalnessNode = float(0.28).add(deck.mul(0.18)).sub(panels.mul(0.18));
  // The nebula skyboxes are extremely bright; taking the craft's share of the
  // IBL down is what lets its livery read as paint instead of chrome.
  mat.envMapIntensity = 0.16;
  return mat;
}

/**
 * Nacelles, fins and intake blades.
 *
 * These share the hull's swept-section attribute but not its livery: a stripe
 * scheme authored for a wide painted body reads as a light show when it is
 * applied to a thin aerofoil. Structure is dark machined metal with a single
 * accent line down whatever the part's thickest ridge happens to be.
 */
function createStructureMaterial(options: ShipVisualOptions, u: ShipUniforms): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  const t = uv().y;
  const section = vec2Attribute('aSection');
  const ridge = smoothstep(0.9, 1.0, section.x.abs());
  const trim = color(options.colors.trim);

  // Front of a nacelle is its intake; front of a fin is its root, buried.
  const lip = smoothstep(0.09, 0.0, t);
  const tail = smoothstep(0.88, 1.0, t);

  mat.colorNode = color(0x0b0e14).mul(smoothstep(-1.2, 0.8, section.y).mul(0.7).add(0.45));
  mat.emissiveNode = trim
    .mul(ridge.mul(0.22).add(lip.mul(0.45)))
    .add(turboColour(u).mul(tail).mul(u.boost.mul(1.1).add(u.speed.mul(0.3)).add(0.12)))
    .add(color(0xffffff).mul(u.damage.mul(1.4)))
    .add(trim.mul(u.ghost.mul(1.2)));
  mat.roughnessNode = float(0.33);
  mat.metalnessNode = float(0.8);
  mat.envMapIntensity = 0.16;
  return mat;
}

function createCanopyMaterial(options: ShipVisualOptions, u: ShipUniforms): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  const fresnel = normalView.z.abs().oneMinus().pow(2.2);
  const trim = color(options.colors.trim);
  // Faint horizon band across the glass — the trick that stops dark canopies
  // from reading as a hole in the hull.
  const band = smoothstep(0.35, 0.5, uv().x).mul(smoothstep(0.65, 0.5, uv().x));
  mat.colorNode = color(0x05070d);
  mat.emissiveNode = trim.mul(fresnel.mul(0.7).add(band.mul(0.12))).add(trim.mul(u.damage.mul(2)));
  mat.roughnessNode = float(0.16);
  mat.metalnessNode = float(0.12);
  mat.opacityNode = fresnel.mul(0.35).add(0.75).clamp(0, 1);
  mat.envMapIntensity = 0.14;
  mat.transparent = true;
  return mat;
}

function createCoreMaterial(u: ShipUniforms): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  // CircleGeometry UVs are 0..1 across the disc; recentre to get a radius.
  const p = uv().sub(vec2(0.5, 0.5));
  const r = p.length().mul(2).clamp(0, 1);
  const angle = p.y.atan(p.x);

  // Turbine swirl: a few blades rotating fast enough to blur, over a white-hot
  // centre that opens up under boost.
  const swirl = angle.mul(7).add(time.mul(9).add(u.boost.mul(24))).sin().mul(0.5).add(0.5);
  const blades = mix(float(0.55), float(1), swirl.pow(2));
  const centre = smoothstep(0.85, 0.0, r);
  const rim = smoothstep(0.72, 1.0, r).mul(smoothstep(1.02, 0.94, r));

  const heat = u.boost.mul(1.5).add(u.speed.mul(0.5)).add(0.45);
  const tint = turboColour(u);
  const body = mix(tint, color(0xffffff), centre.pow(2.2).mul(0.85));
  mat.colorNode = vec4(body.mul(blades).mul(centre.add(rim.mul(1.4))).mul(heat), float(1));
  return mat;
}

function createPlumeMaterial(u: ShipUniforms): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  mat.blending = THREE.AdditiveBlending;
  mat.side = THREE.DoubleSide;
  const along = uv().y;
  // Shock diamonds — evenly spaced brightenings that scroll outward. Reads as
  // a real supersonic plume instead of a fading cone.
  const diamonds = along.mul(9).sub(time.mul(6)).sin().mul(0.5).add(0.5).pow(3).mul(u.boost.mul(0.8).add(0.2));
  const taper = along.oneMinus().pow(1.7);
  const tint = mix(turboColour(u), color(0xffffff), taper.pow(3).mul(0.7));
  const strength = u.boost.mul(1.1).add(u.speed.mul(0.35)).add(0.05);
  mat.colorNode = vec4(tint.mul(diamonds.add(0.5)).mul(1.15), taper.mul(strength).clamp(0, 1).mul(0.5));
  return mat;
}

function createShieldMaterial(options: ShipVisualOptions, u: ShipUniforms): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  mat.blending = THREE.AdditiveBlending;
  mat.side = THREE.DoubleSide;
  const section = vec2Attribute('aSection');
  const t = uv().y;

  // Hull-hugging: push the hull surface out along its own normal rather than
  // scaling it, so the shell keeps the craft's silhouette exactly.
  mat.positionNode = positionLocal.add(normalLocal.mul(float(0.34).add(u.shieldHit.mul(0.18))));

  // Interfering stripe fields make a hex-ish lattice for nothing.
  const a = t.mul(26).add(section.x.mul(9)).fract();
  const b = t.mul(26).sub(section.x.mul(9)).fract();
  const lattice = smoothstep(0.82, 1.0, a).add(smoothstep(0.82, 1.0, b)).clamp(0, 1);
  const fresnel = normalView.z.abs().oneMinus().pow(2);

  // A band sweeping nose-to-tail while invulnerable: the phasing tell.
  const phase = smoothstep(0.75, 1.0, t.sub(time.mul(0.55)).fract()).mul(u.invuln);
  // Impact ripple radiating from the nose on a hit.
  const ripple = smoothstep(0.35, 0.0, t.sub(u.shieldHit.oneMinus()).abs()).mul(u.shieldHit);

  const visible = u.shieldHit.max(u.invuln.mul(0.55)).max(u.shield.oneMinus().mul(0.22)).clamp(0, 1);
  const tint = mix(color(options.colors.trim), color(0xffffff), u.shieldHit.mul(0.7));
  const amount = lattice.mul(0.4).add(fresnel.mul(0.9)).add(phase.mul(0.8)).add(ripple.mul(1.6));
  mat.colorNode = vec4(tint.mul(amount).mul(1.3), amount.mul(visible).clamp(0, 1).mul(0.75));
  return mat;
}

function createPadMaterial(options: ShipVisualOptions, u: ShipUniforms): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  mat.blending = THREE.AdditiveBlending;
  mat.side = THREE.DoubleSide;
  const r = uv().sub(vec2(0.5, 0.5)).length().mul(2).clamp(0, 1);
  const falloff = r.oneMinus().pow(1.8);
  const strength = u.grounded.mul(u.speed.mul(0.14).add(0.14)).add(u.boost.mul(0.12));
  mat.colorNode = vec4(
    mix(color(options.colors.trim), color(0xffffff), falloff.pow(3)).mul(0.9),
    falloff.mul(strength).clamp(0, 1).mul(0.4),
  );
  return mat;
}

function createDebrisMaterial(options: ShipVisualOptions, u: ShipUniforms): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  mat.blending = THREE.AdditiveBlending;
  const tint = mix(color(options.colors.hull).mul(3), color(options.colors.engine), float(0.5));
  mat.colorNode = vec4(tint.mul(u.damage.mul(1.2).add(0.9)), float(1));
  return mat;
}

// --- The visual -------------------------------------------------------------

const _scratchMatrix = new THREE.Matrix4();
const _scratchQuat = new THREE.Quaternion();
const _scratchVec = new THREE.Vector3();
const _scratchEuler = new THREE.Euler();
const _scratchScale = new THREE.Vector3(1, 1, 1);
const _unitScale = new THREE.Vector3(1, 1, 1);

export function createShipVisual(options: ShipVisualOptions): ShipVisual {
  const root = new THREE.Group();
  root.name = 'ship';
  // Attitude flourishes live on an inner node so they compose with, rather
  // than fight, the authoritative quaternion the simulation writes.
  const body = new THREE.Group();
  body.name = 'ship-body';
  root.add(body);

  const disposables: { dispose(): void }[] = [];
  const isGhost = options.isGhost === true;

  const u: ShipUniforms = {
    speed: floatUniform(0),
    boost: floatUniform(0),
    turbo: floatUniform(0),
    damage: floatUniform(0),
    shield: floatUniform(1),
    shieldHit: floatUniform(0),
    invuln: floatUniform(0),
    ghost: floatUniform(isGhost ? 1 : 0),
    beat: floatUniform(0),
    grounded: floatUniform(1),
    engine: options.colors.engine,
  };

  // --- Hull -------------------------------------------------------------
  const hullGeo = buildHullGeometry();
  const hullMat = createHullMaterial(options, u);
  if (isGhost) {
    hullMat.transparent = true;
    hullMat.depthWrite = false;
  }
  const hull = new THREE.Mesh(hullGeo, hullMat);
  hull.name = 'ship-hull';
  body.add(hull);
  disposables.push(hullGeo, hullMat);

  const structureMat = createStructureMaterial(options, u);
  if (isGhost) {
    structureMat.transparent = true;
    structureMat.depthWrite = false;
  }
  disposables.push(structureMat);

  // --- Canopy -----------------------------------------------------------
  const canopyGeo = buildCanopyGeometry();
  const canopyMat = createCanopyMaterial(options, u);
  const canopy = new THREE.Mesh(canopyGeo, canopyMat);
  canopy.renderOrder = 1;
  body.add(canopy);
  disposables.push(canopyGeo, canopyMat);

  // --- Nacelles ---------------------------------------------------------
  for (const side of [-1, 1]) {
    const geo = buildNacelleGeometry(side);
    const nacelle = new THREE.Mesh(geo, structureMat);
    nacelle.name = `ship-nacelle-${side < 0 ? 'l' : 'r'}`;
    body.add(nacelle);
    disposables.push(geo);
  }

  // --- Intake vanes -----------------------------------------------------
  // Three thin blades across each shoulder scoop. Small, but they are what the
  // eye reads as "engineered" when the craft fills the screen.
  const vaneGeo = new THREE.BoxGeometry(0.04, 0.34, 0.36);
  const vaneMat = new THREE.MeshStandardNodeMaterial();
  vaneMat.colorNode = color(0x05070b);
  vaneMat.emissiveNode = color(options.colors.trim).mul(u.speed.mul(0.2).add(u.boost.mul(0.45)).add(0.06));
  vaneMat.metalnessNode = float(0.7);
  vaneMat.roughnessNode = float(0.4);
  vaneMat.envMapIntensity = 0.16;
  const vanes = new THREE.InstancedMesh(vaneGeo, vaneMat, 6);
  vanes.name = 'ship-vanes';
  {
    let i = 0;
    for (const side of [-1, 1]) {
      for (let blade = -1; blade <= 1; blade++) {
        _scratchVec.set(
          side * (NACELLE_X + curveAt(NACELLE_SPLAY, 0)) + blade * 0.15,
          NACELLE_Y,
          NACELLE_Z0 + 0.32,
        );
        _scratchMatrix.compose(_scratchVec, _scratchQuat.identity(), _unitScale);
        vanes.setMatrixAt(i++, _scratchMatrix);
      }
    }
    vanes.instanceMatrix.needsUpdate = true;
  }
  body.add(vanes);
  disposables.push(vaneGeo, vaneMat);

  // --- Fins -------------------------------------------------------------
  const finGeo = buildFinGeometry({
    leadRoot: 1.35,
    leadTip: 2.75,
    trailRoot: 4.05,
    trailTip: 4.2,
    rootY: 0.0,
    tipY: 1.5,
    rootX: 0,
    tipX: 0,
    thickness: 0.13,
  });
  const canardGeo = buildFinGeometry({
    leadRoot: -3.0,
    leadTip: -2.1,
    trailRoot: -1.5,
    trailTip: -1.55,
    rootY: 0,
    tipY: 1.15,
    rootX: 0,
    tipX: 0,
    thickness: 0.08,
  });
  const pylonGeo = buildFinGeometry({
    leadRoot: -0.35,
    leadTip: -0.05,
    trailRoot: 3.4,
    trailTip: 3.5,
    rootY: 0,
    tipY: 1.45,
    rootX: 0,
    tipX: 0,
    thickness: 0.16,
  });
  disposables.push(finGeo, canardGeo, pylonGeo);

  const fins: THREE.Mesh[] = [];
  const canards: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const fin = new THREE.Mesh(finGeo, structureMat);
    fin.position.set(side * (NACELLE_X + 0.02), 0.18, 0);
    fin.rotation.z = side * -0.3;
    fins.push(fin);
    body.add(fin);

    // Canards ride the hull shoulder, rotated so the span runs outboard.
    const canard = new THREE.Mesh(canardGeo, structureMat);
    canard.position.set(side * 0.42, -0.02, 0);
    canard.rotation.z = side * -Math.PI * 0.5;
    canard.rotation.y = side * 0.1;
    canards.push(canard);
    body.add(canard);

    // Pylon: the same aerofoil laid flat, carrying the pod out from the flank.
    const pylon = new THREE.Mesh(pylonGeo, structureMat);
    pylon.position.set(side * 0.62, NACELLE_Y + 0.04, 0);
    pylon.rotation.z = side * -Math.PI * 0.5;
    body.add(pylon);
  }

  // --- Engine cores and plumes ------------------------------------------
  const coreGeo = new THREE.CircleGeometry(0.3, 26);
  const coreMat = createCoreMaterial(u);
  disposables.push(coreGeo, coreMat);

  const plumeGeo = new THREE.CylinderGeometry(0.05, 0.28, 5, 18, 1, true);
  plumeGeo.rotateX(Math.PI * 0.5);
  plumeGeo.translate(0, 0, 2.5);
  const plumeMat = createPlumeMaterial(u);
  disposables.push(plumeGeo, plumeMat);

  const plumes: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const x = side * (NACELLE_X + curveAt(NACELLE_SPLAY, 1));
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.set(x, NACELLE_Y, EXHAUST_Z);
    core.renderOrder = 2;
    body.add(core);

    const plume = new THREE.Mesh(plumeGeo, plumeMat);
    plume.position.set(x, NACELLE_Y, EXHAUST_Z + 0.08);
    plume.renderOrder = 3;
    plume.frustumCulled = false;
    plumes.push(plume);
    body.add(plume);
  }

  // --- Hover pads -------------------------------------------------------
  const padGeo = buildHoverPadGeometry();
  const padMat = createPadMaterial(options, u);
  const pads = new THREE.Mesh(padGeo, padMat);
  pads.renderOrder = 2;
  body.add(pads);
  disposables.push(padGeo, padMat);

  // --- Shield shell -----------------------------------------------------
  const shieldMat = createShieldMaterial(options, u);
  const shield = new THREE.Mesh(hullGeo, shieldMat);
  shield.renderOrder = 5;
  shield.name = 'ship-shield';
  body.add(shield);
  disposables.push(shieldMat);

  // --- Explosion debris -------------------------------------------------
  const debris = new THREE.Group();
  debris.matrixAutoUpdate = false;
  debris.visible = false;
  root.add(debris);

  const shardGeo = new THREE.TetrahedronGeometry(0.34, 0);
  const shardMat = createDebrisMaterial(options, u);
  const shards = new THREE.InstancedMesh(shardGeo, shardMat, SHARD_COUNT);
  shards.frustumCulled = false;
  debris.add(shards);
  disposables.push(shardGeo, shardMat);

  const flashGeo = new THREE.SphereGeometry(1, 16, 12);
  const flashMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  flashMat.blending = THREE.AdditiveBlending;
  const flashFade = floatUniform(0);
  // A shell, not a ball: the fresnel keeps the flash reading as an expanding
  // shockwave rather than a white sphere parked on the track.
  const flashFresnel = normalView.z.abs().oneMinus().pow(3.5);
  flashMat.colorNode = vec4(
    mix(color(options.colors.engine), color(0xffffff), flashFade).mul(1.3),
    flashFresnel.mul(flashFade).clamp(0, 1).mul(0.8),
  );
  const flash = new THREE.Mesh(flashGeo, flashMat);
  flash.frustumCulled = false;
  debris.add(flash);
  disposables.push(flashGeo, flashMat);

  // Debris state, preallocated: nothing here allocates once the race starts.
  const shardVel = new Float32Array(SHARD_COUNT * 3);
  const shardPos = new Float32Array(SHARD_COUNT * 3);
  const shardSpin = new Float32Array(SHARD_COUNT * 3);
  const shardRot = new Float32Array(SHARD_COUNT * 3);
  const shardScale = new Float32Array(SHARD_COUNT);
  const debrisWorld = new THREE.Matrix4();
  let debrisTimer = 0;

  // Smoothed drivers, so a one-frame spike in the sim never pops the visuals.
  let smoothBoost = 0;
  let smoothTurbo = 0;
  let smoothSpeed = 0;
  let smoothGround = 1;
  let shieldHit = 0;
  let bob = 0;

  function update(state: ShipVisualState): void {
    const dt = state.dt > 0 ? Math.min(state.dt, 0.1) : 0;
    root.position.copy(state.position);
    root.quaternion.copy(state.quaternion);

    const k = Math.min(1, dt * 12);
    smoothBoost += (state.boost - smoothBoost) * k;
    smoothSpeed += (state.speedFraction - smoothSpeed) * k;
    smoothTurbo += (state.turboTier - smoothTurbo) * Math.min(1, dt * 7);
    smoothGround += ((state.airborne ? 0 : 1) - smoothGround) * Math.min(1, dt * 6);

    // The shield shell flares on a hit and on scrapes, then settles back.
    const hitTarget = Math.max(state.damageFlash, state.wallContact ? 0.45 : 0);
    shieldHit = Math.max(hitTarget, shieldHit - dt * 1.9);

    u.speed.value = smoothSpeed;
    u.boost.value = smoothBoost;
    u.turbo.value = smoothTurbo;
    u.damage.value = state.damageFlash;
    u.shield.value = state.shieldFraction;
    u.shieldHit.value = shieldHit;
    u.invuln.value = state.invulnerable ? 1 : 0;
    u.beat.value = state.beatPulse;
    u.grounded.value = smoothGround;

    // Ghosts are known up front, but a live craft can still be faded (spectator
    // handoff, replay scrub). Latch transparency the first time it is asked for.
    if (state.ghostAlpha < 0.999) {
      u.ghost.value = 1 - state.ghostAlpha;
      if (!hullMat.transparent) {
        hullMat.transparent = true;
        hullMat.depthWrite = false;
        hullMat.needsUpdate = true;
        structureMat.transparent = true;
        structureMat.depthWrite = false;
        structureMat.needsUpdate = true;
      }
      hullMat.opacity = state.ghostAlpha;
      structureMat.opacity = state.ghostAlpha;
      canopyMat.opacity = state.ghostAlpha;
    } else if (u.ghost.value !== 0) {
      u.ghost.value = 0;
      hullMat.opacity = 1;
      structureMat.opacity = 1;
      canopyMat.opacity = 1;
    }

    // Attitude flourishes. The simulation already owns yaw/pitch/roll; these
    // are deliberately small — an airbrake flare and a hover bob, nothing that
    // could be mistaken for the craft's actual attitude.
    bob += dt;
    const flare = state.slip * 0.5;
    fins[0].rotation.z = 0.28 - flare;
    fins[1].rotation.z = -0.28 + flare;
    canards[0].rotation.y = -0.12 - state.slip * 0.22 + (state.airborne ? 0.12 : 0);
    canards[1].rotation.y = 0.12 + state.slip * 0.22 - (state.airborne ? 0.12 : 0);
    body.position.y = Math.sin(bob * 2.3) * 0.045 * smoothGround;
    body.rotation.x = smoothGround * -0.012 + state.slip * 0.02;

    // Exhaust length tracks boost hard and speed gently.
    const plumeLength = 0.35 + smoothSpeed * 0.55 + smoothBoost * 1.5;
    const plumeGirth = 0.7 + smoothBoost * 0.55 + smoothSpeed * 0.15;
    for (const plume of plumes) {
      plume.scale.set(plumeGirth, plumeGirth, plumeLength);
      plume.visible = plumeLength > 0.4;
    }

    if (debrisTimer > 0) {
      debrisTimer -= dt;
      const age = 1 - Math.max(0, debrisTimer) / EXPLODE_SECONDS;
      // Hold the burst where it was born: undo the ship's transform, then
      // re-apply the transform recorded at the moment of the explosion.
      _scratchMatrix.compose(state.position, state.quaternion, _unitScale).invert();
      debris.matrix.multiplyMatrices(_scratchMatrix, debrisWorld);
      debris.matrixWorldNeedsUpdate = true;

      for (let i = 0; i < SHARD_COUNT; i++) {
        const o = i * 3;
        shardVel[o + 1] -= 9 * dt;
        shardVel[o] *= 1 - dt * 0.9;
        shardVel[o + 1] *= 1 - dt * 0.9;
        shardVel[o + 2] *= 1 - dt * 0.9;
        shardPos[o] += shardVel[o] * dt;
        shardPos[o + 1] += shardVel[o + 1] * dt;
        shardPos[o + 2] += shardVel[o + 2] * dt;
        shardRot[o] += shardSpin[o] * dt;
        shardRot[o + 1] += shardSpin[o + 1] * dt;
        shardRot[o + 2] += shardSpin[o + 2] * dt;
        _scratchVec.set(shardPos[o], shardPos[o + 1], shardPos[o + 2]);
        _scratchQuat.setFromEuler(_scratchEuler.set(shardRot[o], shardRot[o + 1], shardRot[o + 2]));
        const s = shardScale[i] * Math.max(0, 1 - age * age);
        _scratchMatrix.compose(_scratchVec, _scratchQuat, _scratchScale.set(s, s, s));
        shards.setMatrixAt(i, _scratchMatrix);
      }
      shards.instanceMatrix.needsUpdate = true;

      const flashAge = Math.min(1, age * 4.5);
      flash.scale.setScalar(1.4 + flashAge * 9);
      flashFade.value = Math.max(0, 1 - flashAge) ** 1.4;
      if (debrisTimer <= 0) debris.visible = false;
    }
  }

  function explode(): void {
    if (isGhost) return;
    debrisTimer = EXPLODE_SECONDS;
    debris.visible = true;
    debrisWorld.compose(root.position, root.quaternion, _unitScale);
    debris.matrix.identity();
    for (let i = 0; i < SHARD_COUNT; i++) {
      const o = i * 3;
      // Fibonacci-ish sphere so the burst is even without an RNG allocation.
      const y = 1 - (2 * (i + 0.5)) / SHARD_COUNT;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = i * 2.399963;
      const speed = 7 + (i % 5) * 2.2;
      shardPos[o] = Math.cos(phi) * r * 0.7;
      shardPos[o + 1] = y * 0.5;
      shardPos[o + 2] = Math.sin(phi) * r * 0.7;
      shardVel[o] = Math.cos(phi) * r * speed;
      shardVel[o + 1] = y * speed * 0.8 + 3;
      shardVel[o + 2] = Math.sin(phi) * r * speed;
      shardSpin[o] = (i % 7) - 3;
      shardSpin[o + 1] = (i % 5) - 2;
      shardSpin[o + 2] = (i % 3) - 1;
      shardRot[o] = phi;
      shardRot[o + 1] = y;
      shardRot[o + 2] = 0;
      shardScale[i] = 0.6 + ((i * 37) % 11) / 14;
    }
    shards.instanceMatrix.needsUpdate = true;
    flash.scale.setScalar(1.4);
    flashFade.value = 1;
  }

  function dispose(): void {
    for (const d of disposables) d.dispose();
    root.clear();
    body.clear();
    debris.clear();
  }

  return { object: root, update, explode, dispose };
}
