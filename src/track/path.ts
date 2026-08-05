import { Vector3 } from 'three';
import type { ControlPoint, PathFrame } from './types';
import { clamp, mod } from '../core/mathx';

/**
 * A closed racing line resampled to uniform arc length.
 *
 * Control points are smoothed with a centripetal Catmull-Rom (which, unlike the
 * uniform variant, never loops back on itself around tight control points) and
 * then re-sampled at a fixed metre spacing. Uniform spacing is the whole point:
 * it turns "where am I on the track" into an array index instead of a search,
 * which is what lets ships, AI, cameras, and the HUD all work in track space
 * every frame for free.
 *
 * Track space is (s, lateral, height):
 *   world = position(s) + right(s) * lateral + up(s) * height
 */
export class TrackPath {
  /** Total centreline length in metres. */
  readonly length: number;
  /** Spacing between stored samples, in metres. */
  readonly step: number;
  /** Number of stored samples. */
  readonly count: number;

  private readonly pos: Float32Array;
  private readonly tan: Float32Array;
  private readonly nrm: Float32Array;
  private readonly rgt: Float32Array;
  private readonly halfWidths: Float32Array;
  private readonly walls: Float32Array;
  private readonly gaps: Uint8Array;
  private readonly curv: Float32Array;

  /** Coarse buckets of sample indices, for nearest-point queries without a hint. */
  private readonly grid = new Map<number, number[]>();
  private readonly gridCell = 60;

  readonly bounds = { min: new Vector3(), max: new Vector3() };

