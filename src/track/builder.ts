import { Vector3, Quaternion, Matrix3 } from 'three';
import type { ControlPoint, TrackSegment } from './types';
import { DEG, clamp, smoothstep } from '../core/mathx';

/**
 * Walks a list of {@link TrackSegment} instructions with a cursor that carries a
 * full orientation frame (forward + up), emitting dense control points.
 *
 * Carrying `up` through every segment is what makes inversions work: after a
 * vertical loop the surface normal genuinely points at the world floor, and the
 * ship — which lives in track space — never notices anything unusual happened.
 */

/** Emit a point at least this often along the path, in metres. */
const MAX_STEP = 9;
/** ...and at least this often in terms of frame rotation, in radians. */
const MAX_ANGLE = 7 * DEG;
/** Control points closer together than this are merged. */
const MIN_SEPARATION = 0.75;
/** Below this positional and angular error the path is treated as already closed. */
const CLOSED_ENOUGH_DISTANCE = 18;
const CLOSED_ENOUGH_ANGLE = 8 * DEG;
/** Residuals under this are absorbed across the lap; beyond it, a bridge is built. */
const DISTRIBUTE_LIMIT = 90;

export interface Cursor {
  position: Vector3;
  forward: Vector3;
  up: Vector3;
}

export interface BuildOptions {
  halfWidth: number;
  /** Appended bridge that returns the path to its start. */
  close?: boolean;
}

export interface BuiltPath {
  points: ControlPoint[];
  /** Distance between the raw segment end and the start, before closing. */
  closureGap: number;
  /** Angle between end heading and start heading, in degrees. */
  closureAngle: number;
  /** Cursor state after the last authored segment, before any bridge. */
  end: Cursor;
}

function makeCursor(): Cursor {
  return {
    position: new Vector3(0, 0, 0),
    forward: new Vector3(0, 0, -1),
    up: new Vector3(0, 1, 0),
  };
}

function rightOf(c: Cursor, out = new Vector3()): Vector3 {
  return out.copy(c.forward).cross(c.up).normalize();
}

/** Re-orthonormalise `up` against `forward` after any rotation, to fight drift. */
function orthonormalise(c: Cursor): void {
  c.forward.normalize();
  c.up.addScaledVector(c.forward, -c.up.dot(c.forward)).normalize();
}

/** Ease in, hold, ease out — used so banking arrives before the apex and leaves after. */
function bankRamp(t: number): number {
  return smoothstep(0, 0.28, t) * smoothstep(1, 0.72, t);
}

/** Signed rotation a segment applies about its own axes, in radians. */
function segmentAngle(seg: TrackSegment): number {
  switch (seg.kind) {
    case 'turn':
    case 'helix':
    case 'pitch':
      return seg.angle * DEG;
    case 'loop':
      return 360 * DEG * (seg.direction ?? 1);
    default:
      return 0;
  }
}

/**
 * Advances the cursor across one segment, without emitting geometry.
 *
 * This is the single source of truth for where a segment *ends*. Both the
 * geometry emitter and the closure solver drive the cursor through here, so
 * there is no way for the solver's model of the track to drift away from the
 * track that actually gets built.
 */
export function advance(cursor: Cursor, seg: TrackSegment): void {
  const q = new Quaternion();
  switch (seg.kind) {
    case 'straight':
    case 'gap': {
      const rise = seg.kind === 'straight' ? (seg.rise ?? 0) : 0;
      cursor.position.addScaledVector(cursor.forward, seg.length).addScaledVector(cursor.up, rise);
      break;
    }
    case 'turn': {
      const angle = seg.angle * DEG;
      const right = rightOf(cursor);
      const centre = cursor.position.clone().addScaledVector(right, Math.sign(angle) * seg.radius);
      const radial = cursor.position.clone().sub(centre);
      q.setFromAxisAngle(cursor.up, -angle);
      cursor.position.copy(radial.applyQuaternion(q).add(centre));
      cursor.forward.applyQuaternion(q);
      cursor.up.applyQuaternion(q);
      orthonormalise(cursor);
      break;
    }
    case 'pitch':
    case 'loop': {
      const angle = segmentAngle(seg);
      const axis = rightOf(cursor);
      const centre = cursor.position.clone().addScaledVector(cursor.up, Math.sign(angle) * seg.radius);
      const radial = cursor.position.clone().sub(centre);
      q.setFromAxisAngle(axis, angle);
      cursor.position.copy(radial.applyQuaternion(q).add(centre));
      cursor.forward.applyQuaternion(q);
      cursor.up.applyQuaternion(q);
      orthonormalise(cursor);
      break;
    }
    case 'roll':
    case 'corkscrew': {
      const total = seg.kind === 'roll' ? seg.angle * DEG : seg.turns * 360 * DEG;
      cursor.position.addScaledVector(cursor.forward, seg.length);
      cursor.up.applyQuaternion(q.setFromAxisAngle(cursor.forward, total));
      orthonormalise(cursor);
      break;
    }
    case 'helix': {
      const angle = seg.angle * DEG;
      const right = rightOf(cursor);
      const centre = cursor.position.clone().addScaledVector(right, Math.sign(angle) * seg.radius);
      const climb = cursor.up.clone();
      const radial = cursor.position.clone().sub(centre);
      q.setFromAxisAngle(cursor.up, -angle);
      cursor.position.copy(radial.applyQuaternion(q).add(centre)).addScaledVector(climb, seg.rise);
      cursor.forward.applyQuaternion(q);
      cursor.up.applyQuaternion(q);
      orthonormalise(cursor);
      break;
    }
  }
}

