/**
 * Procedural deep-space skybox.
 *
 * The sky is a cube map whose every texel is shaded from the *direction vector*
 * of that texel through a seeded 3D noise field. Sampling a 3D field by
 * direction rather than painting six 2D images makes cube-face seams
 * structurally impossible: adjacent faces evaluate the same continuous function
 * on either side of a shared edge, so the values agree by construction.
 *
 * Everything in this module is pure JavaScript maths plus three's `DataTexture`
 * containers — no canvas, no `document`, no image decoding. That keeps it
 * importable (and testable) under Node, and it means the same code path feeds
 * the WebGPU and WebGL2 backends: a `CubeTexture` whose six images are
 * `DataTexture`s is uploaded via `_copyBufferToTexture` on WebGPU and
 * `texSubImage2D` on the WebGL fallback.
 */

import {
  ClampToEdgeWrapping,
  CubeReflectionMapping,
  CubeTexture,
  DataTexture,
  LinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three/webgpu';
import { Rng } from '../../core/rng';
import type { EnvironmentArchetype, TrackPalette } from '../../track/types';

/** Linear-light RGB triplet. Everything in this module works in linear space. */
export type RGB = [number, number, number];

// ---------------------------------------------------------------------------
// Colour helpers (linear working space, matching three's ColorManagement)
// ---------------------------------------------------------------------------

export function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

export function linearToSrgb(c: number): number {
  return c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 0.41666) - 0.055;
}

/** Palette entries are authored as sRGB hex; the renderer works in linear. */
export function hexToLinear(hex: number): RGB {
  return [
    srgbToLinear(((hex >> 16) & 255) / 255),
    srgbToLinear(((hex >> 8) & 255) / 255),
    srgbToLinear((hex & 255) / 255),
  ];
}

export function linearToHex(c: RGB): number {
  const r = Math.round(Math.min(1, Math.max(0, linearToSrgb(c[0]))) * 255);
  const g = Math.round(Math.min(1, Math.max(0, linearToSrgb(c[1]))) * 255);
  const b = Math.round(Math.min(1, Math.max(0, linearToSrgb(c[2]))) * 255);
  return (r << 16) | (g << 8) | b;
}