  constructor(controlPoints: ControlPoint[], targetStep = 2.5) {
    const n = controlPoints.length;
    if (n < 4) throw new Error(`TrackPath needs at least 4 control points, got ${n}`);

    // --- Pass 1: dense evaluation to measure arc length -------------------
    const SUB = 8;
    const denseCount = n * SUB;
    const denseU = new Float64Array(denseCount + 1);
    const denseArc = new Float64Array(denseCount + 1);
    const tmpA = new Vector3();
    const tmpB = new Vector3();

    evalPosition(controlPoints, 0, tmpB);
    let arc = 0;
    denseU[0] = 0;
    denseArc[0] = 0;
    for (let i = 1; i <= denseCount; i++) {
      const u = (i / denseCount) * n;
      evalPosition(controlPoints, u, tmpA);
      arc += tmpA.distanceTo(tmpB);
      tmpB.copy(tmpA);
      denseU[i] = u;
      denseArc[i] = arc;
    }

    this.length = arc;
    this.count = Math.max(16, Math.round(arc / targetStep));
    this.step = arc / this.count;

    // --- Pass 2: resample at uniform arc length ---------------------------
    const c = this.count;
    this.pos = new Float32Array(c * 3);
    this.tan = new Float32Array(c * 3);
    this.nrm = new Float32Array(c * 3);
    this.rgt = new Float32Array(c * 3);
    this.halfWidths = new Float32Array(c);
    this.walls = new Float32Array(c);
    this.gaps = new Uint8Array(c);
    this.curv = new Float32Array(c);

    const p = new Vector3();
    const up = new Vector3();
    let cursor = 0;
    for (let k = 0; k < c; k++) {
      const target = k * this.step;
      while (cursor < denseCount && denseArc[cursor + 1] < target) cursor++;
      const a0 = denseArc[cursor];
      const a1 = denseArc[Math.min(cursor + 1, denseCount)];
      const f = a1 > a0 ? (target - a0) / (a1 - a0) : 0;
      const u = denseU[cursor] + (denseU[Math.min(cursor + 1, denseCount)] - denseU[cursor]) * f;

      evalPosition(controlPoints, u, p);
      evalUp(controlPoints, u, up);
      const scalars = evalScalars(controlPoints, u);

      this.pos[k * 3] = p.x;
      this.pos[k * 3 + 1] = p.y;
      this.pos[k * 3 + 2] = p.z;
      this.nrm[k * 3] = up.x;
      this.nrm[k * 3 + 1] = up.y;
      this.nrm[k * 3 + 2] = up.z;
      this.halfWidths[k] = scalars.halfWidth;
      this.walls[k] = scalars.wall;
      this.gaps[k] = scalars.gap ? 1 : 0;
    }

    // --- Pass 3: derive tangents, orthonormalise, compute curvature -------
    const pPrev = new Vector3();
    const pNext = new Vector3();
    const t = new Vector3();
    const u2 = new Vector3();
    const r = new Vector3();
    for (let k = 0; k < c; k++) {
      const kp = mod(k - 1, c);
      const kn = mod(k + 1, c);
      pPrev.fromArray(this.pos, kp * 3);
      pNext.fromArray(this.pos, kn * 3);
      t.subVectors(pNext, pPrev).normalize();
      if (t.lengthSq() < 0.5) t.set(0, 0, -1);

      u2.fromArray(this.nrm, k * 3);
      // Project `up` back into the plane perpendicular to the tangent. The
      // Catmull-Rom smoothing shifts things slightly; this keeps the basis
      // strictly orthonormal so track space stays metric.
      u2.addScaledVector(t, -u2.dot(t));
      if (u2.lengthSq() < 1e-6) {
        u2.set(0, 1, 0).addScaledVector(t, -t.y);
        if (u2.lengthSq() < 1e-6) u2.set(1, 0, 0);
      }
      u2.normalize();
      r.copy(t).cross(u2).normalize();

      this.tan[k * 3] = t.x;
      this.tan[k * 3 + 1] = t.y;
      this.tan[k * 3 + 2] = t.z;
      this.nrm[k * 3] = u2.x;
      this.nrm[k * 3 + 1] = u2.y;
      this.nrm[k * 3 + 2] = u2.z;
      this.rgt[k * 3] = r.x;
      this.rgt[k * 3 + 1] = r.y;
      this.rgt[k * 3 + 2] = r.z;
    }

    // Signed horizontal curvature: how fast the tangent swings toward `right`.
    const tPrev = new Vector3();
    const tNext = new Vector3();
    const dT = new Vector3();
    for (let k = 0; k < c; k++) {
      tPrev.fromArray(this.tan, mod(k - 1, c) * 3);
      tNext.fromArray(this.tan, mod(k + 1, c) * 3);
      dT.subVectors(tNext, tPrev).multiplyScalar(1 / (2 * this.step));
      r.fromArray(this.rgt, k * 3);
      this.curv[k] = dT.dot(r);
    }

    this.buildGrid();
    this.computeBounds();
  }

  private buildGrid(): void {
    const p = new Vector3();
    for (let k = 0; k < this.count; k++) {
      p.fromArray(this.pos, k * 3);
      const key = this.cellKey(p);
      let bucket = this.grid.get(key);
      if (!bucket) this.grid.set(key, (bucket = []));
      bucket.push(k);
    }
  }