/** Cursor state after running the whole recipe. Cheap — emits no geometry. */
export function traverse(segments: TrackSegment[]): Cursor {
  const cursor = makeCursor();
  for (const seg of segments) advance(cursor, seg);
  return cursor;
}

class PathEmitter {
  readonly points: ControlPoint[] = [];
  private lastEmitted: Vector3 | null = null;
  private widthScale = 1;
  private wall = 1;

  constructor(private readonly halfWidth: number) {}

  /** Applied to every subsequent point until changed again. */
  setSurface(width: number, wall: number): void {
    this.widthScale = width;
    this.wall = wall;
  }

  push(position: Vector3, up: Vector3, gap = false): void {
    // Near-coincident control points make the Catmull-Rom knot spacing blow up,
    // so enforce a real minimum separation rather than just rejecting exact
    // duplicates.
    if (this.lastEmitted && this.lastEmitted.distanceToSquared(position) < MIN_SEPARATION * MIN_SEPARATION) return;
    this.points.push({
      position: position.clone(),
      up: up.clone().normalize(),
      halfWidth: this.halfWidth * this.widthScale,
      wall: gap ? 0 : this.wall,
      gap,
    });
    this.lastEmitted = position.clone();
  }

  /**
   * Drop trailing points that have crowded back up against the start.
   *
   * The loop is sampled as a closed ring, so index 0 is the neighbour of the
   * last point; leaving a near-duplicate there produces a pinched segment right
   * on the start line, which is the worst possible place for one.
   */
  trimNear(startPosition: Vector3, minDistance: number): void {
    while (
      this.points.length > 4 &&
      this.points[this.points.length - 1].position.distanceTo(startPosition) < minDistance
    ) {
      this.points.pop();
    }
  }
}

/** How many sub-steps a segment needs to respect both the length and angle budgets. */
function stepsFor(length: number, angle: number): number {
  return Math.max(2, Math.ceil(Math.max(length / MAX_STEP, Math.abs(angle) / MAX_ANGLE)));
}

