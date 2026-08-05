/**
 * Deep star field.
 *
 * Rendered as instanced camera-facing quads rather than GL points. `THREE.Points`
 * on a WebGPU backend is limited to one-pixel primitives with no `gl_PointCoord`,
 * so a `Points` object would be a field of hard single pixels there and soft
 * glowing discs on WebGL2 — two completely different games. three's documented
 * cross-backend answer is to drive a `PointsNodeMaterial` from a `Sprite` with an
 * instance `count`, which is what this does: one draw call, per-instance
 * attributes, identical output on both backends.
 *
 * Stars are distributed on nested shells so the layers slide against each other
 * as the ship moves, which is the only cue at this distance that sells depth.
 */

import {
  AdditiveBlending,
  Group,
  PointsNodeMaterial,
  Sprite,
  Vector3,
} from 'three/webgpu';
import { float, instancedBufferAttribute, saturate, sin, time, uv, varying, vec4 } from 'three/tsl';
import { Rng } from '../../core/rng';
import type { EnvironmentArchetype, TrackPalette } from '../../track/types';
import { hexToLinear, luminance, mixRGB, type RGB } from './sky';

/** TSL builds dynamic node graphs; the concrete node generics get in the way. */
type N = any;

export interface StarfieldOptions {
  archetype: EnvironmentArchetype;
  palette: TrackPalette;
  seed: string;
  /** Total star budget across all layers (`QualitySettings.starCount`). */
  count: number;
  /** Radius of the sky shell in the sky group's local units. */
  radius: number;
}

interface LayerTuning {
  /** Fraction of the total star budget. */
  share: number;
  /** Shell radius as a fraction of `radius`. */
  depth: number;
  /** How strongly this layer lags behind camera motion. 0 = infinitely far. */
  parallax: number;
  sizeScale: number;
  brightnessScale: number;
}

interface ArchetypeTuning {
  /** Multiplies the requested star count. */
  density: number;
  /** Base pixel size of a median star. */
  size: number;
  /** Overall brightness multiplier. */
  brightness: number;
  /** Bias of the temperature distribution: <1 cooler/redder, >1 hotter/bluer. */
  temperature: number;
  /** How far star colours are pulled toward the palette, 0..1. */
  tint: number;
  /** Fraction of stars that get diffraction spikes. */
  heroFraction: number;
  twinkle: number;
}

const TUNING: Record<EnvironmentArchetype, ArchetypeTuning> = {
  // Gas washes the field out: many stars, but small and dim.
  nebula: { density: 1.0, size: 1.5, brightness: 0.75, temperature: 1.0, tint: 0.18, heroFraction: 0.006, twinkle: 0.3 },
  // Cold and clinical. Few, hard, blue-white.
  megastructure: { density: 0.55, size: 1.5, brightness: 0.9, temperature: 1.35, tint: 0.05, heroFraction: 0.004, twinkle: 0.2 },
  // Candy sky — stars read as sparkle, tinted hard toward the palette.
  prismatic: { density: 0.7, size: 1.8, brightness: 0.85, temperature: 1.1, tint: 0.5, heroFraction: 0.012, twinkle: 0.45 },
  // The hero case: brilliant, deep, wide magnitude range.
  starfield: { density: 1.25, size: 2.1, brightness: 1.35, temperature: 1.0, tint: 0.05, heroFraction: 0.02, twinkle: 0.35 },
  // Warm neighbourhood of a gas giant.
  ringworld: { density: 0.85, size: 1.7, brightness: 0.9, temperature: 0.85, tint: 0.2, heroFraction: 0.008, twinkle: 0.3 },
  // Sparse, cold, unnerving.
  void: { density: 0.4, size: 1.4, brightness: 0.6, temperature: 0.8, tint: 0.12, heroFraction: 0.002, twinkle: 0.5 },
};

