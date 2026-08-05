/**
 * Planets, moons, gas giants, ring systems, suns and derelict megastructures.
 *
 * Every surface is shaded in TSL from a hash-based value noise written here, so
 * there is not a single texture fetch in this file. Lighting is done by hand
 * (`MeshBasicNodeMaterial` + explicit lambert/rim terms) rather than through the
 * scene's light list: celestial bodies want a hard terminator, a specific
 * atmospheric limb and no fog, none of which the standard PBR path gives for
 * free, and doing it manually also decouples the sky from whatever lighting rig
 * the track ends up using.
 *
 * Everything lives inside a group that rides the camera and is rescaled to the
 * camera's far plane each frame, so the bodies never clip and never parallax.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  floor,
  fract,
  mix,
  modelWorldMatrix,
  normalWorld,
  positionGeometry,
  positionLocal,
  positionWorld,
  saturate,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { Rng } from '../../core/rng';
import type { QualitySettings } from '../../core/quality';
import type { EnvironmentArchetype, TrackPalette } from '../../track/types';
import { hexToLinear, mixRGB, saturateRGB, scaleRGB, toLuminance, type RGB } from './sky';

/** TSL nodes are untyped in this project (three ships no .d.ts). */
type N = any;

// ---------------------------------------------------------------------------
// TSL noise
// ---------------------------------------------------------------------------

/**
 * Dave Hoskins' sin-free hash. Avoids the precision cliff that `sin(dot(p,k))`
 * hashes fall off on mobile GPUs, and compiles identically to WGSL and GLSL.
 */
const hash13 = /*@__PURE__*/ Fn(([p]: N[]): N => {
  const q: N = fract(p.mul(0.1031)).toVar();
  q.addAssign(q.dot(q.zyx.add(31.32)));
  return fract(q.x.add(q.y).mul(q.z));
});

/** Trilinear value noise in [0, 1]. */
const vnoise = /*@__PURE__*/ Fn(([p]: N[]): N => {
  const i: N = floor(p).toVar();
  const f: N = fract(p).toVar();
  const u: N = f.mul(f).mul(f.mul(-2).add(3)).toVar();

  const n000 = hash13(i);
  const n100 = hash13(i.add(vec3(1, 0, 0)));
  const n010 = hash13(i.add(vec3(0, 1, 0)));
  const n110 = hash13(i.add(vec3(1, 1, 0)));
  const n001 = hash13(i.add(vec3(0, 0, 1)));
  const n101 = hash13(i.add(vec3(1, 0, 1)));
  const n011 = hash13(i.add(vec3(0, 1, 1)));
  const n111 = hash13(i.add(vec3(1, 1, 1)));

  const x00 = mix(n000, n100, u.x);
  const x10 = mix(n010, n110, u.x);
  const x01 = mix(n001, n101, u.x);
  const x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
});

/** fBm in roughly [-1, 1]. Unrolled at graph-build time. */
function fbm(p: N, octaves: number, gain = 0.5, lacunarity = 2.03): N {
  let sum: N = float(0);
  let amp = 1;
  let norm = 0;
  let q: N = p;
  for (let i = 0; i < octaves; i++) {
    sum = sum.add(vnoise(q).sub(0.5).mul(amp));
    norm += amp;
    amp *= gain;
    q = q.mul(lacunarity).add(vec3(19.7 + i, 7.3 - i, 31.1 + i * 2));
  }
  return sum.mul(2 / norm);
}

/** Sharp-crested ridge noise in [0, 1] — craters, ice cracks, ring filaments. */
function ridged(p: N, octaves: number): N {
  let sum: N = float(0);
  let amp = 1;
  let norm = 0;
  let q: N = p;
  for (let i = 0; i < octaves; i++) {
    const n = float(1).sub(vnoise(q).sub(0.5).abs().mul(2));
    sum = sum.add(n.mul(n).mul(amp));
    norm += amp;
    amp *= 0.5;
    q = q.mul(2.11).add(vec3(5.2 - i, 23.9 + i, 11.4 + i));
  }
  return sum.div(norm);
}

/** 2D cell hash, for hull panelling. */
const hash12 = /*@__PURE__*/ Fn(([p]: N[]): N => {
  const q: N = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  q.addAssign(q.dot(q.yzx.add(33.33)));
  return fract(q.x.add(q.y).mul(q.z));
});

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface CelestialOptions {
  archetype: EnvironmentArchetype;
  palette: TrackPalette;
  seed: string;
  quality: QualitySettings;
  /** Unit vector toward the dominant light, shared with the sky recipe. */
  sunDirection: Vector3;
  /** Radius of the sky shell in the group's local units. */
  radius: number;
}

export interface Celestial {
  object: Group;
  update(dt: number): void;
  dispose(): void;
}

