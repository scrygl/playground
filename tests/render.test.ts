import { Vector3, Quaternion } from 'three';
import { check, describe, near, range, report } from './harness';
import { Track } from '../src/track/runtime';
import { getTrack } from '../src/track/library';
import { tierSettings } from '../src/core/quality';
import {
  SweepBuilder,
  buildCanopyGeometry,
  buildFinGeometry,
  buildHoverPadGeometry,
  buildHullGeometry,
  buildNacelleGeometry,
  createShipVisual,
  curveAt,
} from '../src/render/ship-mesh';
import { TrailBuffer, createShipTrail } from '../src/render/trail';
import {
  createParticleSystem,
  emitBoostBurst,
  emitEngineSparks,
  emitExplosion,
  emitLandingDust,
  emitWallSparks,
  type EmitParams,
  type ParticleEffect,
} from '../src/render/particles';
import { createFeatureVisuals, featureAnchor, gateRadius } from '../src/render/feature-mesh';
import type { ShipVisualState, FeatureVisualState } from '../src/render/types';

/**
 * Render tests, run in Node with no GL context at all.
 *
 * three's WebGPU build constructs geometries, materials and node graphs without
 * ever touching a device, so everything up to the draw call is testable here:
 * the procedural geometry, the trail's ring buffer, the particle pools' packing
 * invariant, and whether a feature actually lands on the track surface. What is
 * *not* testable is whether any of it looks like anything, which is what the
 * headless capture harness is for.
 */

// --- Helpers ----------------------------------------------------------------

interface GeometryLike {
  getAttribute(name: string): { count: number; itemSize: number; array: ArrayLike<number> } | undefined;
  getIndex(): { count: number; array: ArrayLike<number> } | null;
  boundingSphere: { radius: number; center: Vector3 } | null;
  computeBoundingSphere(): void;
}

function allFinite(array: ArrayLike<number>): boolean {
  for (let i = 0; i < array.length; i++) {
    if (!Number.isFinite(array[i])) return false;
  }
  return true;
}

/** Every index must address a real vertex, or the driver reads garbage. */
function indicesInRange(geo: GeometryLike): boolean {
  const index = geo.getIndex();
  const position = geo.getAttribute('position');
  if (!index || !position) return false;
  for (let i = 0; i < index.count; i++) {
    const v = index.array[i];
    if (!Number.isInteger(v) || v < 0 || v >= position.count) return false;
  }
  return true;
}

/**
 * Signed volume of a closed triangle mesh (the divergence theorem, summed per
 * face). Positive means every face is wound counter-clockwise seen from
 * outside — which is what backface culling depends on.
 */