  private cellKey(p: Vector3): number {
    const x = Math.floor(p.x / this.gridCell);
    const y = Math.floor(p.y / this.gridCell);
    const z = Math.floor(p.z / this.gridCell);
    // Cheap spatial hash; collisions just mean a slightly longer candidate list.
    return (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  }

  private computeBounds(): void {
    this.bounds.min.set(Infinity, Infinity, Infinity);
    this.bounds.max.set(-Infinity, -Infinity, -Infinity);
    const p = new Vector3();
    for (let k = 0; k < this.count; k++) {
      p.fromArray(this.pos, k * 3);
      this.bounds.min.min(p);
      this.bounds.max.max(p);
    }
  }

  /** Wrap an arc-length value into [0, length). */
  wrap(s: number): number {
    return mod(s, this.length);
  }

  private indexOf(s: number): { i0: number; i1: number; f: number } {
    const x = this.wrap(s) / this.step;
    const i0 = Math.floor(x) % this.count;
    return { i0, i1: (i0 + 1) % this.count, f: x - Math.floor(x) };
  }

  /** Fill `out` with the interpolated frame at arc position `s`. */
  frameAt(s: number, out: PathFrame): PathFrame {
    const { i0, i1, f } = this.indexOf(s);
    out.s = this.wrap(s);
    lerpVec(this.pos, i0, i1, f, out.position);
    lerpVec(this.tan, i0, i1, f, out.tangent).normalize();
    lerpVec(this.nrm, i0, i1, f, out.up);
    // Re-orthonormalise after the lerp so callers always get a valid basis.
    out.up.addScaledVector(out.tangent, -out.up.dot(out.tangent));
    if (out.up.lengthSq() < 1e-6) out.up.set(0, 1, 0);
    out.up.normalize();
    out.right.copy(out.tangent).cross(out.up).normalize();
    out.halfWidth = this.halfWidths[i0] + (this.halfWidths[i1] - this.halfWidths[i0]) * f;
    out.wall = this.walls[i0] + (this.walls[i1] - this.walls[i0]) * f;
    out.gap = this.gaps[i0] === 1;
    out.curvature = this.curv[i0] + (this.curv[i1] - this.curv[i0]) * f;
    return out;
  }

  /** Allocating convenience wrapper — avoid in the hot loop. */
  sample(s: number): PathFrame {
    return this.frameAt(s, createFrame());
  }

  halfWidthAt(s: number): number {
    const { i0, i1, f } = this.indexOf(s);
    return this.halfWidths[i0] + (this.halfWidths[i1] - this.halfWidths[i0]) * f;
  }

  wallAt(s: number): number {
    const { i0, i1, f } = this.indexOf(s);
    return this.walls[i0] + (this.walls[i1] - this.walls[i0]) * f;
  }

  isGapAt(s: number): boolean {
    return this.gaps[this.indexOf(s).i0] === 1;
  }

  curvatureAt(s: number): number {
    const { i0, i1, f } = this.indexOf(s);
    return this.curv[i0] + (this.curv[i1] - this.curv[i0]) * f;
  }

  /**
   * Mean absolute curvature over the next `distance` metres. AI and the
   * auto-brake assist use this to see corners coming.
   */
  lookaheadCurvature(s: number, distance: number): number {
    const steps = Math.max(1, Math.round(distance / this.step));
    let sum = 0;
    const start = Math.floor(this.wrap(s) / this.step);
    for (let i = 0; i < steps; i++) sum += this.curv[(start + i) % this.count];
    return sum / steps;
  }

  /** Signed curvature at a point `distance` metres ahead. */
  curvatureAhead(s: number, distance: number): number {
    return this.curvatureAt(s + distance);
  }

  positionAt(s: number, out = new Vector3()): Vector3 {
    const { i0, i1, f } = this.indexOf(s);
    return lerpVec(this.pos, i0, i1, f, out);
  }

  /** Convert track-space coordinates into world space. */
  toWorld(s: number, lateral: number, height: number, out = new Vector3()): Vector3 {
    const { i0, i1, f } = this.indexOf(s);
    const p = lerpVec(this.pos, i0, i1, f, out);
    const r = lerpVec(this.rgt, i0, i1, f, _tmpR).normalize();
    const u = lerpVec(this.nrm, i0, i1, f, _tmpU).normalize();
    return p.addScaledVector(r, lateral).addScaledVector(u, height);
  }

  /**
   * Project a world position into track space.
   *
   * Pass `hintS` whenever you have one (every moving entity does) — it turns an
   * O(n) sweep into a small local search.
   */
  toTrack(world: Vector3, hintS?: number): { s: number; lateral: number; height: number } {
    let best = -1;
    if (hintS !== undefined) {
      // Local window: at 2.5 m spacing, ±120 samples is ±300 m of track.
      const centre = Math.round(this.wrap(hintS) / this.step);
      let bestD = Infinity;
      for (let d = -120; d <= 120; d++) {
        const k = mod(centre + d, this.count);
        const dist = distSq(this.pos, k, world);
        if (dist < bestD) {
          bestD = dist;
          best = k;
        }
      }
    } else {
      best = this.coarseNearest(world);
    }

    // Refine within the two neighbouring intervals by projecting onto the
    // tangent — gives sub-sample accuracy without another search.
    const p = _tmpP.fromArray(this.pos, best * 3);
    const t = _tmpT.fromArray(this.tan, best * 3);
    const u = _tmpU.fromArray(this.nrm, best * 3);
    const r = _tmpR.fromArray(this.rgt, best * 3);
    const rel = _tmpRel.subVectors(world, p);
    const along = clamp(rel.dot(t), -this.step, this.step);
    return {
      s: this.wrap(best * this.step + along),
      lateral: rel.dot(r),
      height: rel.dot(u),
    };
  }

  private coarseNearest(world: Vector3): number {
    // Try the spatial hash first; fall back to a strided sweep if the point is
    // nowhere near the track (e.g. a camera flying free in photo mode).
    let best = -1;
    let bestD = Infinity;
    const cx = Math.floor(world.x / this.gridCell);
    const cy = Math.floor(world.y / this.gridCell);
    const cz = Math.floor(world.z / this.gridCell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = ((cx + dx) * 73856093) ^ ((cy + dy) * 19349663) ^ ((cz + dz) * 83492791);
          const bucket = this.grid.get(key);
          if (!bucket) continue;
          for (const k of bucket) {
            const d = distSq(this.pos, k, world);
            if (d < bestD) {
              bestD = d;
              best = k;
            }
          }
        }
      }
    }
    if (best >= 0) return best;