export function scaleRGB(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

export function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function addRGB(a: RGB, b: RGB): RGB {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function luminance(c: RGB): number {
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}

/** `amount` < 1 pulls toward grey, > 1 pushes away from it. */
export function saturateRGB(c: RGB, amount: number): RGB {
  const l = luminance(c);
  return [l + (c[0] - l) * amount, l + (c[1] - l) * amount, l + (c[2] - l) * amount];
}

/** Renormalises a colour to a target luminance, keeping its hue. */
export function toLuminance(c: RGB, target: number): RGB {
  const l = luminance(c);
  return l < 1e-5 ? [target, target, target] : scaleRGB(c, target / l);
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------------------
// Seeded 3D value noise
// ---------------------------------------------------------------------------

/**
 * Permutation-table value noise. Value rather than gradient noise because the
 * cost is dominated by the eight corner lookups either way, and value noise's
 * blobbier character is exactly right for gas clouds — Perlin's zero-crossings
 * at the lattice give nebulae an unwanted regular "quilt" feel.
 */
export class SpaceNoise {
  private readonly perm: Uint8Array;
  private readonly vals: Float32Array;

  constructor(seed: number | string) {
    const rng = new Rng(seed);
    const base = new Uint8Array(256);
    for (let i = 0; i < 256; i++) base[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(0, i);
      const t = base[i];
      base[i] = base[j];
      base[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = base[i & 255];
    this.vals = new Float32Array(256);
    for (let i = 0; i < 256; i++) this.vals[i] = rng.range(-1, 1);
  }

  /** Trilinear value noise with a quintic fade. Range roughly [-1, 1]. */
  value(x: number, y: number, z: number): number {
    const X = Math.floor(x);
    const Y = Math.floor(y);
    const Z = Math.floor(z);
    const fx = x - X;
    const fy = y - Y;
    const fz = z - Z;
    // Quintic fade — C2 continuous, so fBm sums stay free of lattice creases.
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);

    const p = this.perm;
    const vl = this.vals;
    const xi = X & 255;
    const yi = Y & 255;
    const zi = Z & 255;

    const a = p[xi];
    const b = p[xi + 1];
    const aa = p[a + yi];
    const ab = p[a + yi + 1];
    const ba = p[b + yi];
    const bb = p[b + yi + 1];

    const c000 = vl[p[aa + zi]];
    const c100 = vl[p[ba + zi]];
    const c010 = vl[p[ab + zi]];
    const c110 = vl[p[bb + zi]];
    const c001 = vl[p[aa + zi + 1]];
    const c101 = vl[p[ba + zi + 1]];
    const c011 = vl[p[ab + zi + 1]];
    const c111 = vl[p[bb + zi + 1]];

    const x00 = c000 + (c100 - c000) * u;
    const x10 = c010 + (c110 - c010) * u;
    const x01 = c001 + (c101 - c001) * u;
    const x11 = c011 + (c111 - c011) * u;
    const y0 = x00 + (x10 - x00) * v;
    const y1 = x01 + (x11 - x01) * v;
    return y0 + (y1 - y0) * w;
  }

  /**
   * Fractal sum. Octaves are cyclically permuted as well as scaled, which is a
   * free stand-in for a rotation matrix and stops the lattice axes of each
   * octave from lining up into visible grid artefacts.
   */
  fbm(x: number, y: number, z: number, octaves: number, lacunarity = 2.03, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let px = x;
    let py = y;
    let pz = z;
    for (let o = 0; o < octaves; o++) {
      sum += this.value(px, py, pz) * amp;
      norm += amp;
      amp *= gain;
      const nx = py * lacunarity + 31.416;
      const ny = pz * lacunarity - 17.235;
      const nz = px * lacunarity + 7.919;
      px = nx;
      py = ny;
      pz = nz;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /** Absolute-value noise, inverted — produces sharp filament ridges in [0, 1]. */
  ridged(x: number, y: number, z: number, octaves: number, lacunarity = 2.11, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let px = x;
    let py = y;
    let pz = z;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.value(px, py, pz));
      sum += n * n * amp;
      norm += amp;
      amp *= gain;
      const nx = py * lacunarity + 11.13;
      const ny = pz * lacunarity - 5.77;
      const nz = px * lacunarity + 23.31;
      px = nx;
      py = ny;
      pz = nz;
    }
    return norm > 0 ? sum / norm : 0;
  }
}

// ---------------------------------------------------------------------------
// Cube face geometry
// ---------------------------------------------------------------------------

/**
 * Basis vectors per cube face, in the OpenGL cube-map convention:
 * `dir = FX * (2s - 1) + FY * (2t - 1) + FZ`, with `t` measured downward from
 * the top of the face (which matches `CubeTexture.flipY === false`).
 */
const FACE_BASIS: readonly RGB[][] = [
  [[0, 0, -1], [0, -1, 0], [1, 0, 0]], // +X
  [[0, 0, 1], [0, -1, 0], [-1, 0, 0]], // -X
  [[1, 0, 0], [0, 0, 1], [0, 1, 0]], // +Y
  [[1, 0, 0], [0, 0, -1], [0, -1, 0]], // -Y
  [[1, 0, 0], [0, -1, 0], [0, 0, 1]], // +Z
  [[-1, 0, 0], [0, -1, 0], [0, 0, -1]], // -Z
];

/**
 * Unit direction for a point on a cube face. `s`/`t` are in [0, 1] across the
 * face. Exported because the seam guarantee is worth asserting in tests.
 */
export function directionForFace(face: number, s: number, t: number, out: RGB): RGB {
  const [fx, fy, fz] = FACE_BASIS[face];
  const a = s * 2 - 1;
  const b = t * 2 - 1;
  const x = fx[0] * a + fy[0] * b + fz[0];
  const y = fx[1] * a + fy[1] * b + fz[1];
  const z = fx[2] * a + fy[2] * b + fz[2];
  const inv = 1 / Math.sqrt(x * x + y * y + z * z);
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = z * inv;
  return out;
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export interface SkyRecipe {
  archetype: EnvironmentArchetype;
  seed: number;
  /** Deep-space floor colour. */
  base: RGB;
  /** Primary and secondary gas colours, blended by a large-scale tint field. */
  cloudA: RGB;
  cloudB: RGB;
  /** Hot core / emission colour, applied to the densest parts only. */
  core: RGB;
  /** Multiplicative tint of the dust lanes — near black, slightly warm. */
  dust: RGB;

  /** Unit vector pointing at the dominant light source. */
  sunDir: RGB;
  sunGlow: RGB;
  /** Higher = tighter sun disc glow. */
  glowFalloff: number;
  glowStrength: number;
  /** Broad hemisphere wash around the sun. */
  washStrength: number;

  /** Axis normal to the "galactic plane" the clouds concentrate along. */
  bandAxis: RGB;
  bandWidth: number;
  bandStrength: number;

  cloudScale: number;
  warpScale: number;
  warpAmount: number;
  octaves: number;
  threshold: number;
  contrast: number;
  density: number;
  coreBoost: number;
  filament: number;
  dustAmount: number;
  /** Iridescent hue sweep, 0 for everything but `prismatic`. */
  spectral: number;
  /** Aurora ribbon strength. */
  ribbons: number;
  exposure: number;
  /** Per-domain random offsets so two seeds never share a cloud. */
  offsets: number[];
}

function randomDirection(rng: Rng, minElevation: number, maxElevation: number): RGB {
  const az = rng.range(0, Math.PI * 2);
  const el = rng.range(minElevation, maxElevation);
  const ce = Math.cos(el);
  return [Math.cos(az) * ce, Math.sin(el), Math.sin(az) * ce];
}

function orthogonalAxis(dir: RGB, rng: Rng): RGB {
  // Any vector not parallel to `dir` works; pick the least-aligned world axis.
  const ax = Math.abs(dir[0]);
  const ay = Math.abs(dir[1]);
  const az = Math.abs(dir[2]);
  const helper: RGB = ax < ay && ax < az ? [1, 0, 0] : ay < az ? [0, 1, 0] : [0, 0, 1];
  let x = dir[1] * helper[2] - dir[2] * helper[1];
  let y = dir[2] * helper[0] - dir[0] * helper[2];
  let z = dir[0] * helper[1] - dir[1] * helper[0];
  // Tilt it a little so the band never sits exactly on a world plane.
  x += rng.range(-0.25, 0.25);
  y += rng.range(-0.25, 0.25);
  z += rng.range(-0.25, 0.25);
  const inv = 1 / Math.sqrt(x * x + y * y + z * z);
  return [x * inv, y * inv, z * inv];
}

/**
 * Turns an archetype plus the track's palette into a full set of sky
 * parameters. Pure and deterministic — the same seed always yields the same
 * sky, which is what makes ghost replays and shared seeds line up.
 */
export function buildSkyRecipe(
  archetype: EnvironmentArchetype,
  palette: TrackPalette,
  seed: string,
): SkyRecipe {
  const rng = new Rng(`${seed}:sky`);
  const primary = hexToLinear(palette.primary);
  const secondary = hexToLinear(palette.secondary);
  const deep = hexToLinear(palette.deep);
  const glow = hexToLinear(palette.glow);
  const sun = hexToLinear(palette.sun);
  const haze = hexToLinear(palette.haze);

  const offsets: number[] = [];
  for (let i = 0; i < 18; i++) offsets.push(rng.range(-400, 400));

  const sunDir = randomDirection(rng, 0.12, 0.75);
  const bandAxis = orthogonalAxis(sunDir, rng);

  // Shared defaults; each archetype then commits hard to its own look.
  const r: SkyRecipe = {
    archetype,
    seed: rng.int(1, 0x7fffffff),
    base: scaleRGB(deep, 0.18),
    cloudA: scaleRGB(deep, 1.2),
    cloudB: scaleRGB(secondary, 0.4),
    core: scaleRGB(glow, 0.9),
    dust: scaleRGB(deep, 0.08),
    sunDir,
    sunGlow: sun,
    glowFalloff: 260,
    glowStrength: 1.4,
    washStrength: 0.06,
    bandAxis,
    bandWidth: 0.55,
    bandStrength: 0.65,
    cloudScale: 2.1,
    warpScale: 0.9,
    warpAmount: 0.8,
    octaves: 6,
    threshold: 0.44,
    contrast: 2.1,
    density: 0.85,
    coreBoost: 1.6,
    filament: 0.55,
    dustAmount: 0.75,
    spectral: 0,
    ribbons: 0,
    exposure: 1,
    offsets,
  };

  switch (archetype) {
    case 'nebula':
      // Vast, layered, saturated. The one archetype allowed to fill the sky.
      r.base = scaleRGB(deep, 0.22);
      r.cloudA = toLuminance(saturateRGB(deep, 1.35), 0.075);
      r.cloudB = toLuminance(saturateRGB(secondary, 1.2), 0.055);
      r.core = toLuminance(glow, 0.24);
      r.dust = scaleRGB(mixRGB(deep, primary, 0.15), 0.05);
      r.cloudScale = 2.0;
      r.warpAmount = 1.05;
      r.octaves = 6;
      r.threshold = 0.4;
      r.contrast = 2.0;
      r.density = 1.0;
      r.coreBoost = 2.1;
      r.filament = 0.7;
      r.bandWidth = 0.62;
      r.bandStrength = 0.55;
      r.glowFalloff = 200;
      r.glowStrength = 1.6;
      r.washStrength = 0.1;
      r.exposure = 1.05;
      break;

    case 'megastructure':
      // Cold, dim, almost monochrome: the derelict ring has to be the subject,
      // and hard shadows only read against a low-key sky.
      r.base = toLuminance(saturateRGB(deep, 0.45), 0.006);
      r.cloudA = toLuminance(saturateRGB(haze, 0.5), 0.02);
      r.cloudB = toLuminance(saturateRGB(secondary, 0.35), 0.012);
      r.core = toLuminance(saturateRGB(sun, 0.6), 0.05);
      r.dust = [0.004, 0.005, 0.007];
      r.cloudScale = 1.35;
      r.warpScale = 0.6;
      r.warpAmount = 0.45;
      r.octaves = 5;
      r.threshold = 0.5;
      r.contrast = 1.7;
      r.density = 0.5;
      r.coreBoost = 1.1;
      r.filament = 0.3;
      r.bandWidth = 0.85;
      r.bandStrength = 0.35;
      r.dustAmount = 0.85;
      r.glowFalloff = 900;
      r.glowStrength = 2.6;
      r.washStrength = 0.05;
      r.exposure = 0.95;
      break;

    case 'prismatic':
      // Rainbow Road. Hue sweeps across the whole sphere and aurora ribbons cut
      // through it; the palette supplies the three anchors of the spectrum.
      r.base = toLuminance(saturateRGB(deep, 1.1), 0.012);
      r.cloudA = toLuminance(saturateRGB(primary, 1.3), 0.06);
      r.cloudB = toLuminance(saturateRGB(secondary, 1.3), 0.06);
      r.core = toLuminance(saturateRGB(glow, 1.15), 0.16);
      r.dust = scaleRGB(mixRGB(deep, secondary, 0.35), 0.06);
      r.cloudScale = 2.4;
      r.warpScale = 1.15;
      r.warpAmount = 1.25;
      r.octaves = 5;
      r.threshold = 0.42;
      r.contrast = 1.9;
      r.density = 0.8;
      r.coreBoost = 1.5;
      r.filament = 0.9;
      r.bandWidth = 0.75;
      r.bandStrength = 0.4;
      r.dustAmount = 0.5;
      r.spectral = 0.9;
      r.ribbons = 0.55;
      r.glowFalloff = 320;
      r.glowStrength = 1.2;
      r.washStrength = 0.05;
      r.exposure = 1.1;
      break;

    case 'starfield':
      // Almost nothing: black, one brilliant sun, a whisper of dust so the
      // Points field has something to sit in front of.
      r.base = toLuminance(deep, 0.0035);
      r.cloudA = toLuminance(saturateRGB(deep, 1.1), 0.012);
      r.cloudB = toLuminance(saturateRGB(secondary, 0.8), 0.008);
      r.core = toLuminance(glow, 0.05);
      r.dust = [0.0015, 0.0015, 0.002];
      r.cloudScale = 1.6;
      r.warpAmount = 0.55;
      r.octaves = 5;
      r.threshold = 0.55;
      r.contrast = 2.4;
      r.density = 0.35;
      r.coreBoost = 1.2;
      r.filament = 0.35;
      r.bandWidth = 0.3;
      r.bandStrength = 0.85;
      r.dustAmount = 0.6;
      r.glowFalloff = 1600;
      r.glowStrength = 3.4;
      r.washStrength = 0.02;
      r.exposure = 1;
      break;

    case 'ringworld':
      // Warm scattered haze — the sky here is the gas giant's neighbourhood,
      // not open space, so it glows softly from one side.
      r.base = toLuminance(mixRGB(deep, haze, 0.25), 0.01);
      r.cloudA = toLuminance(saturateRGB(haze, 0.95), 0.05);
      r.cloudB = toLuminance(saturateRGB(sun, 0.75), 0.032);
      r.core = toLuminance(glow, 0.12);
      r.dust = scaleRGB(mixRGB(deep, haze, 0.3), 0.05);
      r.cloudScale = 1.5;
      r.warpScale = 0.7;
      r.warpAmount = 0.75;
      r.octaves = 5;
      r.threshold = 0.46;
      r.contrast = 1.6;
      r.density = 0.62;
      r.coreBoost = 1.2;
      r.filament = 0.4;
      r.bandWidth = 0.95;
      r.bandStrength = 0.5;
      r.dustAmount = 0.45;
      r.glowFalloff = 120;
      r.glowStrength = 1.5;
      r.washStrength = 0.14;
      r.exposure = 1;
      break;

    case 'void':
      // Ominous emptiness. A few sparse filaments hint that something enormous
      // is out there, and the falloff away from the band is brutal.
      r.base = toLuminance(deep, 0.0022);
      r.cloudA = toLuminance(saturateRGB(deep, 1.25), 0.014);
      r.cloudB = toLuminance(saturateRGB(primary, 0.55), 0.007);
      r.core = toLuminance(saturateRGB(primary, 0.9), 0.03);
      r.dust = [0.001, 0.001, 0.0014];
      r.cloudScale = 1.15;
      r.warpScale = 0.5;
      r.warpAmount = 1.35;
      r.octaves = 5;
      r.threshold = 0.56;
      r.contrast = 3.2;
      r.density = 0.45;
      r.coreBoost = 1.0;
      r.filament = 1.15;
      r.bandWidth = 0.34;
      r.bandStrength = 0.92;
      r.dustAmount = 0.9;
      r.glowFalloff = 40;
      r.glowStrength = 0.16;
      r.washStrength = 0.02;
      r.exposure = 1;
      break;
  }

  return r;
}

// ---------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------

/** Three-stop cyclic gradient — the backbone of the prismatic sky. */
function spectrum(t: number, a: RGB, b: RGB, c: RGB, out: RGB): void {
  const x = t - Math.floor(t);
  const u = x * 3;
  const i = Math.floor(u);
  const f = u - i;
  const s = f * f * (3 - 2 * f);
  const from = i === 0 ? a : i === 1 ? b : c;
  const to = i === 0 ? b : i === 1 ? c : a;
  out[0] = from[0] + (to[0] - from[0]) * s;
  out[1] = from[1] + (to[1] - from[1]) * s;
  out[2] = from[2] + (to[2] - from[2]) * s;
}

/**
 * Evaluates the sky in a given direction. The whole visual identity of an
 * archetype lives in here plus its recipe.
 */
export class SkyField {
  readonly recipe: SkyRecipe;
  private readonly noise: SpaceNoise;
  private readonly tmpSpec: RGB = [0, 0, 0];

  constructor(recipe: SkyRecipe) {
    this.recipe = recipe;
    this.noise = new SpaceNoise(recipe.seed);
  }

  /**
   * @param detail 1 = full octave count (background), lower = softened
   *        (irradiance probe). Never changes the low-frequency structure, so
   *        the env map always agrees with the background it is derived from.
   */
  shade(dx: number, dy: number, dz: number, detail: number, out: RGB): void {
    const r = this.recipe;
    const n = this.noise;
    const o = r.offsets;
    const octaves = Math.max(2, Math.round(r.octaves * detail));

    // --- domain warp: what turns fBm mush into flowing gas ---
    const ws = r.warpScale;
    const wx = n.fbm(dx * ws + o[0], dy * ws + o[1], dz * ws + o[2], 2, 2.13, 0.55);
    const wy = n.fbm(dx * ws + o[3], dy * ws + o[4], dz * ws + o[5], 2, 2.13, 0.55);
    const wz = n.fbm(dx * ws + o[6], dy * ws + o[7], dz * ws + o[8], 2, 2.13, 0.55);

    const s = r.cloudScale;
    const px = dx * s + wx * r.warpAmount + o[9];
    const py = dy * s + wy * r.warpAmount + o[10];
    const pz = dz * s + wz * r.warpAmount + o[11];

    const f = n.fbm(px, py, pz, octaves, 2.07, 0.52);
    const cloud = clamp01((f * 0.5 + 0.5 - r.threshold) * r.contrast);

    // --- galactic band: concentrates gas along a plane instead of everywhere ---
    const bd = dx * r.bandAxis[0] + dy * r.bandAxis[1] + dz * r.bandAxis[2];
    const band = Math.exp(-(bd * bd) / (r.bandWidth * r.bandWidth));
    const bandMask = 1 - r.bandStrength + r.bandStrength * band;

    const density = cloud * bandMask * r.density;

    // --- filaments and dust lanes ---
    const ridgeOct = Math.max(2, octaves - 3);
    const rid = n.ridged(px * 2.1 + o[12], py * 2.1 + o[13], pz * 2.1 + o[14], ridgeOct);
    const dustN = clamp01(
      (n.fbm(px * 0.66 + o[15], py * 0.66 + o[16], pz * 0.66 + o[17], 2) * 0.5 + 0.5 - 0.46) * 3.2,
    );

    // --- two-tone gas ---
    const tint = clamp01(n.value(dx * 0.85 + o[2], dy * 0.85 + o[5], dz * 0.85 + o[8]) * 0.7 + 0.5);
    const ca0 = r.cloudA[0] + (r.cloudB[0] - r.cloudA[0]) * tint;
    const ca1 = r.cloudA[1] + (r.cloudB[1] - r.cloudA[1]) * tint;
    const ca2 = r.cloudA[2] + (r.cloudB[2] - r.cloudA[2]) * tint;

    let R = r.base[0];
    let G = r.base[1];
    let B = r.base[2];

    R += ca0 * density;
    G += ca1 * density;
    B += ca2 * density;

    // Emission cores: only the very densest gas lights up, which is what gives
    // a nebula its sense of scale.
    const core = density * density * density * r.coreBoost;
    R += r.core[0] * core;
    G += r.core[1] * core;
    B += r.core[2] * core;

    const fil = rid * rid * rid * density * r.filament;
    R += (r.core[0] * 0.65 + ca0 * 0.35) * fil;
    G += (r.core[1] * 0.65 + ca1 * 0.35) * fil;
    B += (r.core[2] * 0.65 + ca2 * 0.35) * fil;

    // --- iridescence (prismatic only) ---
    if (r.spectral > 0) {
      const t = dy * 0.42 + f * 0.55 + rid * 0.35 + wx * 0.3;
      spectrum(t, r.cloudA, r.cloudB, r.core, this.tmpSpec);
      const k = r.spectral * (0.14 + density * 1.35);
      R += this.tmpSpec[0] * k;
      G += this.tmpSpec[1] * k;
      B += this.tmpSpec[2] * k;

      if (r.ribbons > 0) {
        const phase = dy * 3.4 + wx * 2.2 + f * 1.7;
        const rb = Math.abs(Math.sin(phase * Math.PI));
        const ribbon = Math.pow(1 - rb, 14) * r.ribbons * (0.35 + bandMask * 0.65);
        spectrum(t + 0.33, r.cloudA, r.cloudB, r.core, this.tmpSpec);
        R += this.tmpSpec[0] * ribbon;
        G += this.tmpSpec[1] * ribbon;
        B += this.tmpSpec[2] * ribbon;
      }
    }

    // --- dust: multiplicative, so it eats light instead of adding grey ---
    const k = dustN * r.dustAmount;
    R = R * (1 - k) + r.dust[0] * k;
    G = G * (1 - k) + r.dust[1] * k;
    B = B * (1 - k) + r.dust[2] * k;

    // --- the sun: tight disc glow plus a broad hemisphere wash ---
    const sd = dx * r.sunDir[0] + dy * r.sunDir[1] + dz * r.sunDir[2];
    if (sd > 0) {
      const g = Math.pow(sd, r.glowFalloff) * r.glowStrength;
      R += r.sunGlow[0] * g;
      G += r.sunGlow[1] * g;
      B += r.sunGlow[2] * g;
    }
    const wash = Math.pow(sd * 0.5 + 0.5, 13) * r.washStrength * 1.5;
    R += r.sunGlow[0] * wash;
    G += r.sunGlow[1] * wash;
    B += r.sunGlow[2] * wash;

    // --- exposure and a soft shoulder so bright gas rolls off instead of clipping ---
    const e = r.exposure;
    out[0] = 1 - Math.exp(-R * e);
    out[1] = 1 - Math.exp(-G * e);
    out[2] = 1 - Math.exp(-B * e);
  }
}

// ---------------------------------------------------------------------------
// Texture generation
// ---------------------------------------------------------------------------

export interface GeneratedSky {
  background: CubeTexture;
  envMap: CubeTexture;
  /** Wall-clock cost of the whole generation, in milliseconds. */
  generationMs: number;
  /** Number of texels actually shaded (before upsampling). */
  shadedTexels: number;
  /** Mean linear colour over the whole sphere — a good ambient fill. */
  averageColor: RGB;
  /** Direction of, and colour at, the brightest part of the sky. */
  brightestDir: RGB;
  brightestColor: RGB;
  dispose(): void;
}

/**
 * Nebula structure is low-frequency, so past a point extra shaded texels buy no
 * visible detail — only main-thread stall. We shade at most this many texels
 * per face and bilinearly resample up to whatever the quality tier asked for,
 * which keeps `ultra` (768px faces = 3.5M texels) inside a few hundred ms.
 */
const MAX_SHADED_FACE = 224;
const ENV_FACE = 24;

/**
 * Linear -> sRGB byte, tabulated against `sqrt(linear)` so the table stays
 * dense where the eye is sensitive (the near-black end, which is most of a
 * space sky). Replaces ~10M `Math.pow` calls per ultra-tier skybox.
 */
const ENCODE_BITS = 1024;
const ENCODE_LUT = (() => {
  const lut = new Float32Array(ENCODE_BITS + 2);
  for (let i = 0; i <= ENCODE_BITS + 1; i++) {
    const t = i / ENCODE_BITS;
    lut[i] = linearToSrgb(Math.min(1, t * t)) * 255;
  }
  return lut;
})();

function encodeByte(v: number, bias: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  const q = Math.sqrt(v) * ENCODE_BITS;
  const i = q | 0;
  const f = q - i;
  const s = ENCODE_LUT[i] + (ENCODE_LUT[i + 1] - ENCODE_LUT[i]) * f + bias;
  return s <= 0 ? 0 : s >= 255 ? 255 : (s + 0.5) | 0;
}

/**
 * Ordered 8x8 Bayer dither in byte units. Space gradients are so shallow that
 * straight rounding to 8 bits produces visible contour rings; a sub-LSB offset
 * pattern trades them for noise the eye reads as film grain.
 */
const BAYER = (() => {
  const m = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
    28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47,
    7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
  ];
  const out = new Float32Array(64);
  for (let i = 0; i < 64; i++) out[i] = (m[i] / 64 - 0.5) * 1.05;
  return out;
})();

function makeFaceTexture(data: Uint8Array, size: number): DataTexture {
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

function makeCube(images: DataTexture[]): CubeTexture {
  const cube = new CubeTexture(images);
  cube.mapping = CubeReflectionMapping;
  cube.format = RGBAFormat;
  cube.type = UnsignedByteType;
  cube.colorSpace = SRGBColorSpace;
  cube.minFilter = LinearFilter;
  cube.magFilter = LinearFilter;
  cube.wrapS = ClampToEdgeWrapping;
  cube.wrapT = ClampToEdgeWrapping;
  // No mipmaps: the background is always magnified on screen, and skipping them
  // avoids the backends' mip-generation path for data-backed cube textures.
  cube.generateMipmaps = false;
  cube.needsUpdate = true;
  return cube;
}

export function generateSky(recipe: SkyRecipe, resolution: number): GeneratedSky {
  const started = now();
  const res = Math.max(32, Math.min(1024, Math.round(resolution)));
  // Shade at roughly half the delivered resolution: the resample is an order of
  // magnitude cheaper per texel than the noise, and the field has no detail up
  // there to lose.
  const grid = Math.max(32, Math.min(res, MAX_SHADED_FACE, Math.round(res / 2) || res));

  const field = new SkyField(recipe);
  const dir: RGB = [0, 0, 0];
  const rgb: RGB = [0, 0, 0];

  const bgImages: DataTexture[] = [];
  const envImages: DataTexture[] = [];

  const avg: RGB = [0, 0, 0];
  const brightestDir: RGB = [0, 1, 0];
  const brightestColor: RGB = [0, 0, 0];
  let brightest = -1;
  let samples = 0;

  const face = new Float32Array(grid * grid * 3);
  const colIndex = new Int32Array(res);
  const colNext = new Int32Array(res);
  const colFrac = new Float32Array(res);

  for (let f = 0; f < 6; f++) {
    // ---- shade the face at the (possibly reduced) working resolution ----
    for (let j = 0; j < grid; j++) {
      const t = (j + 0.5) / grid;
      for (let i = 0; i < grid; i++) {
        const s = (i + 0.5) / grid;
        directionForFace(f, s, t, dir);
        field.shade(dir[0], dir[1], dir[2], 1, rgb);
        const o = (j * grid + i) * 3;
        face[o] = rgb[0];
        face[o + 1] = rgb[1];
        face[o + 2] = rgb[2];

        // Cube faces oversample the corners relative to the sphere; weight the
        // statistics by solid angle so the ambient estimate is honest.
        const a = s * 2 - 1;
        const b = t * 2 - 1;
        const w = Math.pow(1 + a * a + b * b, -1.5);
        avg[0] += rgb[0] * w;
        avg[1] += rgb[1] * w;
        avg[2] += rgb[2] * w;
        samples += w;

        const lum = luminance(rgb);
        if (lum > brightest) {
          brightest = lum;
          brightestDir[0] = dir[0];
          brightestDir[1] = dir[1];
          brightestDir[2] = dir[2];
          brightestColor[0] = rgb[0];
          brightestColor[1] = rgb[1];
          brightestColor[2] = rgb[2];
        }
      }
    }

    // ---- resample up to the requested face size ----
    const data = new Uint8Array(res * res * 4);
    if (res === grid) {
      for (let y = 0, o = 0, i = 0; y < res; y++) {
        for (let x = 0; x < res; x++, o += 4, i += 3) {
          const d = BAYER[((y & 7) << 3) | ((x + f) & 7)];
          data[o] = encodeByte(face[i], d);
          data[o + 1] = encodeByte(face[i + 1], d);
          data[o + 2] = encodeByte(face[i + 2], d);
          data[o + 3] = 255;
        }
      }
    } else {
      // Column weights repeat for every row, so resolve them once.
      const scale = grid / res;
      for (let x = 0; x < res; x++) {
        const sx = Math.min(grid - 1, Math.max(0, (x + 0.5) * scale - 0.5));
        const x0 = Math.floor(sx);
        colIndex[x] = x0 * 3;
        colNext[x] = Math.min(grid - 1, x0 + 1) * 3;
        colFrac[x] = sx - x0;
      }
      for (let y = 0; y < res; y++) {
        const sy = Math.min(grid - 1, Math.max(0, (y + 0.5) * scale - 0.5));
        const y0 = Math.floor(sy);
        const fy = sy - y0;
        const row0 = y0 * grid * 3;
        const row1 = Math.min(grid - 1, y0 + 1) * grid * 3;
        const bayerRow = (y & 7) << 3;
        let o = y * res * 4;
        for (let x = 0; x < res; x++, o += 4) {
          const c0 = colIndex[x];
          const c1 = colNext[x];
          const fx = colFrac[x];
          const d = BAYER[bayerRow | ((x + f) & 7)];
          for (let c = 0; c < 3; c++) {
            const a = face[row0 + c0 + c] + (face[row0 + c1 + c] - face[row0 + c0 + c]) * fx;
            const b = face[row1 + c0 + c] + (face[row1 + c1 + c] - face[row1 + c0 + c]) * fx;
            data[o + c] = encodeByte(a + (b - a) * fy, d);
          }
          data[o + 3] = 255;
        }
      }
    }
    bgImages.push(makeFaceTexture(data, res));

    // ---- box-downsample the same field into the irradiance probe ----
    const env = new Uint8Array(ENV_FACE * ENV_FACE * 4);
    const block = grid / ENV_FACE;
    for (let y = 0; y < ENV_FACE; y++) {
      const gy0 = Math.floor(y * block);
      const gy1 = Math.max(gy0 + 1, Math.floor((y + 1) * block));
      for (let x = 0; x < ENV_FACE; x++) {
        const gx0 = Math.floor(x * block);
        const gx1 = Math.max(gx0 + 1, Math.floor((x + 1) * block));
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (let gy = gy0; gy < gy1 && gy < grid; gy++) {
          for (let gx = gx0; gx < gx1 && gx < grid; gx++) {
            const o = (gy * grid + gx) * 3;
            r += face[o];
            g += face[o + 1];
            b += face[o + 2];
            count++;
          }
        }
        const inv = count > 0 ? 1 / count : 0;
        const o = (y * ENV_FACE + x) * 4;
        env[o] = encodeByte(r * inv, 0);
        env[o + 1] = encodeByte(g * inv, 0);
        env[o + 2] = encodeByte(b * inv, 0);
        env[o + 3] = 255;
      }
    }
    envImages.push(makeFaceTexture(blurFace(env, ENV_FACE), ENV_FACE));
  }

  const inv = samples > 0 ? 1 / samples : 0;
  avg[0] *= inv;
  avg[1] *= inv;
  avg[2] *= inv;

  const background = makeCube(bgImages);
  const envMap = makeCube(envImages);

  return {
    background,
    envMap,
    generationMs: now() - started,
    shadedTexels: grid * grid * 6,
    averageColor: avg,
    brightestDir,
    brightestColor,
    dispose(): void {
      for (const img of bgImages) img.dispose();
      for (const img of envImages) img.dispose();
      background.dispose();
      envMap.dispose();
    },
  };
}

/** Separable 3-tap blur with edge clamping — enough to soften the env probe. */
function blurFace(src: Uint8Array, size: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const dst = new Uint8Array(src.length);
  for (let pass = 0; pass < 2; pass++) {
    const from = pass === 0 ? src : tmp;
    const to = pass === 0 ? tmp : dst;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4;
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let k = -1; k <= 1; k++) {
            const xx = pass === 0 ? Math.min(size - 1, Math.max(0, x + k)) : x;
            const yy = pass === 0 ? y : Math.min(size - 1, Math.max(0, y + k));
            sum += from[(yy * size + xx) * 4 + c];
          }
          to[o + c] = (sum / 3) | 0;
        }
        to[o + 3] = 255;
      }
    }
  }
  return dst;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