export function buildPath(segments: TrackSegment[], options: BuildOptions): BuiltPath {
  const cursor = makeCursor();
  const startPosition = cursor.position.clone();
  const startForward = cursor.forward.clone();
  const startUp = cursor.up.clone();

  const emitter = new PathEmitter(options.halfWidth);
  emitter.push(cursor.position, cursor.up);

  const tmpQuat = new Quaternion();

  for (const seg of segments) {
    emitter.setSurface(seg.width ?? 1, seg.wall ?? 1);

    // Interior geometry is generated from the frame at the segment's start...
    const origin = cursor.position.clone();
    const fwd0 = cursor.forward.clone();
    const up0 = cursor.up.clone();
    const right0 = rightOf(cursor);

    switch (seg.kind) {
      case 'straight':
      case 'gap': {
        const isGap = seg.kind === 'gap';
        const rise = seg.kind === 'straight' ? (seg.rise ?? 0) : 0;
        const steps = stepsFor(seg.length, 0);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          // Smoothstep height profile has zero slope at both ends, so the
          // heading entering and leaving the segment is unchanged.
          const h = rise * (t * t * (3 - 2 * t));
          emitter.push(
            origin.clone().addScaledVector(fwd0, seg.length * t).addScaledVector(up0, h),
            up0,
            isGap,
          );
        }
        break;
      }

      case 'turn': {
        const angle = seg.angle * DEG;
        const bank = (seg.bank ?? 0) * DEG;
        const steps = stepsFor(Math.abs(angle) * seg.radius, angle);
        const centre = origin.clone().addScaledVector(right0, Math.sign(angle) * seg.radius);
        const radial = origin.clone().sub(centre);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          tmpQuat.setFromAxisAngle(up0, -angle * t);
          const p = radial.clone().applyQuaternion(tmpQuat).add(centre);
          const up = up0.clone().applyQuaternion(tmpQuat);
          if (bank !== 0) {
            const f = fwd0.clone().applyQuaternion(tmpQuat);
            up.applyQuaternion(_bankQuat.setFromAxisAngle(f, -bank * bankRamp(t)));
          }
          emitter.push(p, up);
        }
        break;
      }

      case 'pitch':
      case 'loop': {
        const angle = segmentAngle(seg);
        const steps = stepsFor(Math.abs(angle) * seg.radius, angle);
        // Curving toward +up for a climb, -up for a dive.
        const centre = origin.clone().addScaledVector(up0, Math.sign(angle) * seg.radius);
        const radial = origin.clone().sub(centre);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          tmpQuat.setFromAxisAngle(right0, angle * t);
          emitter.push(radial.clone().applyQuaternion(tmpQuat).add(centre), up0.clone().applyQuaternion(tmpQuat));
        }
        break;
      }

      case 'roll':
      case 'corkscrew': {
        const total = seg.kind === 'roll' ? seg.angle * DEG : seg.turns * 360 * DEG;
        const steps = stepsFor(seg.length, total);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          tmpQuat.setFromAxisAngle(fwd0, total * t);
          emitter.push(
            origin.clone().addScaledVector(fwd0, seg.length * t),
            up0.clone().applyQuaternion(tmpQuat),
          );
        }
        break;
      }

      case 'helix': {
        const angle = seg.angle * DEG;
        const bank = (seg.bank ?? 0) * DEG;
        const steps = stepsFor(Math.abs(angle) * seg.radius, angle);
        const centre = origin.clone().addScaledVector(right0, Math.sign(angle) * seg.radius);
        const radial = origin.clone().sub(centre);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          tmpQuat.setFromAxisAngle(up0, -angle * t);
          const p = radial
            .clone()
            .applyQuaternion(tmpQuat)
            .add(centre)
            .addScaledVector(up0, seg.rise * (t * t * (3 - 2 * t)));
          const up = up0.clone().applyQuaternion(tmpQuat);
          if (bank !== 0) {
            const f = fwd0.clone().applyQuaternion(tmpQuat);
            up.applyQuaternion(_bankQuat.setFromAxisAngle(f, -bank * bankRamp(t)));
          }
          emitter.push(p, up);
        }
        break;
      }
    }

    // ...and the authoritative end state comes from the shared advance().
    advance(cursor, seg);
  }

  const end: Cursor = {
    position: cursor.position.clone(),
    forward: cursor.forward.clone(),
    up: cursor.up.clone(),
  };
  const closureGap = cursor.position.distanceTo(startPosition);
  const closureRadians = Math.acos(clamp(cursor.forward.dot(startForward), -1, 1));

  if (options.close !== false) {
    if (closureGap < DISTRIBUTE_LIMIT && closureRadians < CLOSED_ENOUGH_ANGLE) {
      // Small residual: smear it along the whole lap rather than asking one
      // spline segment at the seam to swallow it. Concentrating even fifteen
      // metres at the join produces a corner tighter than anything authored,
      // which downstream turns into a racing line that folds back on itself.
      distributeClosure(emitter.points, startPosition, cursor.position);
    } else if (closureGap >= CLOSED_ENOUGH_DISTANCE || closureRadians >= CLOSED_ENOUGH_ANGLE) {
      closeLoop(emitter, cursor, startPosition, startForward, startUp, closureRadians);
    }
    emitter.trimNear(startPosition, MAX_STEP * 0.6);
  }

  smoothSurface(emitter.points);

  return { points: emitter.points, closureGap, closureAngle: closureRadians / DEG, end };
}

/** Scratch quaternion for banking, reused to keep the builder allocation-light. */
const _bankQuat = new Quaternion();

/**
 * Bridges the end of an authored path back to its start with a cubic Hermite.
 *
 * Only reached when {@link solveClosure} could not close the recipe on its own,
 * which for the shipped tracks means never. Kept as a safety net so a
 * hand-written or generated recipe can never produce an open track.
 */
