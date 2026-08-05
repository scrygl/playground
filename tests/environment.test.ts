/**
 * Environment subsystem tests.
 *
 * Runs in Node, so nothing here may touch a GL context. That is fine by
 * construction: the sky is generated into `DataTexture` buffers with plain
 * arithmetic (no canvas), and three's scene-graph objects can be built and
 * disposed without a renderer. The only thing genuinely untestable here is what
 * the shaders look like, which is what the screenshot harness is for.
 */

import { check, describe, near, range, report } from './harness';
import { Vector3 } from 'three/webgpu';
import { tierSettings } from '../src/core/quality';
import type { EnvironmentArchetype, TrackPalette } from '../src/track/types';
import {
  SkyField,
  SpaceNoise,
  buildSkyRecipe,
  directionForFace,
  generateSky,
  hexToLinear,
  linearToHex,
  luminance,
  saturateRGB,
  toLuminance,
  type RGB,
} from '../src/render/environment/sky';
import { blackbodyLinear, sampleTemperature } from '../src/render/environment/starfield';
import { planScenery, sceneryExtent, structureColors } from '../src/render/environment/scenery';
import { createEnvironment, deriveLighting } from '../src/render/environment/index';

const ARCHETYPES: EnvironmentArchetype[] = [
  'nebula',
  'megastructure',
  'prismatic',
  'starfield',
  'ringworld',
  'void',
];

const PALETTE: TrackPalette = {
  primary: 0x37e6ff,
  secondary: 0xff3d8b,
  deep: 0x0b0f33,
  glow: 0xb679ff,
  sun: 0xfff2d0,
  haze: 0x3d2a78,
};

const OTHER_PALETTE: TrackPalette = {
  primary: 0xffc46b,
  secondary: 0x5fe0c0,
  deep: 0x160d1f,
  glow: 0xffd9a0,
  sun: 0xffe6b8,
  haze: 0x6b4326,
};

// ---------------------------------------------------------------------------

describe('colour conversion', () => {
  const white = hexToLinear(0xffffff);
  near('white round-trips to 1.0 linear', white[0], 1, 1e-6);
  check('mid grey decodes below its sRGB value', hexToLinear(0x808080)[0] < 0.3);
  check('hex round-trip is stable', linearToHex(hexToLinear(0x37e6ff)) === 0x37e6ff);

  const lum = luminance(hexToLinear(0xffffff));
  near('white luminance is 1', lum, 1, 1e-6);

  const target = toLuminance(hexToLinear(0x37e6ff), 0.25);
  near('toLuminance hits its target', luminance(target), 0.25, 1e-6);

  const grey = saturateRGB(hexToLinear(0xff0000), 0);
  check('desaturating fully yields a neutral', Math.abs(grey[0] - grey[1]) < 1e-6 && Math.abs(grey[1] - grey[2]) < 1e-6);
  near('desaturating preserves luminance', luminance(grey), luminance(hexToLinear(0xff0000)), 1e-6);
});

describe('value noise', () => {
  const a = new SpaceNoise('alpha');
  const b = new SpaceNoise('alpha');
  const c = new SpaceNoise('beta');

  let sameSeedMatches = true;
  let differentSeedDiffers = false;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < 500; i++) {
    const x = i * 0.37;
    const y = i * -0.19 + 3;
    const z = i * 0.71 - 5;
    const va = a.value(x, y, z);
    if (va !== b.value(x, y, z)) sameSeedMatches = false;
    if (Math.abs(va - c.value(x, y, z)) > 1e-9) differentSeedDiffers = true;
    min = Math.min(min, va);
    max = Math.max(max, va);
  }
  check('same seed produces identical noise', sameSeedMatches);
  check('different seeds diverge', differentSeedDiffers);
  range('noise stays inside [-1, 1]', min, -1, 1);
  range('noise stays inside [-1, 1]', max, -1, 1);
  check('noise actually varies', max - min > 0.8, `span ${max - min}`);

  // C2 continuity: tiny steps must produce tiny changes, everywhere including
  // across lattice boundaries.
  let maxJump = 0;
  for (let i = 0; i < 400; i++) {
    const x = i * 0.25;
    maxJump = Math.max(maxJump, Math.abs(a.value(x, 1.5, 2.5) - a.value(x + 1e-3, 1.5, 2.5)));
  }
  check('noise is continuous across the lattice', maxJump < 0.02, `max jump ${maxJump}`);

  // Lattice points are exactly reproducible, so integer coordinates must be
  // stable under a full period of 256.
  near('the permutation table wraps at 256', a.value(3.5, 0.5, 0.5), a.value(259.5, 256.5, 256.5), 1e-6);

  let fmin = Infinity;
  let fmax = -Infinity;
  for (let i = 0; i < 800; i++) {
    const v = a.fbm(i * 0.13, i * 0.29, i * -0.41, 5);
    fmin = Math.min(fmin, v);
    fmax = Math.max(fmax, v);
  }
  range('fbm stays normalised', fmin, -1, 1);
  range('fbm stays normalised', fmax, -1, 1);

  let rmin = Infinity;
  let rmax = -Infinity;
  for (let i = 0; i < 800; i++) {
    const v = a.ridged(i * 0.11, i * 0.23, i * -0.37, 4);
    rmin = Math.min(rmin, v);
    rmax = Math.max(rmax, v);
  }
  range('ridged noise stays in [0, 1]', rmin, 0, 1);
  range('ridged noise stays in [0, 1]', rmax, 0, 1);
});