const LAYERS: LayerTuning[] = [
  { share: 0.55, depth: 1.0, parallax: 0.0, sizeScale: 0.85, brightnessScale: 0.8 },
  { share: 0.3, depth: 0.94, parallax: 0.05, sizeScale: 1.0, brightnessScale: 1.0 },
  { share: 0.15, depth: 0.86, parallax: 0.13, sizeScale: 1.25, brightnessScale: 1.25 },
];

/**
 * Blackbody colour, Tanner Helland's piecewise fit, returned in linear space.
 * Real stellar colours are subtle — the point is that a field of pure white
 * dots looks synthetic, while a field with a few percent of blue and amber
 * variation reads as a photograph.
 */
export function blackbodyLinear(kelvin: number): RGB {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }

  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;

  const norm = (v: number): number => Math.min(1, Math.max(0, v / 255));
  // Cheap sRGB decode; the values are a fit, not measurements, so exactness
  // past this point is not meaningful.
  const lin = (v: number): number => v * v * (0.7 + 0.3 * v);
  return [lin(norm(r)), lin(norm(g)), lin(norm(b))];
}

/**
 * Samples a stellar temperature. Weighted heavily toward the cool end because
 * that is what the real sky looks like, with a long hot tail so the few blue
 * giants stand out.
 */
export function sampleTemperature(u: number, bias: number): number {
  // u^2.6 keeps most draws low; bias shifts the whole curve.
  const t = Math.pow(u, 2.6);
  return (2900 + t * 19000) * bias;
}

export interface Starfield {
  object: Group;
  /** Total instances actually created. */
  starCount: number;
  /**
   * @param camera   Current camera position, world space.
   * @param centre   Track centre; parallax is measured relative to it so the
   *                 offset stays bounded no matter where the track sits.
   * @param invScale Reciprocal of the sky group's uniform scale.
   */
  update(camera: Vector3, centre: Vector3, invScale: number): void;
  dispose(): void;
}