function closeLoop(
  emitter: PathEmitter,
  end: Cursor,
  startPosition: Vector3,
  startForward: Vector3,
  startUp: Vector3,
  headingError: number,
): void {
  const p0 = end.position.clone();
  const p1 = startPosition.clone();
  const gap = p0.distanceTo(p1);
  // Tangent magnitude around 0.55 of the span gives a natural sweep. Straying
  // much above that folds the curve back on itself; below it, the join kinks.
  const scale = Math.max(gap * 0.55, gap * headingError * 0.45, 15);
  const m0 = end.forward.clone().multiplyScalar(scale);
  const m1 = startForward.clone().multiplyScalar(scale);

  const steps = Math.max(6, Math.ceil((gap + scale * 0.5) / MAX_STEP));
  const up0 = end.up.clone();
  const up1 = startUp.clone();

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const t2 = t * t;
    const t3 = t2 * t;
    const p = new Vector3()
      .addScaledVector(p0, 2 * t3 - 3 * t2 + 1)
      .addScaledVector(m0, t3 - 2 * t2 + t)
      .addScaledVector(p1, -2 * t3 + 3 * t2)
      .addScaledVector(m1, t3 - t2);

    const tangent = new Vector3()
      .addScaledVector(p0, 6 * t2 - 6 * t)
      .addScaledVector(m0, 3 * t2 - 4 * t + 1)
      .addScaledVector(p1, -6 * t2 + 6 * t)
      .addScaledVector(m1, 3 * t2 - 2 * t)
      .normalize();

    const up = up0.clone().lerp(up1, smoothstep(0, 1, t));
    if (up.lengthSq() < 1e-6) up.copy(tangent).cross(new Vector3(0, 1, 0));
    up.addScaledVector(tangent, -up.dot(tangent)).normalize();

    // The final point is dropped: the path is closed, so index 0 already is it.
    if (i < steps) emitter.push(p, up);
  }
}

// --- Closure solving --------------------------------------------------------

/** A single scalar the solver is allowed to nudge to close the loop. */
interface Knob {
  segment: number;
  field: 'length' | 'radius';
  original: number;
  /** Relative bounds; radii are held much tighter than straights. */
  min: number;
  max: number;
  /** Larger means this knob absorbs more of the correction. */
  weight: number;
}

function collectKnobs(segments: TrackSegment[]): Knob[] {
  const knobs: Knob[] = [];
  segments.forEach((seg, i) => {
    // A straight's length is the most forgiving thing to change: it shifts the
    // rest of the circuit without altering how any corner drives.
    if (seg.kind === 'straight') {
      knobs.push({ segment: i, field: 'length', original: seg.length, min: 0.45, max: 2.4, weight: seg.length });
    }
    // A corkscrew or roll also just translates along `forward`, so its length
    // is as safe to nudge as a straight's.
    if (seg.kind === 'corkscrew' || seg.kind === 'roll') {
      knobs.push({ segment: i, field: 'length', original: seg.length, min: 0.6, max: 1.8, weight: seg.length * 0.7 });
    }
    // Corner radii are fair game too, but held near the authored value because
    // radius is what determines a corner's character and its target speed.
    if (seg.kind === 'turn' || seg.kind === 'helix') {
      knobs.push({ segment: i, field: 'radius', original: seg.radius, min: 0.72, max: 1.5, weight: seg.radius * 0.5 });
    }
  });
  return knobs;
}

function readKnob(segments: TrackSegment[], knob: Knob): number {
  return (segments[knob.segment] as unknown as Record<string, number>)[knob.field];
}

function writeKnob(segments: TrackSegment[], knob: Knob, value: number): void {
  (segments[knob.segment] as unknown as Record<string, number>)[knob.field] = clamp(
    value,
    knob.original * knob.min,
    knob.original * knob.max,
  );
}

/**
 * Adjusts straight lengths and corner radii so the recipe closes on itself.
 *
 * Heading closure is the author's job — turn angles are written to sum to 360°.
 * Positional closure is not something anyone should have to hit by hand, and
 * the Hermite fallback folds into a cusp when asked to span hundreds of metres,
 * which then wrecks the racing line and the speed profile downstream.
 *
 * The saving grace is that, with the angles fixed, the end position is an
 * *exactly linear* function of every length and radius in the recipe: a
 * straight contributes `forward · length`, and a turn of fixed angle contributes
 * a displacement proportional to its radius. So this is a linear system, not an
 * optimisation, and the Jacobian columns come from central differences through
 * the same {@link advance} the real builder uses.
 *
 * Three equations and a dozen-plus knobs leaves the system underdetermined,
 * which is exactly what we want: take the minimum-norm solution weighted by
 * segment size, and the correction spreads itself thinly over the whole circuit
 * instead of mangling one corner.
 */