describe('cube face geometry', () => {
  const d: RGB = [0, 0, 0];
  let unit = true;
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 4; j++) {
        directionForFace(f, i / 4, j / 4, d);
        const len = Math.hypot(d[0], d[1], d[2]);
        if (Math.abs(len - 1) > 1e-9) unit = false;
      }
    }
  }
  check('every face direction is unit length', unit);

  const centres: RGB[] = [];
  for (let f = 0; f < 6; f++) centres.push(directionForFace(f, 0.5, 0.5, [0, 0, 0]));
  check('face centres are the six axes', [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ].every((axis, f) => axis.every((v, k) => Math.abs(centres[f][k] - v) < 1e-9)));
});

describe('sky is seamless across cube faces', () => {
  // Every shared edge of the cube, as (faceA, faceB) plus the parameterisation
  // that walks each one along that edge.
  const edges: { a: [number, (t: number) => [number, number]]; b: [number, (t: number) => [number, number]] }[] = [
    { a: [0, (t) => [1, t]], b: [5, (t) => [0, t]] }, // +X right / -Z left
    { a: [0, (t) => [0, t]], b: [4, (t) => [1, t]] }, // +X left  / +Z right
    { a: [1, (t) => [1, t]], b: [4, (t) => [0, t]] }, // -X right / +Z left
    { a: [1, (t) => [0, t]], b: [5, (t) => [1, t]] }, // -X left  / -Z right
    { a: [2, (t) => [t, 1]], b: [4, (t) => [t, 0]] }, // +Y bottom / +Z top
    { a: [3, (t) => [t, 0]], b: [4, (t) => [t, 1]] }, // -Y top    / +Z bottom
  ];

  const d1: RGB = [0, 0, 0];
  const d2: RGB = [0, 0, 0];
  const c1: RGB = [0, 0, 0];
  const c2: RGB = [0, 0, 0];

  for (const archetype of ARCHETYPES) {
    const field = new SkyField(buildSkyRecipe(archetype, PALETTE, 'seam-seed'));
    let worstDir = 0;
    let worstColor = 0;
    for (const edge of edges) {
      for (let k = 0; k < 33; k++) {
        const t = k / 32;
        const [sa, ta] = edge.a[1](t);
        const [sb, tb] = edge.b[1](t);
        directionForFace(edge.a[0], sa, ta, d1);
        directionForFace(edge.b[0], sb, tb, d2);
        worstDir = Math.max(worstDir, Math.hypot(d1[0] - d2[0], d1[1] - d2[1], d1[2] - d2[2]));
        field.shade(d1[0], d1[1], d1[2], 1, c1);
        field.shade(d2[0], d2[1], d2[2], 1, c2);
        worstColor = Math.max(
          worstColor,
          Math.abs(c1[0] - c2[0]) + Math.abs(c1[1] - c2[1]) + Math.abs(c1[2] - c2[2]),
        );
      }
    }
    check(`${archetype}: shared edges resolve to the same direction`, worstDir < 1e-12, `worst ${worstDir}`);
    check(`${archetype}: shared edges shade identically`, worstColor < 1e-12, `worst ${worstColor}`);
  }
});