    const stride = Math.max(1, Math.floor(this.count / 512));
    for (let k = 0; k < this.count; k += stride) {
      const d = distSq(this.pos, k, world);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    let refined = best;
    for (let k = best - stride; k <= best + stride; k++) {
      const idx = mod(k, this.count);
      const d = distSq(this.pos, idx, world);
      if (d < bestD) {
        bestD = d;
        refined = idx;
      }
    }
    return refined;
  }

  /** Raw sample accessors, for mesh building where we want the stored data verbatim. */
  rawPosition(k: number, out = new Vector3()): Vector3 {
    return out.fromArray(this.pos, mod(k, this.count) * 3);
  }
  rawUp(k: number, out = new Vector3()): Vector3 {
    return out.fromArray(this.nrm, mod(k, this.count) * 3);
  }
  rawRight(k: number, out = new Vector3()): Vector3 {
    return out.fromArray(this.rgt, mod(k, this.count) * 3);
  }
  rawTangent(k: number, out = new Vector3()): Vector3 {
    return out.fromArray(this.tan, mod(k, this.count) * 3);
  }
  rawHalfWidth(k: number): number {
    return this.halfWidths[mod(k, this.count)];
  }
  rawWall(k: number): number {
    return this.walls[mod(k, this.count)];
  }
  rawGap(k: number): boolean {
    return this.gaps[mod(k, this.count)] === 1;
  }
  rawCurvature(k: number): number {
    return this.curv[mod(k, this.count)];
  }
}

export function createFrame(): PathFrame {
  return {
    s: 0,
    position: new Vector3(),
    tangent: new Vector3(0, 0, -1),
    up: new Vector3(0, 1, 0),
    right: new Vector3(1, 0, 0),
    halfWidth: 20,
    wall: 1,
    gap: false,
    curvature: 0,
  };
}

// --- Catmull-Rom evaluation -------------------------------------------------

const _tmpP = new Vector3();
const _tmpT = new Vector3();
const _tmpU = new Vector3();
const _tmpR = new Vector3();
const _tmpRel = new Vector3();
const _p0 = new Vector3();
const _p1 = new Vector3();
const _p2 = new Vector3();
const _p3 = new Vector3();
const _m1 = new Vector3();
const _m2 = new Vector3();