export function solveClosure(segments: TrackSegment[]): TrackSegment[] {
  const adjusted = segments.map((s) => ({ ...s })) as TrackSegment[];
  const knobs = collectKnobs(adjusted);
  if (knobs.length < 3) return adjusted;

  const residual = new Vector3();
  const jacobian = knobs.map(() => new Vector3());
  const matrix = new Matrix3();
  const solution = new Vector3();

  for (let iteration = 0; iteration < 12; iteration++) {
    // The recipe starts at the origin, so the error is just where it ended up.
    residual.copy(traverse(adjusted).position).negate();
    if (residual.length() < 0.05) break;

    // Central differences: exact derivatives here, since the map is linear.
    for (let j = 0; j < knobs.length; j++) {
      const knob = knobs[j];
      const base = readKnob(adjusted, knob);
      const h = Math.max(base * 0.01, 0.5);

      (adjusted[knob.segment] as unknown as Record<string, number>)[knob.field] = base + h;
      const plus = traverse(adjusted).position.clone();
      (adjusted[knob.segment] as unknown as Record<string, number>)[knob.field] = base - h;
      const minus = traverse(adjusted).position;
      (adjusted[knob.segment] as unknown as Record<string, number>)[knob.field] = base;

      jacobian[j].subVectors(plus, minus).multiplyScalar(1 / (2 * h));
    }

    // Weighted Gram matrix A = J·W·Jᵀ (3×3).
    const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let j = 0; j < knobs.length; j++) {
      const d = jacobian[j];
      const w = knobs[j].weight * knobs[j].weight;
      a[0] += w * d.x * d.x;
      a[1] += w * d.x * d.y;
      a[2] += w * d.x * d.z;
      a[3] += w * d.y * d.x;
      a[4] += w * d.y * d.y;
      a[5] += w * d.y * d.z;
      a[6] += w * d.z * d.x;
      a[7] += w * d.z * d.y;
      a[8] += w * d.z * d.z;
    }
    // Ridge term: most circuits are near-planar, leaving the Gram matrix
    // singular in the vertical. This keeps the solve stable and simply declines
    // to correct along a direction the knobs cannot influence.
    const ridge = Math.max((a[0] + a[4] + a[8]) * 1e-7, 1e-4);
    a[0] += ridge;
    a[4] += ridge;
    a[8] += ridge;

    const determinant =
      a[0] * (a[4] * a[8] - a[5] * a[7]) -
      a[1] * (a[3] * a[8] - a[5] * a[6]) +
      a[2] * (a[3] * a[7] - a[4] * a[6]);
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) break;

    matrix.set(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8]);
    solution.copy(residual).applyMatrix3(matrix.invert());

    let moved = 0;
    for (let j = 0; j < knobs.length; j++) {
      const knob = knobs[j];
      const before = readKnob(adjusted, knob);
      const delta = knob.weight * knob.weight * jacobian[j].dot(solution);
      writeKnob(adjusted, knob, before + delta);
      moved += Math.abs(readKnob(adjusted, knob) - before);
    }
    // Every knob is pinned at a bound and the loop still will not close.
    if (moved < 0.02) break;
  }

  return adjusted;
}

/**
 * Closes a small residual gap by shearing it across the entire lap.
 *
 * This is the surveyor's compass rule: apply a correction that ramps linearly
 * from nothing at the start line to the full error at the far end, so the loop
 * meets itself exactly. Spread over a few thousand metres, a residual of tens
 * of metres works out to well under a percent of local displacement — invisible
 * in the geometry, and vastly preferable to a kink at the start line.
 */
function distributeClosure(points: ControlPoint[], startPosition: Vector3, endPosition: Vector3): void {
  const n = points.length;
  if (n < 2) return;
  const error = new Vector3().subVectors(startPosition, endPosition);
  if (error.lengthSq() < 1e-8) return;
  for (let i = 0; i < n; i++) {
    points[i].position.addScaledVector(error, i / (n - 1));
  }
}

/**
 * Blends half-width and wall height across segment joins.
 *
 * Authoring sets these per segment, which would otherwise step abruptly at each
 * boundary — a track that snaps from 30 m wide to 18 m in one control point
 * reads as a wall appearing out of nowhere. A short windowed average over
 * roughly forty metres turns every change into a ramp the player can see coming.
 */
function smoothSurface(points: ControlPoint[]): void {
  const n = points.length;
  if (n < 5) return;
  const RADIUS = 2;
  const widths = points.map((p) => p.halfWidth);
  const walls = points.map((p) => p.wall);
  for (let i = 0; i < n; i++) {
    let w = 0;
    let v = 0;
    let count = 0;
    for (let d = -RADIUS; d <= RADIUS; d++) {
      const k = (((i + d) % n) + n) % n;
      w += widths[k];
      v += walls[k];
      count++;
    }
    points[i].halfWidth = w / count;
    points[i].wall = v / count;
  }
}
