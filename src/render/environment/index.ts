/**
 * Procedural space environments.
 *
 * `createEnvironment()` returns everything a track needs to sit inside: a
 * seamless generated cube map, an image-based-lighting probe derived from it,
 * a star field, celestial bodies, beat-reactive set dressing, and the lighting
 * and fog values that make all of it agree.
 *
 * Layout of the returned `root`:
 *
 *   root
 *   ├── Sky            — rides the camera, rescaled to the camera's far plane
 *   │   ├── Celestial  — sun, planets, rings, structures
 *   │   └── Starfield  — parallaxing shells of instanced points
 *   └── Scenery        — world space, anchored on the track centre
 *
 * The sky group is translated onto the camera every frame and uniformly scaled
 * so its shell always sits at ~90% of the far plane. That keeps distant bodies
 * from ever clipping or parallaxing regardless of what near/far the renderer
 * chooses, while still letting them depth-test correctly against the track.
 *
 * Usage:
 *
 * ```ts
 * const env = createEnvironment({ archetype, palette, seed, quality, trackRadius, trackCentre });
 * scene.add(env.root);
 * scene.background = env.background;
 * scene.environment = env.envMap;
 * scene.fog = new THREE.FogExp2(env.fog.color, env.fog.density);
 *
 * const key = new THREE.DirectionalLight(env.keyLight.color, env.keyLight.intensity);
 * key.position.copy(env.keyLight.direction).multiplyScalar(500);  // direction *to* the light
 * scene.add(key, new THREE.AmbientLight(env.ambient.color, env.ambient.intensity));
 *
 * // once per frame, before render:
 * env.update({ dt, camera, intensity, beatPhase, beatIndex, speed });
 * ```
 */

import { Group, Vector3 } from 'three/webgpu';
import type { EnvironmentArchetype, TrackPalette } from '../../track/types';
import { createCelestial, type Celestial } from './celestial';
import { createScenery, type Scenery } from './scenery';
import { createStarfield, type Starfield } from './starfield';
import {
  buildSkyRecipe,
  generateSky,
  hexToLinear,
  linearToHex,
  luminance,
  mixRGB,
  saturateRGB,
  scaleRGB,
  toLuminance,
  type GeneratedSky,
  type RGB,
  type SkyRecipe,
} from './sky';
import type { BuiltEnvironment, EnvironmentFrameState, EnvironmentOptions } from './types';

export type { BuiltEnvironment, EnvironmentFrameState, EnvironmentOptions } from './types';
export * from './sky';
export * from './starfield';
export * from './celestial';
export * from './scenery';

/** Radius of the sky shell in the sky group's own units, before rescaling. */
const SKY_RADIUS = 1000;
/** Fraction of the camera's far plane the shell is placed at. */
const SKY_FAR_FRACTION = 0.9;

export interface EnvironmentDiagnostics {
  archetype: EnvironmentArchetype;
  /** Cost of generating the cube map, in milliseconds. */
  skyboxMs: number;
  /** Face size of the delivered cube map. */
  skyboxResolution: number;
  /** Texels actually shaded before resampling. */
  skyboxShadedTexels: number;
  starCount: number;
  sceneryInstances: number;
  /** Mean sky luminance — kept well below the track's so the racing line wins. */
  skyLuminance: number;
}

// ---------------------------------------------------------------------------
// Lighting derivation
// ---------------------------------------------------------------------------

interface LightingProfile {
  /** Multiplier on the key light. */
  key: number;
  /** Multiplier on the ambient fill. */
  fill: number;
  /** Multiplier on the fog density derived from the draw distance. */
  fog: number;
  /** How far the fog colour is pulled from `haze` toward the sky's mean, 0..1. */
  fogSky: number;
  /** Saturation applied to the ambient fill. */
  fillSaturation: number;
}

const PROFILES: Record<EnvironmentArchetype, LightingProfile> = {
  // Gas everywhere: a soft key and a generous, coloured fill.
  nebula: { key: 2.6, fill: 0.55, fog: 1.2, fogSky: 0.55, fillSaturation: 1.25 },
  // Hard shadows are the whole point — strong key, almost no fill.
  megastructure: { key: 4.2, fill: 0.16, fog: 0.8, fogSky: 0.35, fillSaturation: 0.55 },
  // Candy: bright key and a saturated bounce so nothing ever goes muddy.
  prismatic: { key: 3.2, fill: 0.7, fog: 0.9, fogSky: 0.6, fillSaturation: 1.5 },
  // Deep black with one brilliant sun.
  starfield: { key: 3.8, fill: 0.14, fog: 0.35, fogSky: 0.25, fillSaturation: 0.8 },
  // Bounced light off a gas giant fills a lot of the shadow side.
  ringworld: { key: 3.0, fill: 0.5, fog: 1.0, fogSky: 0.6, fillSaturation: 1.1 },
  // Almost nothing reaches here.
  void: { key: 1.2, fill: 0.1, fog: 0.55, fogSky: 0.3, fillSaturation: 0.9 },
};

export interface DerivedLighting {
  keyLight: { direction: Vector3; color: number; intensity: number };
  ambient: { color: number; intensity: number };
  fog: { color: number; density: number };
}

/**
 * Chooses lighting from the palette, the archetype and the sky that was
 * actually generated. Pure, so the relationship between a palette and its
 * lighting can be asserted without a renderer.
 *
 * `keyLight.direction` is the unit vector pointing *at* the light, matching the
 * sun in the sky and the terminators on the planets.
 */