describe('sky recipes', () => {
  for (const archetype of ARCHETYPES) {
    const a = buildSkyRecipe(archetype, PALETTE, 'recipe-seed');
    const b = buildSkyRecipe(archetype, PALETTE, 'recipe-seed');
    check(`${archetype}: deterministic`, JSON.stringify(a) === JSON.stringify(b));
    near(
      `${archetype}: sun direction is unit length`,
      Math.hypot(a.sunDir[0], a.sunDir[1], a.sunDir[2]),
      1,
      1e-9,
    );
    check(`${archetype}: sun is above the horizon`, a.sunDir[1] > 0);
    near(
      `${archetype}: band axis is unit length`,
      Math.hypot(a.bandAxis[0], a.bandAxis[1], a.bandAxis[2]),
      1,
      1e-9,
    );
  }

  const seedA = buildSkyRecipe('nebula', PALETTE, 'one');
  const seedB = buildSkyRecipe('nebula', PALETTE, 'two');
  check('different seeds move the sun', seedA.sunDir[0] !== seedB.sunDir[0]);

  // The palette must actually drive the colours, not just be decoration.
  const p1 = buildSkyRecipe('nebula', PALETTE, 'same');
  const p2 = buildSkyRecipe('nebula', OTHER_PALETTE, 'same');
  check('palette drives the cloud colour', JSON.stringify(p1.cloudA) !== JSON.stringify(p2.cloudA));
  check('palette drives the core colour', JSON.stringify(p1.core) !== JSON.stringify(p2.core));

  // Archetypes must be visually distinct, not the same sky with a tint.
  const signatures = new Set(
    ARCHETYPES.map((a) => {
      const r = buildSkyRecipe(a, PALETTE, 'same');
      return [r.density, r.contrast, r.threshold, r.bandWidth, r.glowFalloff, r.spectral].join(',');
    }),
  );
  check('all six archetypes have distinct structure', signatures.size === 6, `${signatures.size} unique`);
});

describe('sky luminance stays under the racing line', () => {
  const out: RGB = [0, 0, 0];
  for (const archetype of ARCHETYPES) {
    const field = new SkyField(buildSkyRecipe(archetype, PALETTE, 'lum-seed'));
    let peak = 0;
    let sum = 0;
    let n = 0;
    const d: RGB = [0, 0, 0];
    for (let f = 0; f < 6; f++) {
      for (let j = 0; j < 12; j++) {
        for (let i = 0; i < 12; i++) {
          directionForFace(f, (i + 0.5) / 12, (j + 0.5) / 12, d);
          field.shade(d[0], d[1], d[2], 1, out);
          const l = luminance(out);
          peak = Math.max(peak, l);
          sum += l;
          n++;
        }
      }
    }
    const mean = sum / n;
    // The track's emissive sits at 3-5x white; a mean sky above ~0.12 would
    // start competing with it once bloom is applied.
    range(`${archetype}: mean sky luminance is background-level`, mean, 0, 0.12);
    range(`${archetype}: sky never clips to white`, peak, 0, 1.0001);
  }
});

describe('sky texture generation', () => {
  const recipe = buildSkyRecipe('nebula', PALETTE, 'texture-seed');
  const sky = generateSky(recipe, 64);

  check('background is a cube texture', sky.background.isCubeTexture === true);
  check('six background faces', sky.background.images.length === 6);
  check('six env faces', sky.envMap.images.length === 6);
  check(
    'faces are the requested size',
    sky.background.images.every((img: { image: { width: number; height: number } }) => img.image.width === 64 && img.image.height === 64),
  );
  check(
    'faces carry RGBA bytes',
    sky.background.images.every((img: { image: { data: Uint8Array } }) => img.image.data.length === 64 * 64 * 4),
  );
  check('env map is much smaller than the background', sky.envMap.images[0].image.width < 32);
  check('cube maps do not request mipmaps', sky.background.generateMipmaps === false);
  check('generation is reported', sky.generationMs >= 0 && Number.isFinite(sky.generationMs));
  check('shaded texel count is reported', sky.shadedTexels === 64 * 64 * 6);

  range('average sky is dark', luminance(sky.averageColor), 0, 0.12);
  near(
    'brightest direction is a unit vector',
    Math.hypot(sky.brightestDir[0], sky.brightestDir[1], sky.brightestDir[2]),
    1,
    1e-9,
  );
  check(
    'the brightest point is at the sun',
    sky.brightestDir[0] * recipe.sunDir[0] +
      sky.brightestDir[1] * recipe.sunDir[1] +
      sky.brightestDir[2] * recipe.sunDir[2] >
      0.9,
  );

  // Determinism at the byte level: the same seed must produce the same pixels.
  const again = generateSky(buildSkyRecipe('nebula', PALETTE, 'texture-seed'), 64);
  let identical = true;
  for (let f = 0; f < 6; f++) {
    const x = sky.background.images[f].image.data as Uint8Array;
    const y = again.background.images[f].image.data as Uint8Array;
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) {
        identical = false;
        break;
      }
    }
  }
  check('the same seed produces identical pixels', identical);

  const different = generateSky(buildSkyRecipe('nebula', PALETTE, 'other-seed'), 64);
  let differs = false;
  const a0 = sky.background.images[0].image.data as Uint8Array;
  const b0 = different.background.images[0].image.data as Uint8Array;
  for (let i = 0; i < a0.length; i++) {
    if (a0[i] !== b0[i]) {
      differs = true;
      break;
    }
  }
  check('a different seed produces different pixels', differs);

  sky.dispose();
  again.dispose();
  different.dispose();
});