function knot(a: Vector3, b: Vector3): number {
  // alpha = 0.5 gives the centripetal variant, which cannot self-intersect
  // between control points the way the uniform variant does on tight corners.
  return Math.pow(Math.max(a.distanceTo(b), 1e-4), 0.5);
}

/** Evaluate the closed spline at parameter `u`, where u is in [0, pointCount). */
function evalPosition(cp: ControlPoint[], u: number, out: Vector3): Vector3 {
  const n = cp.length;
  const i = Math.floor(mod(u, n));
  const t = mod(u, n) - i;
  _p0.copy(cp[mod(i - 1, n)].position);
  _p1.copy(cp[i].position);
  _p2.copy(cp[mod(i + 1, n)].position);
  _p3.copy(cp[mod(i + 2, n)].position);
  return hermiteCR(_p0, _p1, _p2, _p3, t, out);
}

function evalUp(cp: ControlPoint[], u: number, out: Vector3): Vector3 {
  const n = cp.length;
  const i = Math.floor(mod(u, n));
  const t = mod(u, n) - i;
  _p0.copy(cp[mod(i - 1, n)].up);
  _p1.copy(cp[i].up);
  _p2.copy(cp[mod(i + 1, n)].up);
  _p3.copy(cp[mod(i + 2, n)].up);
  // Keep neighbours on the same hemisphere before blending, otherwise a
  // corkscrew's rotating normal briefly cancels itself out at the halfway mark.
  if (_p0.dot(_p1) < 0) _p0.negate();
  if (_p2.dot(_p1) < 0) _p2.negate();
  if (_p3.dot(_p2) < 0) _p3.negate();
  hermiteCR(_p0, _p1, _p2, _p3, t, out);
  if (out.lengthSq() < 1e-8) out.copy(_p1);
  return out.normalize();
}

function evalScalars(cp: ControlPoint[], u: number): { halfWidth: number; wall: number; gap: boolean } {
  const n = cp.length;
  const i = Math.floor(mod(u, n));
  const t = mod(u, n) - i;
  const a = cp[i];
  const b = cp[mod(i + 1, n)];
  const smooth = t * t * (3 - 2 * t);
  return {
    halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * smooth,
    wall: a.wall + (b.wall - a.wall) * smooth,
    // A gap is a hard boolean — a half-present surface would be worse than either.
    gap: t < 0.5 ? a.gap : b.gap,
  };
}

/** Non-uniform (centripetal) Catmull-Rom expressed as a Hermite. */
function hermiteCR(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, t: number, out: Vector3): Vector3 {
  const d1 = knot(p0, p1);
  const d2 = knot(p1, p2);
  const d3 = knot(p2, p3);

  _m1.subVectors(p2, p0).multiplyScalar(d2 / Math.max(d1 + d2, 1e-6));
  _m2.subVectors(p3, p1).multiplyScalar(d2 / Math.max(d2 + d3, 1e-6));

  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  return out
    .set(0, 0, 0)
    .addScaledVector(p1, h00)
    .addScaledVector(_m1, h10)
    .addScaledVector(p2, h01)
    .addScaledVector(_m2, h11);
}

function lerpVec(arr: Float32Array, i0: number, i1: number, f: number, out: Vector3): Vector3 {
  const a = i0 * 3;
  const b = i1 * 3;
  return out.set(
    arr[a] + (arr[b] - arr[a]) * f,
    arr[a + 1] + (arr[b + 1] - arr[a + 1]) * f,
    arr[a + 2] + (arr[b + 2] - arr[a + 2]) * f,
  );
}

function distSq(arr: Float32Array, k: number, p: Vector3): number {
  const i = k * 3;
  const dx = arr[i] - p.x;
  const dy = arr[i + 1] - p.y;
  const dz = arr[i + 2] - p.z;
  return dx * dx + dy * dy + dz * dz;
}