export function createStarfield(options: StarfieldOptions): Starfield {
  const tuning = TUNING[options.archetype];
  const rng = new Rng(`${options.seed}:stars`);
  const total = Math.max(0, Math.round(options.count * tuning.density));

  const paletteTint = mixRGB(
    hexToLinear(options.palette.glow),
    hexToLinear(options.palette.secondary),
    0.5,
  );
  // Normalise the tint so tinting changes hue, not exposure.
  const tintLum = Math.max(1e-4, luminance(paletteTint));
  const tint: RGB = [paletteTint[0] / tintLum, paletteTint[1] / tintLum, paletteTint[2] / tintLum];

  const group = new Group();
  group.name = 'Starfield';

  const sprites: Sprite[] = [];
  const materials: PointsNodeMaterial[] = [];
  const offsets: number[] = [];
  let created = 0;

  for (const layer of LAYERS) {
    const n = Math.round(total * layer.share);
    if (n <= 0) continue;

    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const params = new Float32Array(n * 4);
    const shell = options.radius * layer.depth;

    for (let i = 0; i < n; i++) {
      // Uniform on the sphere: acos-distributed z, not uniform z-angle, or the
      // poles end up visibly denser.
      const z = rng.range(-1, 1);
      const a = rng.range(0, Math.PI * 2);
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      // A little radial jitter stops the layers looking like painted shells if
      // the camera ever gets a wide field of view.
      const r = shell * rng.range(0.97, 1.0);
      positions[i * 3] = Math.cos(a) * s * r;
      positions[i * 3 + 1] = z * r;
      positions[i * 3 + 2] = Math.sin(a) * s * r;

      // Magnitude: cubed uniform, so the field is mostly faint with a handful
      // of genuinely bright anchors.
      const mag = Math.pow(rng.next(), 3);
      const temperature = sampleTemperature(rng.next(), tuning.temperature);
      const bb = blackbodyLinear(temperature);
      const col = tuning.tint > 0 ? mixRGB(bb, [bb[0] * tint[0], bb[1] * tint[1], bb[2] * tint[2]], tuning.tint) : bb;

      const brightness =
        (0.1 + mag * 1.35) * tuning.brightness * layer.brightnessScale * (0.75 + rng.next() * 0.5);
      colors[i * 3] = col[0] * brightness;
      colors[i * 3 + 1] = col[1] * brightness;
      colors[i * 3 + 2] = col[2] * brightness;

      const size = tuning.size * layer.sizeScale * (0.62 + mag * 2.3) * rng.range(0.85, 1.15);
      const hero = mag > 0.5 && rng.next() < tuning.heroFraction / 0.5;
      params[i * 4] = size;
      params[i * 4 + 1] = rng.range(0, Math.PI * 2);
      // Big stars scintillate less — makes the small ones feel further away.
      params[i * 4 + 2] = tuning.twinkle * (0.5 - mag * 0.35) * rng.range(0.5, 1);
      params[i * 4 + 3] = hero ? rng.range(0.35, 0.9) : 0;
    }

    const aPos: N = instancedBufferAttribute(positions, 'vec3');
    const aCol: N = instancedBufferAttribute(colors, 'vec3');
    const aPar: N = instancedBufferAttribute(params, 'vec4');

    // sin() is cheaper than any noise here and, with a per-star phase and rate,
    // the field never reads as synchronised.
    const rate: N = aPar.y.mul(0.31).fract().mul(2.2).add(0.6);
    const wobble: N = sin(time.mul(rate).add(aPar.y));
    const twinkle: N = varying(float(1).add(wobble.mul(aPar.z)), 'vTwinkle');

    const material = new PointsNodeMaterial();
    material.positionNode = aPos;
    material.sizeNode = aPar.x.mul(float(1).add(wobble.mul(aPar.z).mul(0.18)));
    material.sizeAttenuation = false;
    material.transparent = true;
    material.blending = AdditiveBlending;
    material.depthWrite = false;
    material.depthTest = true;
    material.fog = false;

    const vColor: N = varying(aCol, 'vStarColor');
    const vSpike: N = varying(aPar.w, 'vStarSpike');

    const p: N = uv().sub(0.5).mul(2);
    const dist = p.length();
    const fall = saturate(float(1).sub(dist));
    // Two lobes: a tight core that survives bloom thresholding as a point, and
    // a wide skirt that stops the quad edge from being visible.
    const core = fall.pow(7).mul(1.7);
    const halo = fall.pow(2).mul(0.28);
    const ax = p.x.abs();
    const ay = p.y.abs();
    const spikeH = saturate(float(1).sub(ay.mul(11))).pow(2).mul(saturate(float(1).sub(ax)).pow(1.6));
    const spikeV = saturate(float(1).sub(ax.mul(11))).pow(2).mul(saturate(float(1).sub(ay)).pow(1.6));
    const spikes = spikeH.add(spikeV).mul(vSpike).mul(0.55);

    material.colorNode = vec4(vColor, core.add(halo).add(spikes).mul(twinkle).mul(0.85));

    const sprite = new Sprite(material);
    sprite.count = n;
    sprite.frustumCulled = false;
    sprite.renderOrder = -40;
    sprite.matrixAutoUpdate = true;
    group.add(sprite);

    sprites.push(sprite);
    materials.push(material);
    offsets.push(layer.parallax);
    created += n;
  }

  const tmp = new Vector3();

  return {
    object: group,
    starCount: created,
    update(camera: Vector3, centre: Vector3, invScale: number): void {
      // The whole sky group already rides the camera, so a layer sitting still
      // in world space has to be pushed back by the camera's own displacement.
      tmp.subVectors(camera, centre).multiplyScalar(-invScale);
      for (let i = 0; i < sprites.length; i++) {
        const k = offsets[i];
        if (k === 0) continue;
        sprites[i].position.set(tmp.x * k, tmp.y * k, tmp.z * k);
      }
    },
    dispose(): void {
      for (const s of sprites) group.remove(s);
      for (const m of materials) m.dispose();
      sprites.length = 0;
      materials.length = 0;
    },
  };
}