describe('star colour distribution', () => {
  const hot = blackbodyLinear(20000);
  const cool = blackbodyLinear(3000);
  check('hot stars are blue-biased', hot[2] > hot[0]);
  check('cool stars are red-biased', cool[0] > cool[2]);
  const sun = blackbodyLinear(5800);
  check('sunlike stars are near neutral', Math.abs(sun[0] - sun[2]) < 0.55);
  check(
    'all channels stay in gamut',
    [hot, cool, sun].every((c) => c.every((v) => v >= 0 && v <= 1)),
  );

  check('temperature sampling is monotonic in u', sampleTemperature(0.9, 1) > sampleTemperature(0.2, 1));
  range('the coolest draw is a real star temperature', sampleTemperature(0, 1), 2500, 3500);
  range('the hottest draw is a real star temperature', sampleTemperature(1, 1), 15000, 30000);
  check('bias shifts the whole distribution', sampleTemperature(0.5, 1.4) > sampleTemperature(0.5, 1));
});

describe('scenery placement', () => {
  const a = planScenery('nebula', 'place-seed', 1, 400);
  const b = planScenery('nebula', 'place-seed', 1, 400);
  const c = planScenery('nebula', 'other-seed', 1, 400);

  check('placement is deterministic', JSON.stringify(a) === JSON.stringify(b));
  check('a different seed moves things', JSON.stringify(a) !== JSON.stringify(c));

  const count = (plans: ReturnType<typeof planScenery>): number =>
    plans.reduce((s, p) => s + p.placements.length, 0);
  const half = planScenery('nebula', 'place-seed', 0.5, 400);
  const none = planScenery('nebula', 'place-seed', 0, 400);
  check('density scales the instance count', count(half) < count(a) && count(half) > 0);
  check('zero density places nothing', count(none) === 0);

  check('every family is represented', a.length === 5);
  check(
    'nothing is placed inside the track bounds',
    a
      .filter((p) => p.kind !== 'debris' && p.kind !== 'traffic')
      .every((p) => p.placements.every((q) => Math.hypot(q.position.x, q.position.z) > 400)),
  );
  range('the field stays within a sane radius', sceneryExtent(a) / 400, 1, 9);

  // Every prop must be assigned a beat lane, and all four must get used.
  const lanes = new Set<number>();
  let laneOk = true;
  for (const plan of a) {
    for (const p of plan.placements) {
      lanes.add(p.lane);
      if (!Number.isInteger(p.lane) || p.lane < 0 || p.lane > 3) laneOk = false;
      if (!(p.scale.x > 0 && p.scale.y > 0 && p.scale.z > 0)) laneOk = false;
    }
  }
  check('beat lanes are valid and every scale is positive', laneOk);
  check('all four beat lanes are populated', lanes.size === 4);

  // Scale with the track, not with absolute numbers.
  const small = planScenery('nebula', 'place-seed', 1, 100);
  near('placement scales with the track radius', sceneryExtent(small) * 4, sceneryExtent(a), 1e-6);

  // Archetypes must dress differently.
  const counts = new Set(ARCHETYPES.map((x) => count(planScenery(x, 'place-seed', 1, 400))));
  check('archetypes have distinct dressing densities', counts.size >= 5, `${counts.size} unique`);
});