export function deriveLighting(
  archetype: EnvironmentArchetype,
  palette: TrackPalette,
  recipe: SkyRecipe,
  skyAverage: RGB,
  drawDistance: number,
): DerivedLighting {
  const profile = PROFILES[archetype];
  const sun = hexToLinear(palette.sun);
  const haze = hexToLinear(palette.haze);
  const deep = hexToLinear(palette.deep);
  const glow = hexToLinear(palette.glow);

  // Key: the palette's sun colour, warmed very slightly toward the nebula glow
  // so the lighting and the sky never look like they came from two artists.
  const keyColor = mixRGB(sun, glow, 0.12);

  // Fill: the sky's own mean colour is the physically honest answer, but it is
  // far too dark to use as an intensity, so its *hue* drives the colour and the
  // archetype drives the level.
  const meanLum = Math.max(1e-4, luminance(skyAverage));
  const fillHue = saturateRGB(toLuminance(skyAverage, 1), profile.fillSaturation);
  const fillColor = mixRGB(fillHue, toLuminance(mixRGB(deep, haze, 0.5), 1), 0.3);
  // Compress the sky's dynamic range: a bright nebula should fill more than a
  // void, but not twenty times more.
  const fillIntensity = profile.fill * (0.45 + Math.min(1.6, Math.sqrt(meanLum / 0.02)) * 0.55);

  // Fog: mostly the palette's haze, tinted by the sky so distant geometry
  // dissolves into the background rather than into a different colour.
  const fogColor = scaleRGB(mixRGB(haze, toLuminance(skyAverage, luminance(haze)), profile.fogSky), 0.55);
  // Chosen so that geometry at the draw distance is ~90% fogged out.
  const density = (1.517 / Math.max(200, drawDistance)) * profile.fog;

  return {
    keyLight: {
      direction: new Vector3(recipe.sunDir[0], recipe.sunDir[1], recipe.sunDir[2]).normalize(),
      color: linearToHex(toLuminance(keyColor, 1)),
      intensity: profile.key,
    },
    ambient: {
      color: linearToHex(fillColor),
      intensity: fillIntensity,
    },
    fog: {
      color: linearToHex(fogColor),
      density,
    },
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function createEnvironment(
  options: EnvironmentOptions,
): BuiltEnvironment & { diagnostics: EnvironmentDiagnostics } {
  const { archetype, palette, seed, quality, trackRadius, trackCentre } = options;

  const recipe = buildSkyRecipe(archetype, palette, seed);
  const sky: GeneratedSky = generateSky(recipe, quality.skyboxResolution);
  const sunDirection = new Vector3(recipe.sunDir[0], recipe.sunDir[1], recipe.sunDir[2]).normalize();

  const root = new Group();
  root.name = `Environment:${archetype}`;

  // --- everything that lives at infinity ---
  const skyGroup = new Group();
  skyGroup.name = 'Sky';
  // Distant bodies must never be culled by the group's own bounds, and they
  // must be drawn before the track so the depth buffer fills front-to-back.
  skyGroup.frustumCulled = false;
  skyGroup.renderOrder = -50;
  root.add(skyGroup);

  const celestial: Celestial = createCelestial({
    archetype,
    palette,
    seed,
    quality,
    sunDirection,
    radius: SKY_RADIUS,
  });
  skyGroup.add(celestial.object);

  const starfield: Starfield = createStarfield({
    archetype,
    palette,
    seed,
    count: quality.starCount,
    radius: SKY_RADIUS,
  });
  skyGroup.add(starfield.object);

  // --- everything anchored to the track ---
  const scenery: Scenery | null = createScenery({
    archetype,
    palette,
    seed,
    quality,
    trackCentre,
    trackRadius,
  });
  if (scenery) root.add(scenery.object);

  const lighting = deriveLighting(archetype, palette, recipe, sky.averageColor, quality.drawDistance);

  // Hoisted state — `update` runs every frame and must not allocate.
  const centre = trackCentre.clone();
  const camPos = new Vector3();
  let lastFar = -1;
  let skyScale = 1;
  let invSkyScale = 1;

  const diagnostics: EnvironmentDiagnostics = {
    archetype,
    skyboxMs: sky.generationMs,
    skyboxResolution: quality.skyboxResolution,
    skyboxShadedTexels: sky.shadedTexels,
    starCount: starfield.starCount,
    sceneryInstances: scenery?.instanceCount ?? 0,
    skyLuminance: luminance(sky.averageColor),
  };

  return {
    root,
    background: sky.background,
    envMap: sky.envMap,
    keyLight: lighting.keyLight,
    ambient: lighting.ambient,
    fog: lighting.fog,
    diagnostics,

    update(state: EnvironmentFrameState): void {
      const camera = state.camera;
      camPos.setFromMatrixPosition(camera.matrixWorld);
      if (camPos.x === 0 && camPos.y === 0 && camPos.z === 0) {
        // matrixWorld has not been composed yet (first frame, or the caller
        // updates matrices after this hook) — the local position is close
        // enough and costs nothing.
        camPos.copy(camera.position);
      }

      // Re-fit the shell whenever the projection changes, not every frame.
      if (camera.far !== lastFar) {
        lastFar = camera.far;
        skyScale = (camera.far * SKY_FAR_FRACTION) / SKY_RADIUS;
        invSkyScale = 1 / skyScale;
        skyGroup.scale.setScalar(skyScale);
      }
      skyGroup.position.copy(camPos);

      starfield.update(camPos, centre, invSkyScale);
      celestial.update(state.dt);
      if (scenery) scenery.update(state);
    },

    dispose(): void {
      if (scenery) {
        scenery.dispose();
        root.remove(scenery.object);
      }
      starfield.dispose();
      celestial.dispose();
      skyGroup.clear();
      root.clear();
      sky.dispose();
    },
  };
}
