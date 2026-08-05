/**
 * Deep star field.
 *
 * Rendered as instanced camera-facing quads, one draw call per parallax layer.
 * Not `THREE.Points`: on a WebGPU backend point primitives are locked to a
 * single pixel and `gl_PointCoord` does not exist, so a `Points` object would be
 * a field of hard one-pixel dots there and soft glowing discs on WebGL2 — two
 * different games. `PointsNodeMaterial` driven from a `Sprite` is three's
 * documented workaround for that, but it leaves the instance plumbing implicit;
 * an `InstancedBufferGeometry` with named per-star attributes and a hand-written
 * vertex node does the same job with nothing hidden, and the sizing maths is
 * lifted straight from `PointsNodeMaterial` so sizes stay in screen pixels.
 *
 * Stars sit on nested shells that lag behind the camera by different amounts.
 * At this distance relative motion between layers is the only depth cue there
 * is, and without it the sky reads as a painted dome.
 */

import {
  AdditiveBlending,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  Sphere,
  Vector3,
} from 'three/webgpu';
import {
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  fract,
  modelWorldMatrix,
  positionGeometry,
  saturate,
  screenDPR,
  sin,
  time,
  uv,
  vec2,
  vec4,
  viewportSize,
} from 'three/tsl';
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
  nebula: { density: 1.0, size: 1.9, brightness: 0.8, temperature: 1.0, tint: 0.18, heroFraction: 0.006, twinkle: 0.3 },
  // Cold and clinical. Few, hard, blue-white.
  megastructure: { density: 0.55, size: 1.9, brightness: 1.0, temperature: 1.35, tint: 0.05, heroFraction: 0.004, twinkle: 0.2 },
  // Candy sky — stars read as sparkle, tinted hard toward the palette.
  prismatic: { density: 0.7, size: 2.2, brightness: 0.95, temperature: 1.1, tint: 0.5, heroFraction: 0.012, twinkle: 0.45 },
  // The hero case: brilliant, deep, wide magnitude range.
  starfield: { density: 1.25, size: 2.5, brightness: 1.5, temperature: 1.0, tint: 0.05, heroFraction: 0.02, twinkle: 0.35 },
  // Warm neighbourhood of a gas giant.
  ringworld: { density: 0.85, size: 2.1, brightness: 1.0, temperature: 0.85, tint: 0.2, heroFraction: 0.008, twinkle: 0.3 },
  // Sparse, cold, unnerving.
  void: { density: 0.4, size: 1.8, brightness: 0.7, temperature: 0.8, tint: 0.12, heroFraction: 0.002, twinkle: 0.5 },
};