describe('structure colours honour the palette', () => {
  const toPal = (p: TrackPalette) => ({
    primary: hexToLinear(p.primary),
    secondary: hexToLinear(p.secondary),
    deep: hexToLinear(p.deep),
    glow: hexToLinear(p.glow),
    sun: hexToLinear(p.sun),
    haze: hexToLinear(p.haze),
  });
  const one = structureColors('nebula', toPal(PALETTE));
  const two = structureColors('nebula', toPal(OTHER_PALETTE));
  check('a different palette gives different structures', JSON.stringify(one) !== JSON.stringify(two));
  check('emissives are brighter than bodies', luminance(one.emissive) > luminance(one.body) * 10);
  check(
    'void dressing is darker than the default',
    luminance(structureColors('void', toPal(PALETTE)).body) <
      luminance(structureColors('nebula', toPal(PALETTE)).body),
  );
});

describe('lighting derivation', () => {
  for (const archetype of ARCHETYPES) {
    const recipe = buildSkyRecipe(archetype, PALETTE, 'light-seed');
    const sky: RGB = [0.02, 0.018, 0.03];
    const light = deriveLighting(archetype, PALETTE, recipe, sky, 2600);

    near(
      `${archetype}: key direction is unit length`,
      light.keyLight.direction.length(),
      1,
      1e-9,
    );
    near(
      `${archetype}: key direction matches the sun in the sky`,
      light.keyLight.direction.dot(new Vector3(recipe.sunDir[0], recipe.sunDir[1], recipe.sunDir[2])),
      1,
      1e-9,
    );
    range(`${archetype}: key intensity is usable`, light.keyLight.intensity, 0.5, 8);
    range(`${archetype}: ambient intensity is usable`, light.ambient.intensity, 0.01, 2);
    check(`${archetype}: fog density is positive`, light.fog.density > 0);
    check(
      `${archetype}: ambient never overpowers the key`,
      light.ambient.intensity < light.keyLight.intensity,
    );
  }

  // Fog must follow the draw distance, or long tracks fog out at the horizon
  // while short ones look unfogged.
  const recipe = buildSkyRecipe('nebula', PALETTE, 'fog-seed');
  const near1 = deriveLighting('nebula', PALETTE, recipe, [0.02, 0.02, 0.02], 900);
  const far1 = deriveLighting('nebula', PALETTE, recipe, [0.02, 0.02, 0.02], 3400);
  check('a longer draw distance thins the fog', far1.fog.density < near1.fog.density);
  near('fog density tracks 1/drawDistance', (near1.fog.density * 900) / (far1.fog.density * 3400), 1, 1e-6);

  // Palette identity has to survive into the lighting.
  const withOther = deriveLighting('nebula', OTHER_PALETTE, recipe, [0.02, 0.02, 0.02], 2600);
  check('the palette drives the key colour', withOther.keyLight.color !== near1.keyLight.color);
  check('the palette drives the fog colour', withOther.fog.color !== near1.fog.color);

  // Brighter skies must fill more, but not without bound.
  const dim = deriveLighting('nebula', PALETTE, recipe, [0.002, 0.002, 0.002], 2600);
  const bright = deriveLighting('nebula', PALETTE, recipe, [0.2, 0.2, 0.2], 2600);
  check('a brighter sky fills more', bright.ambient.intensity > dim.ambient.intensity);
  check('the fill is bounded', bright.ambient.intensity < dim.ambient.intensity * 4);

  // Archetype character: hard-shadow environments run a strong key and no fill.
  const mega = deriveLighting('megastructure', PALETTE, recipe, [0.01, 0.01, 0.012], 2600);
  const neb = deriveLighting('nebula', PALETTE, recipe, [0.03, 0.028, 0.04], 2600);
  check('megastructure is higher contrast than nebula', mega.keyLight.intensity / mega.ambient.intensity > neb.keyLight.intensity / neb.ambient.intensity);
});