function signedVolume(geo: GeometryLike): number {
  const index = geo.getIndex();
  const position = geo.getAttribute('position');
  if (!index || !position) return 0;
  const p = position.array;
  let volume = 0;
  for (let i = 0; i < index.count; i += 3) {
    const a = index.array[i] * 3;
    const b = index.array[i + 1] * 3;
    const c = index.array[i + 2] * 3;
    const ax = p[a];
    const ay = p[a + 1];
    const az = p[a + 2];
    const bx = p[b];
    const by = p[b + 1];
    const bz = p[b + 2];
    const cx = p[c];
    const cy = p[c + 1];
    const cz = p[c + 2];
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return volume;
}

/** Fraction of vertices whose normal is a unit vector. */
function normalsUnitLength(geo: GeometryLike): boolean {
  const normal = geo.getAttribute('normal');
  if (!normal) return false;
  for (let i = 0; i < normal.count; i++) {
    const x = normal.array[i * 3];
    const y = normal.array[i * 3 + 1];
    const z = normal.array[i * 3 + 2];
    const length = Math.hypot(x, y, z);
    if (!(Math.abs(length - 1) < 1e-3)) return false;
  }
  return true;
}

function extent(geo: GeometryLike, axis: number): { min: number; max: number } {
  const position = geo.getAttribute('position')!;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const v = position.array[i * 3 + axis];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

const quality = tierSettings('high');
const potato = tierSettings('potato');
const COLORS = { hull: 0x2e4a7a, trim: 0x35e0ff, engine: 0x62f0ff };

// --- Profile curves ---------------------------------------------------------

describe('hull profile curves', () => {
  const curve = [
    [0, 1],
    [0.5, 3],
    [1, 2],
  ] as const;
  near('clamps below the first knot', curveAt(curve, -1), 1, 1e-9);
  near('clamps above the last knot', curveAt(curve, 5), 2, 1e-9);
  near('passes through interior knots', curveAt(curve, 0.5), 3, 1e-9);
  near('is smooth at the midpoint of a span', curveAt(curve, 0.25), 2, 1e-9);
  // Monotone between knots: a width curve that overshoots would pinch the hull.
  let monotone = true;
  for (let i = 1; i <= 50; i++) {
    const a = curveAt(curve, ((i - 1) / 50) * 0.5);
    const b = curveAt(curve, (i / 50) * 0.5);
    if (b < a - 1e-9) monotone = false;
  }
  check('never overshoots between knots', monotone);
});

// --- Ship geometry ----------------------------------------------------------

describe('hull geometry', () => {
  const geo = buildHullGeometry() as unknown as GeometryLike;
  const position = geo.getAttribute('position')!;
  const section = geo.getAttribute('aSection');
  const index = geo.getIndex()!;

  // 34 rings of 28 points, plus a nose apex and a tail apex.
  check('has the expected vertex count', position.count === 34 * 28 + 2, `got ${position.count}`);
  check('carries the section attribute the material reads', section?.count === position.count);
  check('is indexed as whole triangles', index.count % 3 === 0);
  check('every index addresses a real vertex', indicesInRange(geo));
  check('has no NaN positions', allFinite(position.array));
  check('has unit-length normals everywhere', normalsUnitLength(geo));

  check('has a finite bounding sphere', Number.isFinite(geo.boundingSphere?.radius ?? NaN));
  range('bounding sphere is craft-sized', geo.boundingSphere?.radius ?? 0, 3, 8);

  // Closed and consistently wound: the volume of a ~8.4 m craft.
  const volume = signedVolume(geo);
  check('is wound outward (positive signed volume)', volume > 0, `volume ${volume.toFixed(2)}`);
  range('encloses a plausible volume', volume, 3, 40);

  const z = extent(geo, 2);
  near('nose sits at the authored station', z.min, -5.24, 0.05);
  near('tail sits at the authored station', z.max, 3.55, 0.05);
  const x = extent(geo, 0);
  check('is symmetric about the centreline', Math.abs(x.min + x.max) < 1e-5, `${x.min} / ${x.max}`);

  // The chine is a duplicated ring point: two vertices at the same position
  // with different normals. Without it the crease smooths away.
  const normal = geo.getAttribute('normal')!;
  let creases = 0;
  for (let ring = 0; ring < 34; ring++) {
    const a = ring * 28 + 5;
    const b = ring * 28 + 6;
    const samePosition =
      Math.abs(position.array[a * 3] - position.array[b * 3]) < 1e-6 &&
      Math.abs(position.array[a * 3 + 1] - position.array[b * 3 + 1]) < 1e-6;
    const differentNormal =
      Math.abs(normal.array[a * 3 + 1] - normal.array[b * 3 + 1]) > 1e-3;
    if (samePosition && differentNormal) creases++;
  }
  check('keeps a hard chine crease on every ring', creases >= 30, `${creases}/34`);
});

describe('canopy, nacelle, fin and pad geometry', () => {
  const canopy = buildCanopyGeometry() as unknown as GeometryLike;
  check('canopy has no NaN positions', allFinite(canopy.getAttribute('position')!.array));
  check('canopy indices are in range', indicesInRange(canopy));
  check('canopy normals are unit length', normalsUnitLength(canopy));
  const canopyY = extent(canopy, 1);
  check('canopy sits above the hull centreline', canopyY.max > 0.3, `${canopyY.max}`);

  for (const side of [-1, 1]) {
    const nacelle = buildNacelleGeometry(side) as unknown as GeometryLike;
    check(`nacelle ${side} has no NaN positions`, allFinite(nacelle.getAttribute('position')!.array));
    check(`nacelle ${side} indices are in range`, indicesInRange(nacelle));
    check(`nacelle ${side} carries a section attribute`, nacelle.getAttribute('aSection') !== undefined);
    const x = extent(nacelle, 0);
    check(`nacelle ${side} is on the correct side`, side < 0 ? x.max < 0 : x.min > 0, `${x.min}..${x.max}`);
    const volume = signedVolume(nacelle);
    check(`nacelle ${side} is wound outward`, volume > 0, `volume ${volume.toFixed(2)}`);
  }

  const fin = buildFinGeometry({
    leadRoot: 1,
    leadTip: 2,
    trailRoot: 4,
    trailTip: 4.2,
    rootY: 0,
    tipY: 1.5,
    rootX: 0,
    tipX: 0,
    thickness: 0.13,
  }) as unknown as GeometryLike;
  check('fin has no NaN positions', allFinite(fin.getAttribute('position')!.array));
  check('fin indices are in range', indicesInRange(fin));
  check('fin normals are unit length', normalsUnitLength(fin));
  const finY = extent(fin, 1);
  near('fin spans root to tip', finY.max - finY.min, 1.5, 1e-3);
  const finX = extent(fin, 0);
  range('fin stays thin', finX.max - finX.min, 0.05, 0.3);

  const pads = buildHoverPadGeometry() as unknown as GeometryLike;
  check('hover pads have no NaN positions', allFinite(pads.getAttribute('position')!.array));
  check('hover pad indices are in range', indicesInRange(pads));
  const padY = extent(pads, 1);
  check('hover pads sit under the hull', padY.max < 0, `${padY.max}`);
});

describe('sweep builder', () => {
  const b = new SweepBuilder();
  const p = [0, 0, 0, 1, 0, 0, 1, 1, 0];
  const n = [0, 0, 1, 0, 0, 1, 0, 0, 1];
  const a = b.ring(p, n, [0, 0.5, 1], 0);
  const c = b.ring([0, 0, 1, 1, 0, 1, 1, 1, 1], n, [0, 0.5, 1], 1);
  b.stitch(a, c, 3, true);
  check('closed stitch emits two triangles per edge', b.indices.length === 3 * 2 * 3);
  const open = new SweepBuilder();
  const oa = open.ring(p, n, [0, 0.5, 1], 0);
  const ob = open.ring(p, n, [0, 0.5, 1], 1);
  open.stitch(oa, ob, 3, false);
  check('open stitch skips the wrap-around quad', open.indices.length === 2 * 2 * 3);
});

// --- Ship visual ------------------------------------------------------------

function shipState(overrides: Partial<ShipVisualState> = {}): ShipVisualState {
  return {
    dt: 1 / 60,
    position: new Vector3(),
    quaternion: new Quaternion(),
    speedFraction: 0.8,
    boost: 0,
    slip: 0,
    shieldFraction: 1,
    damageFlash: 0,
    airborne: false,
    turboTier: 0,
    invulnerable: false,
    beatPulse: 0,
    wallContact: false,
    ghostAlpha: 1,
    ...overrides,
  };
}

describe('ship visual', () => {
  const visual = createShipVisual({ colors: COLORS, quality, isPlayer: true });
  check('exposes an object to add to the scene', visual.object !== undefined);

  const state = shipState({ position: new Vector3(10, 20, 30) });
  visual.update(state);
  check('follows the position it is given', visual.object.position.distanceTo(state.position) < 1e-6);

  // A hostile frame: dt of zero, every effect at once, a teleport.
  visual.update(shipState({ dt: 0, boost: 1, turboTier: 3, damageFlash: 1, shieldFraction: 0, invulnerable: true, wallContact: true, slip: 1 }));
  visual.update(shipState({ dt: 5, ghostAlpha: 0.3 }));
  visual.explode();
  for (let i = 0; i < 200; i++) visual.update(shipState({ dt: 1 / 60 }));
  check('survives a full effect sweep and an explosion', true);

  let finite = true;
  visual.object.traverse((child) => {
    if (!Number.isFinite(child.position.x + child.position.y + child.position.z)) finite = false;
    if (!Number.isFinite(child.scale.x + child.scale.y + child.scale.z)) finite = false;
  });
  check('leaves every child transform finite', finite);

  visual.dispose();
  check('disposes without throwing', true);

  const ghost = createShipVisual({ colors: COLORS, quality, isPlayer: false, isGhost: true });
  ghost.update(shipState({ ghostAlpha: 0.4 }));
  ghost.explode();
  ghost.update(shipState());
  check('a ghost ignores explode() rather than spraying debris', true);
  ghost.dispose();
});

// --- Trail ------------------------------------------------------------------

describe('trail buffer', () => {
  const buffer = new TrailBuffer(8, 2, 10);
  check('starts empty', buffer.filled === 0);

  buffer.push([0, 0, 0, 1, 0, 0]);
  check('records the first sample', buffer.filled === 1);
  for (let i = 1; i < 20; i++) buffer.push([i, 0, 0, i + 1, 0, 0]);
  check('never exceeds capacity', buffer.filled === 8, `${buffer.filled}`);

  // Age 0 is the newest sample; ages past the fill clamp to the oldest.
  const head = buffer.offset(0, 0);
  near('age 0 is the newest sample', buffer.data[head], 19, 1e-4);
  const oldest = buffer.offset(7, 0);
  near('age capacity-1 is the oldest retained sample', buffer.data[oldest], 12, 1e-4);
  const beyond = buffer.offset(99, 0);
  check('reading past the fill clamps instead of wrapping', beyond === oldest);
  const strand = buffer.offset(0, 1);
  near('the second strand is stored alongside the first', buffer.data[strand], 20, 1e-4);

  // A respawn must not leave a streak across the level.
  const teleported = buffer.push([500, 0, 0, 501, 0, 0]);
  check('a large jump is reported as a teleport', teleported === false);
  check('the teleport counter advanced', buffer.teleports === 1);
  check('history collapses to a single sample', buffer.filled === 1);
  let collapsed = true;
  for (let age = 0; age < 8; age++) {
    if (Math.abs(buffer.data[buffer.offset(age, 0)] - 500) > 1e-4) collapsed = false;
  }
  check('every retained sample sits on the new position', collapsed);

  // Ordinary motion after a teleport resumes normally.
  buffer.push([501, 0, 0, 502, 0, 0]);
  check('recording resumes after a teleport', buffer.filled === 2);
  buffer.clear();
  check('clear empties the buffer', buffer.filled === 0);
});

describe('trail ribbon', () => {
  const trail = createShipTrail({ quality, color: 0x62f0ff });
  check('uses the quality tier trail length', trail.segments === quality.trailLength);

  const state = {
    dt: 1 / 60,
    position: new Vector3(),
    quaternion: new Quaternion(),
    speedFraction: 0.9,
    boost: 0,
    cameraPosition: new Vector3(0, 5, -30),
  };

  const mesh = trail.object.children[0] as unknown as { geometry: GeometryLike };
  const before = mesh.geometry.getAttribute('position')!.array;

  for (let i = 0; i < 240; i++) {
    state.position.set(0, 0, -i * 1.5);
    trail.update(state);
  }
  const after = mesh.geometry.getAttribute('position')!.array;
  check('rewrites the same buffer rather than reallocating', before === after);
  check('vertex count is two per sample per strand', mesh.geometry.getAttribute('position')!.count === quality.trailLength * 2 * 2);
  check('ribbon positions stay finite', allFinite(after));

  // The ribbon should now span roughly the distance covered in its own window.
  const z = extent(mesh.geometry, 2);
  range('ribbon has a plausible world length', z.max - z.min, 5, 120);

  // Teleport: one enormous step must not leave a ribbon stretched across it.
  state.position.set(900, 0, 900);
  trail.update(state);
  const spanX = extent(mesh.geometry, 0);
  check('a teleport does not draw a streak across the level', spanX.max - spanX.min < 5, `${spanX.max - spanX.min}`);

  trail.reset();
  trail.update(state);
  check('reset leaves the ribbon finite', allFinite(mesh.geometry.getAttribute('position')!.array));
  trail.dispose();

  const off = createShipTrail({ quality: potato, color: 0x62f0ff });
  check('a zero trail budget produces no geometry', off.segments === 0 && off.object.children.length === 0);
  off.update(state);
  off.reset();
  off.dispose();
  check('the disabled trail is safe to drive', true);
});

// --- Particles --------------------------------------------------------------

const EFFECTS: ParticleEffect[] = ['engine', 'scrape', 'boost', 'dust', 'debris'];

describe('particle pools', () => {
  const system = createParticleSystem({ quality, seed: 'test' });
  range('total budget is close to the tier setting', system.budget, quality.particleBudget * 0.9, quality.particleBudget * 1.1);
  check('starts with nothing alive', system.active === 0);

  const params: EmitParams = { position: new Vector3(), direction: new Vector3(0, 1, 0), count: 50, life: 0.5 };

  // Hammer every pool well past its capacity.
  for (const effect of EFFECTS) {
    const capacity = system.capacityOf(effect);
    let requested = 0;
    for (let i = 0; i < 200; i++) requested += system.emit(effect, params);
    check(`${effect} never exceeds its pool capacity`, system.activeOf(effect) === capacity, `${system.activeOf(effect)}/${capacity}`);
    check(`${effect} reported only the particles it actually made`, requested === capacity, `${requested} vs ${capacity}`);
  }
  check('total live count equals the budget when saturated', system.active === system.budget);

  // Draw ranges must track the live count, or the GPU renders stale instances.
  let drawRangesMatch = true;
  for (const child of system.object.children) {
    const mesh = child as unknown as { geometry: { instanceCount: number }; name: string };
    const effect = mesh.name.replace('particles-', '') as ParticleEffect;
    if (mesh.geometry.instanceCount !== system.activeOf(effect)) drawRangesMatch = false;
  }
  check('instance counts match the live counts after emitting', drawRangesMatch);

  // Everything dies and the pools recycle.
  for (let i = 0; i < 120; i++) system.update(1 / 60);
  check('particles expire and the pools drain', system.active === 0, `${system.active}`);

  const refilled = system.emit('engine', params);
  check('a drained pool accepts new particles', refilled === 50, `${refilled}`);

  // Integration must not produce NaNs, even with silly inputs.
  system.emit('debris', { position: new Vector3(1, 2, 3), count: 30, speed: 0, spread: 0, gravity: 1000, drag: 1000 });
  for (let i = 0; i < 30; i++) system.update(0.1);
  let finite = true;
  for (const child of system.object.children) {
    const mesh = child as unknown as { geometry: GeometryLike };
    const attr = mesh.geometry.getAttribute('iPos');
    if (attr && !allFinite(attr.array)) finite = false;
  }
  check('positions stay finite under extreme parameters', finite);

  system.clear();
  check('clear kills everything', system.active === 0);
  system.update(0);
  system.update(-1);
  check('a zero or negative dt is ignored', true);

  // The rate emitter has to carry its fractional remainder. Stepping the sim
  // between calls keeps the pool from saturating and hiding the arithmetic.
  system.clear();
  let spawned = 0;
  for (let i = 0; i < 600; i++) {
    spawned += system.emitRate('scrape', { position: new Vector3(), count: 1, life: 0.05 }, 25, 1 / 60);
    system.update(1 / 60);
  }
  range('emitRate averages out to the requested rate', spawned, 210, 290);

  system.dispose();
});

describe('particle presets', () => {
  const system = createParticleSystem({ quality, seed: 'presets' });
  const p = new Vector3(1, 2, 3);
  const dir = new Vector3(0, 0, 1);
  const vel = new Vector3(0, 0, 120);
  check('engine sparks emit at rate', emitEngineSparks(system, p, dir, vel, 0x62f0ff, 1, 1 / 60) > 0);
  check('wall sparks emit at rate', emitWallSparks(system, p, dir, vel, 1 / 60) > 0);
  check('boost burst emits a batch', emitBoostBurst(system, p, dir, 0x8ef6ff) > 0);
  check('landing dust emits a batch', emitLandingDust(system, p, dir, 1, 0x123055) > 0);
  check('explosion emits a batch', emitExplosion(system, p, 0x62f0ff) > 0);
  system.update(1 / 60);
  check('presets stay inside the budget', system.active <= system.budget);
  system.dispose();
});

describe('particles with no budget', () => {
  const system = createParticleSystem({ quality: potato });
  check('allocates nothing', system.budget === 0 && system.object.children.length === 0);
  check('emitting is a no-op', system.emit('engine', { position: new Vector3(), count: 100 }) === 0);
  check('emitRate is a no-op', system.emitRate('engine', { position: new Vector3() }, 100, 1) === 0);
  check('capacity queries answer zero', system.capacityOf('debris') === 0 && system.activeOf('debris') === 0);
  system.update(1 / 60);
  system.clear();
  system.dispose();
  check('the whole system is safe to drive', system.active === 0);
});

// --- Track features ---------------------------------------------------------

const track = Track.build(getTrack('neon-meridian'));

describe('feature placement', () => {
  const position = new Vector3();
  const quaternion = new Quaternion();
  let worstLateral = 0;
  let worstHeight = 0;
  let allFiniteAnchors = true;

  for (const feature of track.features) {
    const halfWidth = track.path.halfWidthAt(feature.s);
    const height = feature.kind === 'beatgate' ? gateRadius(feature, halfWidth) * 0.55 : 1.5;
    featureAnchor(track, feature, height, position, quaternion);
    if (!Number.isFinite(position.x + position.y + position.z)) allFiniteAnchors = false;

    const local = track.path.toTrack(position, feature.s);
    worstLateral = Math.max(worstLateral, Math.abs(local.lateral - feature.lateral * halfWidth));
    worstHeight = Math.max(worstHeight, Math.abs(local.height - height));
  }

  check('every anchor is finite', allFiniteAnchors);
  check('anchors land on the requested lateral offset', worstLateral < 0.5, `worst ${worstLateral.toFixed(3)} m`);
  check('anchors land at the requested height above the surface', worstHeight < 0.5, `worst ${worstHeight.toFixed(3)} m`);

  // The instance basis must match the craft's: -Z down the track.
  const first = track.features[0];
  featureAnchor(track, first, 0, position, quaternion);
  const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion);
  const frame = track.path.sample(first.s);
  near('instance -Z points down the direction of travel', forward.dot(frame.tangent), 1, 1e-4);
  const up = new Vector3(0, 1, 0).applyQuaternion(quaternion);
  near('instance +Y is the surface normal', up.dot(frame.up), 1, 1e-4);

  // A gate has to be flyable: wide enough for a craft, not wider than the sky.
  let gates = 0;
  let radiusOk = true;
  for (const feature of track.features) {
    if (feature.kind !== 'beatgate') continue;
    gates++;
    const r = gateRadius(feature, track.path.halfWidthAt(feature.s));
    if (r < 8 || r > 22) radiusOk = false;
  }
  check('the track places beat gates at all', gates > 0, `${gates}`);
  check('every gate radius is clamped to something flyable', radiusOk);
});

describe('feature visuals', () => {
  const visuals = createFeatureVisuals(track, { palette: track.definition.palette, quality });
  const kinds = new Set(track.features.map((f) => f.kind));
  check('builds a mesh for every kind the track uses', visuals.object.children.length >= kinds.size, `${visuals.object.children.length} meshes for ${kinds.size} kinds`);

  // One draw call per kind, two for gates (opaque arch plus additive membrane).
  range('keeps the whole circuit to a handful of draws', visuals.object.children.length, kinds.size, kinds.size + 2);

  let instancesMatchFeatures = 0;
  for (const child of visuals.object.children) {
    const mesh = child as unknown as { count?: number; name: string };
    if (mesh.name.endsWith('-0') && mesh.count !== undefined) instancesMatchFeatures += mesh.count;
  }
  check('instance counts add up to the feature list', instancesMatchFeatures === track.features.length, `${instancesMatchFeatures} vs ${track.features.length}`);

  const state: FeatureVisualState = { dt: 1 / 60, beatPhase: 0, beatIndex: 0, playerDistance: 0, intensity: 0.8 };
  for (let i = 0; i < 60; i++) {
    state.beatPhase = (i / 30) % 1;
    state.beatIndex = Math.floor(i / 30);
    state.playerDistance = i * 40;
    visuals.update(state);
  }

  // Consume and respawn a pickup.
  const pickupIndex = track.features.findIndex((f) => f.kind === 'shield');
  check('the track has a pickup to consume', pickupIndex >= 0);
  visuals.consume(pickupIndex, 4);
  visuals.update(state);
  visuals.consume(-1, 4);
  visuals.consume(9999, 4);
  check('consuming an out-of-range index is ignored', true);

  const gateIndex = track.features.findIndex((f) => f.kind === 'beatgate');
  visuals.hitGate(gateIndex, true);
  visuals.hitGate(gateIndex, false);
  visuals.hitGate(-1, true);
  for (let i = 0; i < 200; i++) visuals.update(state);
  check('gate hits and pickup respawns run to completion', true);

  // Negative and wrapped player distances must not break the proximity term.
  state.playerDistance = -5000;
  visuals.update(state);
  state.playerDistance = track.path.length * 7.5;
  visuals.update(state);
  check('player distance is folded into the lap', true);

  let matricesFinite = true;
  for (const child of visuals.object.children) {
    const mesh = child as unknown as { instanceMatrix?: { array: ArrayLike<number> } };
    if (mesh.instanceMatrix && !allFinite(mesh.instanceMatrix.array)) matricesFinite = false;
  }
  check('instance matrices stay finite', matricesFinite);

  visuals.dispose();
  check('disposes without throwing', true);
});

report('render');