const LAYERS: LayerTuning[] = [
  { share: 0.55, depth: 1.0, parallax: 0.0, sizeScale: 0.85, brightnessScale: 0.8 },
  { share: 0.3, depth: 0.94, parallax: 0.05, sizeScale: 1.0, brightnessScale: 1.0 },
  { share: 0.15, depth: 0.86, parallax: 0.13, sizeScale: 1.3, brightnessScale: 1.3 },
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

/** The unit quad every star instance is drawn from. */
function starQuad(): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry();
  g.setAttribute(
    'position',
    new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
  );
  g.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
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

  const meshes: Mesh[] = [];
  const geometries: InstancedBufferGeometry[] = [];
  const materials: MeshBasicNodeMaterial[] = [];
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
      // Uniform on the sphere: pick z uniformly, not the polar angle, or the
      // poles end up visibly denser.
      const z = rng.range(-1, 1);
      const a = rng.range(0, Math.PI * 2);
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      // Radial jitter stops a layer reading as a painted shell.
      const r = shell * rng.range(0.96, 1.0);
      positions[i * 3] = Math.cos(a) * s * r;
      positions[i * 3 + 1] = z * r;
      positions[i * 3 + 2] = Math.sin(a) * s * r;

      // Magnitude: cubed uniform, so the field is mostly faint with a handful
      // of genuinely bright anchors.
      const mag = Math.pow(rng.next(), 3);
      const temperature = sampleTemperature(rng.next(), tuning.temperature);
      const bb = blackbodyLinear(temperature);
      const col =
        tuning.tint > 0
          ? mixRGB(bb, [bb[0] * tint[0], bb[1] * tint[1], bb[2] * tint[2]], tuning.tint)
          : bb;

      const brightness =
        (0.12 + mag * 1.5) * tuning.brightness * layer.brightnessScale * (0.75 + rng.next() * 0.5);
      colors[i * 3] = col[0] * brightness;
      colors[i * 3 + 1] = col[1] * brightness;
      colors[i * 3 + 2] = col[2] * brightness;

      const size = tuning.size * layer.sizeScale * (0.7 + mag * 2.4) * rng.range(0.85, 1.15);
      const hero = mag > 0.5 && rng.next() < tuning.heroFraction / 0.5;
      params[i * 4] = size;
      params[i * 4 + 1] = rng.range(0, Math.PI * 2);
      // Big stars scintillate less — makes the small ones feel further away.
      params[i * 4 + 2] = tuning.twinkle * (0.5 - mag * 0.35) * rng.range(0.5, 1);
      params[i * 4 + 3] = hero ? rng.range(0.35, 0.9) : 0;
    }

    const geometry = starQuad();
    geometry.setAttribute('aStar', new InstancedBufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new InstancedBufferAttribute(colors, 3));
    geometry.setAttribute('aParams', new InstancedBufferAttribute(params, 4));
    geometry.instanceCount = n;
    geometry.boundingSphere = new Sphere(new Vector3(), shell * 1.1);

    const aStar: N = attribute('aStar', 'vec3');
    const aColor: N = attribute('aColor', 'vec3');
    const aParams: N = attribute('aParams', 'vec4');

    // sin() is cheaper than any noise, and with a per-star phase and rate the
    // field never reads as synchronised.
    const rate: N = fract(aParams.y.mul(0.31)).mul(2.2).add(0.6);
    const wobble: N = sin(time.mul(rate).add(aParams.y));
    const twinkle: N = float(1).add(wobble.mul(aParams.z));

    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = AdditiveBlending;
    material.depthWrite = false;
    material.depthTest = true;
    material.fog = false;

    // Camera-facing quad sized in screen pixels: project the star's centre,
    // then push the corners out in clip space by the pixel radius. Same maths
    // as PointsNodeMaterial's sprite path, written out.
    const centreView: N = cameraViewMatrix
      .mul(modelWorldMatrix)
      .mul(vec4(aStar.x, aStar.y, aStar.z, 1));
    const clip: N = cameraProjectionMatrix.mul(centreView);
    const pixels: N = aParams.x.mul(float(1).add(wobble.mul(aParams.z).mul(0.2))).mul(screenDPR);
    const corner: N = positionGeometry;
    const offset: N = vec2(corner.x, corner.y)
      .mul(pixels)
      .div(viewportSize.mul(0.5))
      .mul(clip.w);
    material.vertexNode = clip.add(vec4(offset.x, offset.y, 0, 0));

    const p: N = uv().sub(0.5).mul(2);
    const dist: N = p.length();
    const fall: N = saturate(float(1).sub(dist));
    // Two lobes: a tight core that survives bloom thresholding as a point, and
    // a wide skirt so the quad's edge is never visible.
    const core: N = fall.pow(7).mul(1.7);
    const halo: N = fall.pow(2).mul(0.3);
    const ax: N = p.x.abs();
    const ay: N = p.y.abs();
    const spikeH: N = saturate(float(1).sub(ay.mul(11))).pow(2).mul(saturate(float(1).sub(ax)).pow(1.6));
    const spikeV: N = saturate(float(1).sub(ax.mul(11))).pow(2).mul(saturate(float(1).sub(ay)).pow(1.6));
    const spikes: N = spikeH.add(spikeV).mul(aParams.w).mul(0.55);

    material.colorNode = vec4(aColor, core.add(halo).add(spikes).mul(twinkle).mul(0.9));

    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -40;
    group.add(mesh);

    meshes.push(mesh);
    geometries.push(geometry);
    materials.push(material);
    offsets.push(layer.parallax);
    created += n;
  }

  const tmp = new Vector3();

  return {
    object: group,
    starCount: created,
    update(camera: Vector3, centre: Vector3, invScale: number): void {
      // The whole sky group already rides the camera, so a layer that is meant
      // to sit still in world space has to be pushed back by the camera's own
      // displacement — scaled into the group's local units.
      tmp.subVectors(camera, centre).multiplyScalar(-invScale);
      for (let i = 0; i < meshes.length; i++) {
        const k = offsets[i];
        if (k === 0) continue;
        meshes[i].position.set(tmp.x * k, tmp.y * k, tmp.z * k);
      }
    },
    dispose(): void {
      for (const m of meshes) group.remove(m);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      meshes.length = 0;
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