interface Spinner {
  mesh: Mesh;
  rate: number;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const tmpQuat = new Quaternion();
const tmpMat = new Matrix4();
const tmpEuler = new Euler();
const UP = new Vector3(0, 1, 0);

function rgbNode(c: RGB): N {
  return vec3(c[0], c[1], c[2]);
}

/**
 * Camera-facing quad, written out rather than using three's `billboarding()`
 * helper: that one mutates matrix columns of a non-`Var` expression, which is
 * fragile enough that a sky full of billboards is not the place to rely on it.
 * Uses the object's world scale for size, so `mesh.scale` still means what it
 * looks like it means.
 */
function billboardVertex(): N {
  const world: N = modelWorldMatrix;
  const centreView: N = cameraViewMatrix.mul(world).mul(vec4(0, 0, 0, 1));
  const sx: N = world[0].xyz.length();
  const sy: N = world[1].xyz.length();
  const local: N = positionGeometry;
  const offset: N = vec4(local.x.mul(sx), local.y.mul(sy), 0, 0);
  return cameraProjectionMatrix.mul(centreView.add(offset));
}

/** `normalize()` with a guard: a zero vector otherwise yields NaN, and one NaN
 *  pixel poisons the entire bloom mip chain and whites out the frame. */
function safeNormalize(v: N): N {
  return v.div(v.length().max(1e-5));
}

/** Places an object on the sky shell in a given direction. */
function place(obj: { position: Vector3 }, dir: Vector3, distance: number): void {
  obj.position.copy(dir).multiplyScalar(distance);
}

/** A direction at least `minAngle` radians away from `avoid`. */
function directionAwayFrom(rng: Rng, avoid: Vector3, minCos: number): Vector3 {
  const v = new Vector3();
  for (let i = 0; i < 24; i++) {
    const z = rng.range(-0.85, 0.85);
    const a = rng.range(0, Math.PI * 2);
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    v.set(Math.cos(a) * s, z, Math.sin(a) * s);
    if (v.dot(avoid) < minCos) return v;
  }
  return v.copy(avoid).negate();
}

// --- sun ------------------------------------------------------------------

interface SunConfig {
  color: RGB;
  /** Angular size of the hard disc, as a fraction of the billboard. */
  disc: number;
  /** Brightness of the disc core. Feeds bloom. */
  intensity: number;
  glow: number;
  spikes: number;
  size: number;
}

function buildSun(config: SunConfig): { mesh: Mesh; geometry: PlaneGeometry; material: N } {
  const geometry = new PlaneGeometry(1, 1);
  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.fog = false;
  material.vertexNode = billboardVertex();

  const p: N = uv().sub(0.5).mul(2);
  const d = p.length();
  const disc = float(1).sub(smoothstep(config.disc * 0.72, config.disc, d)).mul(config.intensity);
  // Two glow lobes; the wide one is what bloom picks up and smears.
  const inner = saturate(float(1).sub(d)).pow(6).mul(config.glow);
  const outer = saturate(float(1).sub(d)).pow(2.2).mul(config.glow * 0.08);

  const ax = p.x.abs();
  const ay = p.y.abs();
  const spikeH = saturate(float(1).sub(ay.mul(26))).pow(2).mul(saturate(float(1).sub(ax)).pow(2.2));
  const spikeV = saturate(float(1).sub(ax.mul(26))).pow(2).mul(saturate(float(1).sub(ay)).pow(2.2));
  // A slow breathing on the flare keeps a static sky from feeling like a matte.
  const breathe = sin(time.mul(0.37)).mul(0.12).add(1);
  const flare = spikeH.add(spikeV).mul(config.spikes).mul(breathe);

  const alpha = disc.add(inner).add(outer).add(flare);
  material.colorNode = vec4(rgbNode(config.color), alpha);

  const mesh = new Mesh(geometry, material);
  mesh.scale.setScalar(config.size);
  mesh.frustumCulled = false;
  mesh.renderOrder = -30;
  return { mesh, geometry, material };
}

// --- planets --------------------------------------------------------------

type SurfaceKind = 'rock' | 'gas' | 'ice' | 'crystal' | 'dead';

interface PlanetConfig {
  kind: SurfaceKind;
  radius: number;
  /** Colours, all linear. */
  low: RGB;
  high: RGB;
  accent: RGB;
  atmosphere: RGB;
  /** 0 = airless rock, 1 = thick shell. */
  air: number;
  sunColor: RGB;
  ambient: RGB;
  segments: number;
  noiseSeed: number;
  /** Extra self-illumination — city lights, lava, crystal glow. */
  emissive: number;
}

function surfaceAlbedo(config: PlanetConfig, sunDir: N): { albedo: N; glow: N } {
  const off = vec3(config.noiseSeed * 1.7, config.noiseSeed * 0.9, config.noiseSeed * 2.3);
  // Normalised local position: the sphere is built at unit radius and scaled by
  // the mesh transform, so this is stable regardless of the body's size.
  const n = positionLocal.normalize();
  const low = rgbNode(config.low);
  const high = rgbNode(config.high);
  const accent = rgbNode(config.accent);

  if (config.kind === 'gas') {
    // Latitude bands, warped by turbulence so they curl instead of striping.
    const turb = fbm(n.mul(2.6).add(off), 4).mul(0.11);
    const lat = n.y.add(turb).toVar();
    const coarse = sin(lat.mul(9.5)).mul(0.5).add(0.5);
    const fine = sin(lat.mul(27.0).add(turb.mul(6))).mul(0.5).add(0.5);
    const t = saturate(coarse.mul(0.72).add(fine.mul(0.28)));
    let albedo: N = mix(low, high, t);
    albedo = mix(albedo, accent, t.pow(4).mul(0.85));
    // Polar hoods, and a limb-darkened equator.
    albedo = mix(albedo, low.mul(0.55), smoothstep(0.62, 1.0, lat.abs()));

    // The great storm: an ellipse, squashed in latitude, with a ragged edge.
    const stormDir = vec3(0.55, -0.32, 0.77).normalize();
    const rel = n.sub(stormDir);
    const dist = vec3(rel.x, rel.y.mul(2.1), rel.z).length().add(fbm(n.mul(7).add(off), 3).mul(0.06));
    const storm = float(1).sub(smoothstep(0.12, 0.34, dist));
    albedo = mix(albedo, accent.mul(1.35), storm.mul(0.8));
    return { albedo, glow: float(0) };
  }

  if (config.kind === 'crystal') {
    const facets = ridged(n.mul(5.5).add(off), 4);
    const veins = ridged(n.mul(13).add(off.mul(1.7)), 3).pow(4);
    const iri = fbm(n.mul(3.1).add(off), 3).mul(0.5).add(0.5);
    let albedo: N = mix(low, high, facets);
    albedo = mix(albedo, accent, iri.pow(2));
    const glow = veins.mul(config.emissive);
    return { albedo, glow };
  }

  if (config.kind === 'ice') {
    const relief = fbm(n.mul(3.4).add(off), 5).mul(0.5).add(0.5);
    const cracks = float(1).sub(smoothstep(0, 0.055, fbm(n.mul(6.2).add(off), 4).abs()));
    let albedo: N = mix(low, high, relief.pow(0.7));
    albedo = mix(albedo, accent.mul(0.4), cracks.mul(0.7));
    return { albedo, glow: float(0) };
  }

  // rock / dead: continents plus crater fields.
  const relief = fbm(n.mul(2.4).add(off), 5).toVar();
  const land = smoothstep(-0.08, 0.16, relief);
  const craters = ridged(n.mul(9.5).add(off), 3).pow(3);
  const grain = fbm(n.mul(22).add(off), 3).mul(0.5).add(0.5);
  let albedo: N = mix(low, high, land);
  albedo = mix(albedo, accent, craters.mul(0.55));
  albedo = albedo.mul(grain.mul(0.35).add(0.8));

  // Night-side settlement glow clustered on the "land".
  const cities = smoothstep(0.55, 0.85, vnoise(n.mul(18).add(off))).mul(land);
  const night = saturate(sunDir.dot(normalWorld).negate().mul(2.2));
  const glow = cities.mul(night).mul(config.emissive);
  return { albedo, glow };
}

function buildPlanet(config: PlanetConfig, sunDirUniform: N): {
  group: Group;
  meshes: Mesh[];
  geometries: N[];
  materials: N[];
} {
  const geometry = new SphereGeometry(1, config.segments, Math.max(8, config.segments >> 1));
  const material = new MeshBasicNodeMaterial();
  material.fog = false;

  const { albedo, glow } = surfaceAlbedo(config, sunDirUniform);

  const nrm = normalWorld;
  const ndl = nrm.dot(sunDirUniform);
  // Hard-ish terminator with a hint of atmospheric wrap on the day side.
  const lambert = smoothstep(-0.06, 0.32, ndl);
  const sunColor = rgbNode(config.sunColor);
  const ambient = rgbNode(config.ambient);

  const view = cameraPosition.sub(positionWorld).normalize();
  const fres = saturate(float(1).sub(nrm.dot(view)));

  // The limb: an atmosphere is only visible where it is lit, and it is
  // brightest where you look through the most of it, i.e. at the edge.
  const limb = fres.pow(3.2).mul(smoothstep(-0.42, 0.35, ndl)).mul(config.air);
  const atmo = rgbNode(config.atmosphere);
  // Forward-scattered haze washes out the day side near the limb.
  const haze = fres.pow(1.6).mul(saturate(ndl)).mul(config.air * 0.35);

  const lit = albedo.mul(sunColor).mul(lambert);
  const fill = albedo.mul(ambient);
  const color = lit.add(fill).add(atmo.mul(limb.mul(1.6).add(haze))).add(rgbNode(config.accent).mul(glow));
  material.colorNode = vec4(color, 1);

  const mesh = new Mesh(geometry, material);
  mesh.scale.setScalar(config.radius);
  mesh.renderOrder = -20;
  mesh.frustumCulled = false;

  const group = new Group();
  group.add(mesh);

  const meshes: Mesh[] = [mesh];
  const geometries: N[] = [geometry];
  const materials: N[] = [material];

  // Outer atmospheric halo.
  //
  // Done as a billboard behind the planet rather than an inverted shell: the
  // planet writes depth first, so the quad survives only *outside* the disc and
  // the falloff can be authored directly in screen space. It also lets the halo
  // be a crescent — thick on the sunward limb, thin on the night side — which
  // is the single detail that stops a shaded sphere reading as a billiard ball.
  if (config.air > 0.02) {
    const haloGeo = new PlaneGeometry(1, 1);
    const haloMat = new MeshBasicNodeMaterial();
    haloMat.transparent = true;
    haloMat.blending = AdditiveBlending;
    haloMat.depthWrite = false;
    haloMat.fog = false;
    haloMat.vertexNode = billboardVertex();

    const HALO_SPAN = 1.34; // billboard half-width in planet radii
    const edge = 1 / HALO_SPAN;
    const q: N = uv().sub(0.5).mul(2);
    const qd: N = q.length();
    // Ramp from the planet's limb outward, plus a tight bright band right at
    // the limb where the line of sight passes through the most air.
    const outward = saturate(float(1).sub(smoothstep(edge, 1, qd)));
    const shellBand = saturate(float(1).sub(qd.sub(edge).abs().div(1 - edge).mul(3.4)));
    const profile = outward.pow(2.6).mul(0.75).add(shellBand.pow(2.2).mul(0.9));
    // Project the sun into screen space so the crescent tracks the terminator.
    const sunVec: N = sunDirUniform;
    const sunView: N = cameraViewMatrix.mul(vec4(sunVec.x, sunVec.y, sunVec.z, 0)).xy;
    const crescent = saturate(safeNormalize(q).dot(safeNormalize(sunView)).mul(0.78).add(0.30));
    haloMat.colorNode = vec4(
      atmo.mul(1.6),
      profile.mul(crescent).mul(config.air).mul(saturate(float(1).sub(smoothstep(0.97, 1, qd)))),
    );

    const halo = new Mesh(haloGeo, haloMat);
    halo.scale.setScalar(config.radius * HALO_SPAN * 2);
    halo.renderOrder = -17;
    halo.frustumCulled = false;
    group.add(halo);
    meshes.push(halo);
    geometries.push(haloGeo);
    materials.push(haloMat);
  }

  return { group, meshes, geometries, materials };
}

// --- ring system ----------------------------------------------------------

interface RingConfig {
  inner: number;
  outer: number;
  /** Radius of the body casting a shadow on the ring, in the same units. */
  occluderRadius: number;
  colorA: RGB;
  colorB: RGB;
  dust: RGB;
  opacity: number;
  segments: number;
  noiseSeed: number;
  sunColor: RGB;
}

function buildRings(config: RingConfig, sunLocal: N): { mesh: Mesh; geometry: N; material: N } {
  const geometry = new RingGeometry(config.inner, config.outer, config.segments, 24);
  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.side = DoubleSide;
  material.depthWrite = false;
  material.fog = false;

  const r = positionLocal.xy.length();
  const t = r.sub(config.inner).div(config.outer - config.inner).toVar();

  // Ring structure is banded in radius only — sampling a 3D field along a line
  // through it gives the irregular, non-repeating gap pattern real rings have.
  const seedOff = vec3(config.noiseSeed * 3.1, config.noiseSeed * 1.3, 0);
  const coarse = fbm(vec3(t.mul(7.5), 0, 0).add(seedOff), 4).mul(0.5).add(0.5);
  const fine = ridged(vec3(t.mul(46), 0.5, 0).add(seedOff), 3);
  const micro = vnoise(vec3(t.mul(190), 1.5, 0).add(seedOff));

  let density: N = saturate(coarse.mul(1.25).sub(0.18));
  density = density.mul(fine.mul(0.55).add(0.6));
  density = density.mul(micro.mul(0.3).add(0.85));
  // Hard divisions, Cassini-style.
  const gap1 = smoothstep(0.03, 0.07, t.sub(0.38).abs());
  const gap2 = smoothstep(0.015, 0.05, t.sub(0.66).abs());
  density = density.mul(gap1).mul(gap2);
  // Fade both edges so the disc has no visible geometric rim.
  density = density.mul(smoothstep(0, 0.09, t)).mul(float(1).sub(smoothstep(0.86, 1, t)));

  const tint = mix(rgbNode(config.colorA), rgbNode(config.colorB), coarse);
  const dusty = mix(tint, rgbNode(config.dust), fine.pow(2).mul(0.5));

  // Lighting: ice particles scatter forward, so the far side of the ring is
  // brighter than the near side. Cheap and instantly readable.
  const view = cameraPosition.sub(positionWorld).normalize();
  const forward = saturate(view.dot(sunLocal).negate()).pow(2).mul(0.6).add(0.55);

  // Planet shadow: the ring point is dark when it is behind the body and its
  // perpendicular distance from the sun axis is inside the body's radius.
  const along = positionLocal.dot(sunLocal);
  const perp = positionLocal.sub(sunLocal.mul(along)).length();
  const behind = saturate(along.negate().mul(0.05));
  const shadow = mix(
    float(1),
    smoothstep(config.occluderRadius * 0.88, config.occluderRadius * 1.25, perp),
    behind,
  );

  const lit = dusty.mul(rgbNode(config.sunColor)).mul(forward).mul(shadow.mul(0.9).add(0.1));
  material.colorNode = vec4(lit, density.mul(config.opacity));

  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = -15;
  mesh.frustumCulled = false;
  return { mesh, geometry, material };
}

// --- derelict megastructure ----------------------------------------------

interface HullConfig {
  radius: number;
  width: number;
  segments: number;
  hull: RGB;
  rust: RGB;
  window: RGB;
  sunColor: RGB;
  ambient: RGB;
  noiseSeed: number;
}

function hullMaterial(config: HullConfig, sunDirUniform: N, uScale: number, vScale: number): N {
  const material = new MeshBasicNodeMaterial();
  material.side = DoubleSide;
  material.fog = false;

  const cell = vec2(floor(uv().x.mul(uScale)), floor(uv().y.mul(vScale)));
  const rnd = hash12(cell.add(config.noiseSeed));
  const rnd2 = hash12(cell.add(config.noiseSeed + 37));

  // Panel seams: a dark grid, slightly irregular so it does not read as a
  // wireframe.
  const g = fract(vec2(uv().x.mul(uScale), uv().y.mul(vScale)));
  const seam = smoothstep(0.0, 0.045, g.x.min(g.y).min(float(1).sub(g.x)).min(float(1).sub(g.y)));

  const grime = fbm(positionLocal.mul(0.06).add(config.noiseSeed), 4).mul(0.5).add(0.5);
  const streak = fbm(vec3(positionLocal.x.mul(0.02), positionLocal.y.mul(0.4), positionLocal.z.mul(0.02)), 3)
    .mul(0.5)
    .add(0.5);

  let albedo: N = mix(rgbNode(config.hull), rgbNode(config.hull).mul(1.5), rnd);
  albedo = mix(albedo, rgbNode(config.rust), grime.mul(streak).mul(0.8));
  albedo = albedo.mul(seam.mul(0.55).add(0.45));

  const nrm = normalWorld;
  const ndl = nrm.dot(sunDirUniform);
  // A very hard terminator: no atmosphere out here to soften anything.
  const lambert = smoothstep(-0.02, 0.06, ndl);
  // Grazing light picks out the hull's curvature.
  const graze = saturate(ndl).pow(0.4).mul(0.35).add(0.65);

  // Surviving lights, in a handful of the panels, flickering out of sync.
  const alive = smoothstep(0.90, 0.97, rnd2);
  const flicker = sin(time.mul(rnd.mul(4).add(0.8)).add(rnd2.mul(30))).mul(0.22).add(0.78);
  const windows = alive.mul(flicker).mul(seam);

  const lit = albedo.mul(rgbNode(config.sunColor)).mul(lambert.mul(graze));
  const fill = albedo.mul(rgbNode(config.ambient));
  material.colorNode = vec4(lit.add(fill).add(rgbNode(config.window).mul(windows)), 1);
  return material;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function createCelestial(options: CelestialOptions): Celestial {
  const { archetype, palette, quality, radius } = options;
  const rng = new Rng(`${options.seed}:celestial`);

  const primary = hexToLinear(palette.primary);
  const secondary = hexToLinear(palette.secondary);
  const deep = hexToLinear(palette.deep);
  const glow = hexToLinear(palette.glow);
  const sun = hexToLinear(palette.sun);
  const haze = hexToLinear(palette.haze);

  const group = new Group();
  group.name = 'Celestial';

  const geometries: N[] = [];
  const materials: N[] = [];
  const spinners: Spinner[] = [];
  const instanced: InstancedMesh[] = [];

  const sunDir = options.sunDirection.clone().normalize();
  const sunUniform = uniform(sunDir.clone());

  const detail = quality.tier === 'potato' ? 0 : quality.tier === 'low' ? 1 : quality.tier === 'medium' ? 2 : 3;
  const sphereSegments = [24, 32, 48, 64][detail];
  const ringSegments = [96, 128, 192, 256][detail];

  const track = (g: N, m: N): void => {
    if (g) geometries.push(g);
    if (m) materials.push(m);
  };

  const addPlanet = (config: PlanetConfig, dir: Vector3, distance: number, spin: number): Group => {
    const built = buildPlanet(config, sunUniform);
    place(built.group, dir, distance);
    group.add(built.group);
    for (const g of built.geometries) geometries.push(g);
    for (const m of built.materials) materials.push(m);
    spinners.push({ mesh: built.meshes[0], rate: spin });
    // Tilt so bands and terminators are never axis-aligned with the horizon.
    built.group.rotation.set(rng.range(-0.5, 0.5), rng.range(0, Math.PI * 2), rng.range(-0.35, 0.35));
    return built.group;
  };

  const addSun = (config: SunConfig, dir: Vector3, distance: number): void => {
    const built = buildSun(config);
    place(built.mesh, dir, distance);
    group.add(built.mesh);
    track(built.geometry, built.material);
  };

  // -------------------------------------------------------------------------

  switch (archetype) {
    case 'nebula': {
      addSun(
        {
          color: toLuminance(sun, 1.6),
          disc: 0.1,
          intensity: 4.0,
          glow: 0.7,
          spikes: 0.5,
          size: radius * 0.13,
        },
        sunDir,
        radius * 0.9,
      );

      const dir = directionAwayFrom(rng, sunDir, 0.25);
      addPlanet(
        {
          kind: 'rock',
          radius: radius * 0.19,
          low: toLuminance(saturateRGB(deep, 1.2), 0.05),
          high: toLuminance(mixRGB(deep, haze, 0.6), 0.14),
          accent: toLuminance(secondary, 0.1),
          atmosphere: toLuminance(saturateRGB(mixRGB(primary, glow, 0.4), 1.25), 0.55),
          air: 1.0,
          sunColor: toLuminance(sun, 1.15),
          ambient: scaleRGB(mixRGB(deep, glow, 0.35), 0.1),
          segments: sphereSegments,
          noiseSeed: rng.range(0, 40),
          emissive: 0.55,
        },
        dir,
        radius * 0.62,
        0.006,
      );

      const moonDir = directionAwayFrom(rng, dir, 0.75);
      addPlanet(
        {
          kind: 'ice',
          radius: radius * 0.045,
          low: toLuminance(mixRGB(deep, haze, 0.5), 0.06),
          high: toLuminance(mixRGB(haze, [1, 1, 1], 0.5), 0.3),
          accent: toLuminance(primary, 0.08),
          atmosphere: toLuminance(primary, 0.3),
          air: 0.15,
          sunColor: toLuminance(sun, 1.1),
          ambient: scaleRGB(deep, 0.12),
          segments: Math.max(16, sphereSegments >> 1),
          noiseSeed: rng.range(0, 40),
          emissive: 0,
        },
        moonDir,
        radius * 0.7,
        0.011,
      );
      break;
    }

    case 'megastructure': {
      // A small, hard, colourless sun: the point is the shadow it throws.
      addSun(
        {
          color: toLuminance(mixRGB(sun, [1, 1, 1], 0.55), 2.2),
          disc: 0.075,
          intensity: 6.5,
          glow: 0.45,
          spikes: 0.75,
          size: radius * 0.095,
        },
        sunDir,
        radius * 0.92,
      );

      const hullDir = directionAwayFrom(rng, sunDir, 0.1);
      const hull: HullConfig = {
        radius: radius * 0.62,
        width: radius * 0.17,
        segments: ringSegments,
        hull: toLuminance(saturateRGB(mixRGB(deep, haze, 0.55), 0.35), 0.075),
        rust: toLuminance(saturateRGB(mixRGB(secondary, haze, 0.5), 0.55), 0.035),
        window: toLuminance(saturateRGB(primary, 1.1), 0.5),
        sunColor: toLuminance(sun, 1.5),
        ambient: scaleRGB(mixRGB(deep, primary, 0.2), 0.045),
        noiseSeed: rng.range(0, 60),
      };

      const ringRoot = new Group();
      place(ringRoot, hullDir, radius * 0.78);
      // Seen almost edge-on: a ring you look *through* reads as far bigger than
      // one you look at face-on.
      ringRoot.rotation.set(rng.range(1.15, 1.42), rng.range(0, Math.PI * 2), rng.range(-0.25, 0.25));
      group.add(ringRoot);

      // Three arcs with gaps between them — the structure is broken.
      let theta = rng.range(0, Math.PI * 2);
      for (let i = 0; i < 3; i++) {
        const span = rng.range(1.35, 1.85);
        const geo = new CylinderGeometry(
          hull.radius,
          hull.radius,
          hull.width,
          Math.max(24, Math.round(hull.segments * (span / (Math.PI * 2)))),
          1,
          true,
          theta,
          span,
        );
        const mat = hullMaterial(hull, sunUniform, 90, 5);
        const mesh = new Mesh(geo, mat);
        mesh.rotation.x = Math.PI / 2;
        mesh.renderOrder = -20;
        mesh.frustumCulled = false;
        ringRoot.add(mesh);
        track(geo, mat);
        theta += span + rng.range(0.18, 0.55);
      }

      // Inner rim and radial spokes.
      const spokeGeo = new BoxGeometry(1, 1, 1);
      const spokeMat = hullMaterial(hull, sunUniform, 6, 26);
      const spokeCount = Math.max(6, Math.round(14 * (detail + 1) * 0.5));
      const spokes = new InstancedMesh(spokeGeo, spokeMat, spokeCount);
      spokes.frustumCulled = false;
      spokes.renderOrder = -20;
      for (let i = 0; i < spokeCount; i++) {
        const a = (i / spokeCount) * Math.PI * 2 + rng.range(-0.04, 0.04);
        const len = hull.radius * rng.range(0.55, 1.0);
        const dirV = new Vector3(Math.cos(a), 0, Math.sin(a));
        tmpQuat.setFromUnitVectors(UP, dirV);
        tmpMat.compose(
          dirV.clone().multiplyScalar(hull.radius - len * 0.5),
          tmpQuat,
          new Vector3(hull.width * rng.range(0.06, 0.13), len, hull.width * rng.range(0.06, 0.13)),
        );
        spokes.setMatrixAt(i, tmpMat);
      }
      spokes.instanceMatrix.needsUpdate = true;
      ringRoot.add(spokes);
      instanced.push(spokes);
      track(spokeGeo, spokeMat);

      // A cold dead world behind it for scale.
      const backDir = directionAwayFrom(rng, hullDir, 0.4);
      addPlanet(
        {
          kind: 'dead',
          radius: radius * 0.24,
          low: toLuminance(saturateRGB(deep, 0.5), 0.012),
          high: toLuminance(saturateRGB(mixRGB(deep, haze, 0.5), 0.5), 0.05),
          accent: toLuminance(saturateRGB(haze, 0.4), 0.03),
          atmosphere: toLuminance(saturateRGB(mixRGB(primary, haze, 0.6), 0.8), 0.22),
          air: 0.35,
          sunColor: toLuminance(sun, 1.3),
          ambient: scaleRGB(deep, 0.03),
          segments: sphereSegments,
          noiseSeed: rng.range(0, 40),
          emissive: 0.25,
        },
        backDir,
        radius * 0.72,
        0.003,
      );
      break;
    }

    case 'prismatic': {
      addSun(
        {
          color: toLuminance(mixRGB(sun, glow, 0.45), 1.9),
          disc: 0.09,
          intensity: 4.4,
          glow: 0.8,
          spikes: 0.85,
          size: radius * 0.15,
        },
        sunDir,
        radius * 0.9,
      );

      const dir = directionAwayFrom(rng, sunDir, 0.15);
      const planet = addPlanet(
        {
          kind: 'crystal',
          radius: radius * 0.17,
          low: toLuminance(saturateRGB(secondary, 1.3), 0.05),
          high: toLuminance(saturateRGB(primary, 1.3), 0.16),
          accent: toLuminance(saturateRGB(glow, 1.2), 0.32),
          atmosphere: toLuminance(saturateRGB(mixRGB(primary, glow, 0.5), 1.4), 0.8),
          air: 1.15,
          sunColor: toLuminance(sun, 1.2),
          ambient: scaleRGB(mixRGB(secondary, glow, 0.5), 0.16),
          segments: sphereSegments,
          noiseSeed: rng.range(0, 40),
          emissive: 1.35,
        },
        dir,
        radius * 0.6,
        0.01,
      );

      // A thin, brilliant ring — the Rainbow Road halo.
      const ringTilt = new Group();
      ringTilt.rotation.set(Math.PI / 2 + rng.range(-0.5, 0.5), 0, rng.range(-0.6, 0.6));
      planet.add(ringTilt);
      const sunLocal = new Vector3();
      const built = buildRings(
        {
          inner: radius * 0.24,
          outer: radius * 0.42,
          occluderRadius: radius * 0.17,
          colorA: toLuminance(saturateRGB(primary, 1.35), 0.5),
          colorB: toLuminance(saturateRGB(glow, 1.3), 0.75),
          dust: toLuminance(saturateRGB(secondary, 1.2), 0.25),
          opacity: 0.85,
          segments: ringSegments,
          noiseSeed: rng.range(0, 40),
          sunColor: toLuminance(sun, 1.15),
        },
        uniform(sunLocal),
      );
      ringTilt.add(built.mesh);
      track(built.geometry, built.material);
      // Resolve the sun direction into the ring's own frame once, at build time.
      ringTilt.updateWorldMatrix(true, false);
      built.mesh.updateWorldMatrix(true, false);
      sunLocal.copy(sunDir).transformDirection(tmpMat.copy(built.mesh.matrixWorld).invert()).normalize();
      break;
    }

    case 'starfield': {
      addSun(
        {
          color: toLuminance(mixRGB(sun, [1, 1, 1], 0.35), 2.6),
          disc: 0.08,
          intensity: 7.5,
          glow: 0.85,
          spikes: 1.05,
          size: radius * 0.13,
        },
        sunDir,
        radius * 0.9,
      );

      const dir = directionAwayFrom(rng, sunDir, -0.1);
      addPlanet(
        {
          kind: 'dead',
          radius: radius * 0.075,
          low: toLuminance(saturateRGB(deep, 0.7), 0.02),
          high: toLuminance(saturateRGB(mixRGB(deep, haze, 0.55), 0.7), 0.09),
          accent: toLuminance(saturateRGB(secondary, 0.6), 0.05),
          atmosphere: toLuminance(saturateRGB(primary, 1.1), 0.35),
          air: 0.5,
          sunColor: toLuminance(sun, 1.25),
          ambient: scaleRGB(deep, 0.05),
          segments: sphereSegments,
          noiseSeed: rng.range(0, 40),
          emissive: 0.5,
        },
        dir,
        radius * 0.72,
        0.004,
      );
      break;
    }

    case 'ringworld': {
      addSun(
        {
          color: toLuminance(sun, 1.5),
          disc: 0.085,
          intensity: 4.0,
          glow: 0.6,
          spikes: 0.45,
          size: radius * 0.115,
        },
        sunDir,
        radius * 0.92,
      );

      // The hero: a banded giant, close enough to fill a third of the sky.
      const dir = directionAwayFrom(rng, sunDir, 0.05);
      const giant = addPlanet(
        {
          kind: 'gas',
          radius: radius * 0.3,
          low: toLuminance(saturateRGB(mixRGB(haze, deep, 0.45), 1.1), 0.055),
          high: toLuminance(saturateRGB(mixRGB(sun, haze, 0.45), 0.95), 0.22),
          accent: toLuminance(saturateRGB(secondary, 1.15), 0.16),
          atmosphere: toLuminance(saturateRGB(mixRGB(haze, glow, 0.4), 1.2), 0.5),
          air: 0.9,
          sunColor: toLuminance(sun, 1.2),
          ambient: scaleRGB(mixRGB(deep, haze, 0.5), 0.08),
          segments: sphereSegments,
          noiseSeed: rng.range(0, 40),
          emissive: 0,
        },
        dir,
        radius * 0.66,
        0.012,
      );

      const ringTilt = new Group();
      ringTilt.rotation.set(Math.PI / 2 + rng.range(-0.42, 0.42), 0, rng.range(-0.5, 0.5));
      giant.add(ringTilt);
      const sunLocal = new Vector3();
      const built = buildRings(
        {
          inner: radius * 0.4,
          outer: radius * 0.78,
          occluderRadius: radius * 0.3,
          colorA: toLuminance(saturateRGB(mixRGB(haze, [1, 1, 1], 0.4), 0.8), 0.32),
          colorB: toLuminance(saturateRGB(sun, 0.75), 0.5),
          dust: toLuminance(saturateRGB(secondary, 0.7), 0.12),
          opacity: 0.72,
          segments: ringSegments,
          noiseSeed: rng.range(0, 40),
          sunColor: toLuminance(sun, 1.1),
        },
        uniform(sunLocal),
      );
      ringTilt.add(built.mesh);
      track(built.geometry, built.material);
      ringTilt.updateWorldMatrix(true, false);
      built.mesh.updateWorldMatrix(true, false);
      sunLocal.copy(sunDir).transformDirection(tmpMat.copy(built.mesh.matrixWorld).invert()).normalize();

      // Two shepherd moons.
      for (let i = 0; i < 2; i++) {
        const moonDir = directionAwayFrom(rng, dir, 0.82);
        addPlanet(
          {
            kind: i === 0 ? 'rock' : 'ice',
            radius: radius * rng.range(0.028, 0.05),
            low: toLuminance(saturateRGB(deep, 0.8), 0.03),
            high: toLuminance(mixRGB(haze, [1, 1, 1], 0.4), 0.2),
            accent: toLuminance(secondary, 0.06),
            atmosphere: toLuminance(haze, 0.25),
            air: 0.12,
            sunColor: toLuminance(sun, 1.1),
            ambient: scaleRGB(mixRGB(deep, haze, 0.4), 0.1),
            segments: Math.max(16, sphereSegments >> 1),
            noiseSeed: rng.range(0, 40),
            emissive: 0,
          },
          moonDir,
          radius * rng.range(0.68, 0.82),
          0.02,
        );
      }
      break;
    }

    case 'void': {
      // Barely a sun at all: a cold pinprick with no flare.
      addSun(
        {
          color: toLuminance(mixRGB(sun, primary, 0.5), 0.7),
          disc: 0.09,
          intensity: 2.0,
          glow: 0.2,
          spikes: 0.12,
          size: radius * 0.06,
        },
        sunDir,
        radius * 0.93,
      );

      // Faint monoliths at the edge of visibility. Almost pure silhouette, with
      // one rim of palette light so the eye can find the edge.
      const slabGeo = new BoxGeometry(1, 1, 1);
      const slabMat = new MeshBasicNodeMaterial();
      slabMat.fog = false;
      {
        const view = cameraPosition.sub(positionWorld).normalize();
        const fres = saturate(float(1).sub(normalWorld.dot(view)));
        const ndl = normalWorld.dot(sunUniform);
        const body = rgbNode(toLuminance(saturateRGB(deep, 0.6), 0.0025));
        const rim = rgbNode(toLuminance(saturateRGB(primary, 1.2), 0.09)).mul(fres.pow(4.5));
        const sheen = rgbNode(toLuminance(mixRGB(primary, sun, 0.4), 0.05)).mul(smoothstep(0.75, 1.0, ndl));
        const stripes = smoothstep(0.42, 0.5, fract(positionLocal.y.mul(0.06))).mul(0.35);
        slabMat.colorNode = vec4(body.add(rim).add(sheen).add(rgbNode(toLuminance(primary, 0.02)).mul(stripes)), 1);
      }
      const slabCount = 5;
      const slabs = new InstancedMesh(slabGeo, slabMat, slabCount);
      slabs.frustumCulled = false;
      slabs.renderOrder = -20;
      for (let i = 0; i < slabCount; i++) {
        const dirV = directionAwayFrom(rng, sunDir, 0.4);
        const dist = radius * rng.range(0.6, 0.85);
        const h = radius * rng.range(0.28, 0.62);
        const w = h * rng.range(0.05, 0.12);
        tmpQuat.setFromEuler(tmpEuler.set(rng.range(-0.3, 0.3), rng.range(0, 6.28), rng.range(-0.3, 0.3)));
        tmpMat.compose(dirV.multiplyScalar(dist), tmpQuat, new Vector3(w, h, w * rng.range(0.6, 1.4)));
        slabs.setMatrixAt(i, tmpMat);
      }
      slabs.instanceMatrix.needsUpdate = true;
      group.add(slabs);
      instanced.push(slabs);
      track(slabGeo, slabMat);

      // One nearly-invisible dark world, betrayed only by the stars it eats.
      const dir = directionAwayFrom(rng, sunDir, 0.2);
      addPlanet(
        {
          kind: 'dead',
          radius: radius * 0.16,
          low: toLuminance(saturateRGB(deep, 0.5), 0.0018),
          high: toLuminance(saturateRGB(deep, 0.5), 0.006),
          accent: toLuminance(saturateRGB(primary, 0.5), 0.004),
          atmosphere: toLuminance(saturateRGB(primary, 1.1), 0.16),
          air: 0.55,
          sunColor: toLuminance(sun, 0.5),
          ambient: scaleRGB(deep, 0.01),
          segments: sphereSegments,
          noiseSeed: rng.range(0, 40),
          emissive: 0.12,
        },
        dir,
        radius * 0.68,
        0.002,
      );

      // A far-off debris swarm — motion in an otherwise dead sky.
      const motesGeo = new IcosahedronGeometry(1, 0);
      const motesMat = new MeshBasicNodeMaterial();
      motesMat.fog = false;
      motesMat.colorNode = vec4(
        rgbNode(toLuminance(saturateRGB(primary, 0.8), 0.02)).mul(
          saturate(normalWorld.dot(sunUniform)).mul(0.8).add(0.2),
        ),
        1,
      );
      const moteCount = 90;
      const motes = new InstancedMesh(motesGeo, motesMat, moteCount);
      motes.frustumCulled = false;
      motes.renderOrder = -20;
      for (let i = 0; i < moteCount; i++) {
        const dirV = directionAwayFrom(rng, sunDir, 0.9);
        const dist = radius * rng.range(0.45, 0.7);
        tmpQuat.setFromEuler(tmpEuler.set(rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)));
        const s = radius * rng.range(0.002, 0.008);
        tmpMat.compose(dirV.multiplyScalar(dist), tmpQuat, new Vector3(s, s * rng.range(0.5, 1.6), s));
        motes.setMatrixAt(i, tmpMat);
      }
      motes.instanceMatrix.needsUpdate = true;
      group.add(motes);
      instanced.push(motes);
      track(motesGeo, motesMat);
      break;
    }
  }

  return {
    object: group,
    update(dt: number): void {
      for (let i = 0; i < spinners.length; i++) {
        spinners[i].mesh.rotation.y += spinners[i].rate * dt;
      }
    },
    dispose(): void {
      for (const m of instanced) m.dispose();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      geometries.length = 0;
      materials.length = 0;
      instanced.length = 0;
      spinners.length = 0;
      group.clear();
    },
  };
}