describe('createEnvironment / dispose', () => {
  const quality = tierSettings('low');
  const env = createEnvironment({
    archetype: 'ringworld',
    palette: PALETTE,
    seed: 'env-seed',
    quality,
    trackRadius: 400,
    trackCentre: new Vector3(10, -5, 20),
  });

  check('a root object is returned', env.root.children.length > 0);
  check('a background cube map is returned', env.background !== null);
  check('an env map is returned', env.envMap !== null);
  check('diagnostics report the skybox cost', env.diagnostics.skyboxMs > 0);
  check('stars were created', env.diagnostics.starCount > 0);
  check('scenery was created', env.diagnostics.sceneryInstances > 0);

  // Collect every GPU-backed resource hanging off the environment and assert
  // that dispose() actually releases each one.
  const geometries = new Set<{ addEventListener: (t: string, f: () => void) => void }>();
  const materials = new Set<{ addEventListener: (t: string, f: () => void) => void }>();
  env.root.traverse((obj: any) => {
    if (obj.geometry) geometries.add(obj.geometry);
    if (obj.material) {
      if (Array.isArray(obj.material)) for (const m of obj.material) materials.add(m);
      else materials.add(obj.material);
    }
  });
  const textures = [env.background, env.envMap].filter(Boolean) as any[];
  for (const t of textures) for (const img of t.images) if (img?.isDataTexture) textures.push(img);

  check('the scene graph carries geometry', geometries.size > 0, `${geometries.size} geometries`);
  check('the scene graph carries materials', materials.size > 0, `${materials.size} materials`);

  let disposedGeometries = 0;
  let disposedMaterials = 0;
  let disposedTextures = 0;
  for (const g of geometries) g.addEventListener('dispose', () => disposedGeometries++);
  for (const m of materials) m.addEventListener('dispose', () => disposedMaterials++);
  for (const t of textures) t.addEventListener('dispose', () => disposedTextures++);

  const geometryCount = geometries.size;
  const materialCount = materials.size;
  const textureCount = textures.length;

  // update() must run without a real renderer and without allocating a scene.
  const camera: any = {
    far: 1300,
    position: new Vector3(50, 12, -80),
    matrixWorld: { elements: new Array(16).fill(0) },
  };
  camera.matrixWorld.elements[12] = 50;
  camera.matrixWorld.elements[13] = 12;
  camera.matrixWorld.elements[14] = -80;
  for (let i = 0; i < 8; i++) {
    env.update({ dt: 1 / 60, camera, intensity: 0.8, beatPhase: i / 8, beatIndex: i, speed: 0.6 });
  }
  const sky = env.root.children.find((c) => c.name === 'Sky');
  check('the sky group follows the camera', sky !== undefined && sky.position.x === 50 && sky.position.z === -80);
  check(
    'the sky shell is fitted to the far plane',
    sky !== undefined && Math.abs(sky.scale.x - (1300 * 0.9) / 1000) < 1e-6,
    `scale ${sky?.scale.x}`,
  );

  env.dispose();

  check('dispose() empties the root', env.root.children.length === 0);
  check(
    'dispose() releases every geometry',
    disposedGeometries === geometryCount,
    `${disposedGeometries}/${geometryCount}`,
  );
  check(
    'dispose() releases every material',
    disposedMaterials === materialCount,
    `${disposedMaterials}/${materialCount}`,
  );
  check(
    'dispose() releases every texture',
    disposedTextures === textureCount,
    `${disposedTextures}/${textureCount}`,
  );
});

describe('quality settings are honoured', () => {
  const potato = tierSettings('potato');
  const env = createEnvironment({
    archetype: 'void',
    palette: PALETTE,
    seed: 'potato-seed',
    quality: potato,
    trackRadius: 300,
    trackCentre: new Vector3(),
  });
  check('scenery is skipped when disabled', env.diagnostics.sceneryInstances === 0);
  check('no scenery group is added', env.root.children.every((c) => c.name !== 'Scenery'));
  check('the skybox honours the tier resolution', env.background !== null && (env.background as any).images[0].image.width === potato.skyboxResolution);
  check('star count follows the tier', env.diagnostics.starCount <= potato.starCount * 1.3);
  env.dispose();

  const ultra = tierSettings('ultra');
  const big = createEnvironment({
    archetype: 'void',
    palette: PALETTE,
    seed: 'potato-seed',
    quality: { ...ultra, skyboxResolution: 128 },
    trackRadius: 300,
    trackCentre: new Vector3(),
  });
  check('a higher tier produces more stars', big.diagnostics.starCount > env.diagnostics.starCount);
  check('a higher tier produces scenery', big.diagnostics.sceneryInstances > 0);
  big.dispose();
});

report('environment');
