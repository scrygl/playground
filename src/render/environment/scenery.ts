/**
 * Track-adjacent set dressing: pylons, monoliths, energy arches, debris fields
 * and distant traffic, all placed in world space around the track's bounds.
 *
 * Three rules shape everything here:
 *
 * 1. One `InstancedMesh` per prop family, so the whole dressing is a handful of
 *    draw calls no matter the density.
 * 2. It pulses on the beat. The pulse is driven entirely by four uniforms
 *    updated once per frame — no per-instance CPU work, no matrix rewrites, no
 *    allocation in `update()`. Instances are dealt into beat lanes so a
 *    different quarter of the field answers each beat: the field breathes with
 *    the music instead of strobing in unison.
 * 3. Per-instance variation rides in an instanced attribute rather than a hash
 *    of `instanceIndex`. That also solves an ordering problem — `NodeMaterial`
 *    applies the instance matrix to `positionLocal` *before* `positionNode`, so
 *    the only way to scale a prop about its own origin instead of the field's
 *    centre is to know where that origin is.
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
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Quaternion,
  TorusGeometry,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  float,
  fract,
  instancedBufferAttribute,
  mix,
  normalWorld,
  positionLocal,
  saturate,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { Rng } from '../../core/rng';
import type { QualitySettings } from '../../core/quality';
import type { EnvironmentArchetype, TrackPalette } from '../../track/types';
import { hexToLinear, mixRGB, saturateRGB, scaleRGB, toLuminance, type RGB } from './sky';

type N = any;

export interface SceneryOptions {
  archetype: EnvironmentArchetype;
  palette: TrackPalette;
  seed: string;
  quality: QualitySettings;
  trackCentre: Vector3;
  trackRadius: number;
}

export interface SceneryFrame {
  dt: number;
  intensity: number;
  beatPhase: number;
  beatIndex: number;
  speed: number;
}

export interface Scenery {
  object: Group;
  /** Total instances across all families — useful for a debug HUD. */
  instanceCount: number;
  update(frame: SceneryFrame): void;
  dispose(): void;
}

export type PropKind = 'pylon' | 'monolith' | 'arch' | 'debris' | 'traffic';

/** One placed prop, resolved before any GPU object exists. */
export interface PropPlacement {
  position: Vector3;
  rotation: Euler;
  scale: Vector3;
  /** Which beat of the bar this instance answers, 0..3. */
  lane: number;
  /** Per-instance random, 0..1. */
  variant: number;
  /** A second decorrelated random, 0..1. */
  variant2: number;
}

export interface FamilyPlan {
  kind: PropKind;
  placements: PropPlacement[];
}

// ---------------------------------------------------------------------------
// Placement (pure and seeded — no GPU objects, so it can be asserted in Node)
// ---------------------------------------------------------------------------

type DensityMix = Record<PropKind, number>;

const MIX: Record<EnvironmentArchetype, DensityMix> = {
  nebula: { pylon: 20, monolith: 9, arch: 5, debris: 90, traffic: 26 },
  megastructure: { pylon: 26, monolith: 18, arch: 3, debris: 130, traffic: 40 },
  prismatic: { pylon: 17, monolith: 4, arch: 11, debris: 70, traffic: 34 },
  starfield: { pylon: 8, monolith: 5, arch: 2, debris: 40, traffic: 10 },
  ringworld: { pylon: 16, monolith: 10, arch: 6, debris: 80, traffic: 22 },
  void: { pylon: 6, monolith: 14, arch: 2, debris: 34, traffic: 4 },
};

export function planScenery(
  archetype: EnvironmentArchetype,
  seed: string,
  density: number,
  trackRadius: number,
): FamilyPlan[] {
  const rng = new Rng(`${seed}:scenery`);
  const weights = MIX[archetype];
  const plans: FamilyPlan[] = [];
  const R = Math.max(1, trackRadius);

  const ring = (count: number, minR: number, maxR: number, minY: number, maxY: number): PropPlacement[] => {
    const out: PropPlacement[] = [];
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, Math.PI * 2);
      // sqrt keeps the annulus evenly covered instead of crowding the inner rim.
      const t = Math.sqrt(rng.next());
      const r = R * (minR + (maxR - minR) * t);
      out.push({
        position: new Vector3(Math.cos(a) * r, R * rng.range(minY, maxY), Math.sin(a) * r),
        rotation: new Euler(0, rng.range(0, Math.PI * 2), 0),
        scale: new Vector3(1, 1, 1),
        lane: rng.int(0, 3),
        variant: rng.next(),
        variant2: rng.next(),
      });
    }
    return out;
  };

  const n = (base: number): number => Math.max(0, Math.round(base * density));

  // Pylons: a colonnade standing just off the racing line, close enough that
  // they strobe past at speed.
  {
    const placements = ring(n(weights.pylon), 1.25, 3.2, -0.34, -0.06);
    for (const p of placements) {
      const h = R * (0.1 + p.variant * 0.26);
      const w = R * (0.02 + p.variant * 0.028);
      p.scale.set(w, h, w);
      p.rotation.set(rng.range(-0.05, 0.05), rng.range(0, Math.PI * 2), rng.range(-0.05, 0.05));
    }
    plans.push({ kind: 'pylon', placements });
  }

  // Monoliths: fewer, much bigger, further out. They give the eye something
  // that barely moves, which is what makes the pylons read as fast.
  {
    const placements = ring(n(weights.monolith), 2.0, 4.2, -0.9, 0.1);
    for (const p of placements) {
      const h = R * (0.5 + p.variant * 1.5);
      const w = h * (0.1 + p.variant2 * 0.16);
      p.scale.set(w, h, w * (0.35 + p.variant2 * 0.65));
      p.rotation.set(rng.range(-0.12, 0.12), rng.range(0, Math.PI * 2), rng.range(-0.12, 0.12));
    }
    plans.push({ kind: 'monolith', placements });
  }

  // Energy arches: half-tori standing on the plane, big enough to fly through.
  {
    const placements = ring(n(weights.arch), 1.05, 1.55, -0.2, 0.05);
    for (const p of placements) {
      const s = R * (0.35 + p.variant * 0.5);
      p.scale.set(s, s, s);
      p.rotation.set(0, rng.range(0, Math.PI * 2), rng.range(-0.16, 0.16));
    }
    plans.push({ kind: 'arch', placements });
  }

  // Debris: a slow drifting cloud filling the volume around the track.
  {
    const placements = ring(n(weights.debris), 1.3, 5.0, -1.3, 1.1);
    for (const p of placements) {
      const s = R * (0.004 + Math.pow(p.variant, 2.5) * 0.055);
      p.scale.set(s, s * (0.55 + p.variant2 * 1.15), s * (0.6 + p.variant2 * 0.9));
      p.rotation.set(rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28));
    }
    plans.push({ kind: 'debris', placements });
  }

  // Distant traffic: bright motes on lanes far above and below, drifting.
  {
    const placements = ring(n(weights.traffic), 3.0, 7.0, -1.8, 1.8);
    for (const p of placements) {
      const s = R * (0.006 + p.variant * 0.012);
      p.scale.set(s, s, s);
    }
    plans.push({ kind: 'traffic', placements });
  }

  return plans;
}

/** Exported for tests: the furthest a prop is placed from the track centre. */
export function sceneryExtent(plans: FamilyPlan[]): number {
  let max = 0;
  for (const plan of plans) {
    for (const p of plan.placements) max = Math.max(max, p.position.length());
  }
  return max;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

interface Palette {
  primary: RGB;
  secondary: RGB;
  deep: RGB;
  glow: RGB;
  sun: RGB;
  haze: RGB;
}

interface StructureColors {
  body: RGB;
  bodyLit: RGB;
  emissive: RGB;
  emissiveAlt: RGB;
  rim: RGB;
}

export function structureColors(archetype: EnvironmentArchetype, p: Palette): StructureColors {
  switch (archetype) {
    case 'megastructure':
      return {
        body: toLuminance(saturateRGB(mixRGB(p.deep, p.haze, 0.5), 0.35), 0.05),
        bodyLit: toLuminance(saturateRGB(p.haze, 0.4), 0.16),
        emissive: toLuminance(saturateRGB(p.primary, 1.05), 0.7),
        emissiveAlt: toLuminance(saturateRGB(p.sun, 0.8), 0.5),
        rim: toLuminance(saturateRGB(p.secondary, 1.1), 0.55),
      };
    case 'prismatic':
      return {
        body: toLuminance(saturateRGB(mixRGB(p.deep, p.secondary, 0.45), 1.1), 0.05),
        bodyLit: toLuminance(saturateRGB(mixRGB(p.primary, p.glow, 0.4), 1.2), 0.22),
        emissive: toLuminance(saturateRGB(p.glow, 1.25), 1.25),
        emissiveAlt: toLuminance(saturateRGB(p.primary, 1.3), 1.05),
        rim: toLuminance(saturateRGB(p.secondary, 1.35), 1.1),
      };
    case 'void':
      return {
        body: toLuminance(saturateRGB(p.deep, 0.6), 0.012),
        bodyLit: toLuminance(saturateRGB(p.deep, 0.7), 0.045),
        emissive: toLuminance(saturateRGB(p.primary, 1.1), 0.45),
        emissiveAlt: toLuminance(saturateRGB(p.secondary, 0.9), 0.32),
        rim: toLuminance(saturateRGB(p.primary, 1.2), 0.45),
      };
    default:
      return {
        body: toLuminance(saturateRGB(mixRGB(p.deep, p.haze, 0.35), 0.8), 0.035),
        bodyLit: toLuminance(saturateRGB(mixRGB(p.haze, p.primary, 0.3), 0.9), 0.14),
        emissive: toLuminance(saturateRGB(p.primary, 1.15), 0.9),
        emissiveAlt: toLuminance(saturateRGB(p.glow, 1.1), 0.75),
        rim: toLuminance(saturateRGB(p.secondary, 1.15), 0.7),
      };
  }
}

function rgbNode(c: RGB): N {
  return vec3(c[0], c[1], c[2]);
}

/**
 * Per-instance beat response. Lane distance is wrapped so lane 3 sits next to
 * lane 0, giving every prop a soft partial answer on the neighbouring beats
 * instead of a binary on/off.
 */
const laneResponse = /*@__PURE__*/ Fn(([lane, current]: N[]): N => {
  const d = lane.sub(current).abs();
  const wrapped = d.min(float(4).sub(d));
  return saturate(float(1).sub(wrapped.mul(0.62))).pow(2);
});

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function createScenery(options: SceneryOptions): Scenery | null {
  const { quality, archetype } = options;
  if (!quality.scenery || quality.sceneryDensity <= 0) return null;

  const plans = planScenery(archetype, options.seed, quality.sceneryDensity, options.trackRadius);
  const totalPlaced = plans.reduce((sum, p) => sum + p.placements.length, 0);
  if (totalPlaced === 0) return null;

  const pal: Palette = {
    primary: hexToLinear(options.palette.primary),
    secondary: hexToLinear(options.palette.secondary),
    deep: hexToLinear(options.palette.deep),
    glow: hexToLinear(options.palette.glow),
    sun: hexToLinear(options.palette.sun),
    haze: hexToLinear(options.palette.haze),
  };
  const colors = structureColors(archetype, pal);

  const root = new Group();
  root.name = 'Scenery';
  root.position.copy(options.trackCentre);

  const uPulse = uniform(0);
  const uLane = uniform(0);
  const uIntensity = uniform(0.5);
  const uSpeed = uniform(0);

  const geometries: N[] = [];
  const materials: N[] = [];
  const meshes: InstancedMesh[] = [];
  const drifters: { object: Group; rate: number }[] = [];

  const tmpMat = new Matrix4();
  const tmpQuat = new Quaternion();

  const byKind = (kind: PropKind): PropPlacement[] =>
    plans.find((p) => p.kind === kind)?.placements ?? [];

  /**
   * Packs the per-instance attributes every family shares:
   * `origin` is the prop's own pivot (so it can be scaled about itself), and
   * `data` is (beat lane, variant, variant2, vertical extent).
   */
  const packInstances = (placements: PropPlacement[]): { origin: N; data: N } => {
    const n = placements.length;
    const origin = new Float32Array(n * 3);
    const data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const p = placements[i];
      origin[i * 3] = p.position.x;
      origin[i * 3 + 1] = p.position.y;
      origin[i * 3 + 2] = p.position.z;
      data[i * 4] = p.lane;
      data[i * 4 + 1] = p.variant;
      data[i * 4 + 2] = p.variant2;
      data[i * 4 + 3] = p.scale.y;
    }
    return {
      origin: instancedBufferAttribute(origin, 'vec3'),
      data: instancedBufferAttribute(data, 'vec4'),
    };
  };

  /** Uniform-ish scale about a prop's own pivot rather than the field centre. */
  const growAbout = (origin: N, factor: N): N => origin.add(positionLocal.sub(origin).mul(factor));

  const addFamily = (
    geometry: N,
    material: N,
    placements: PropPlacement[],
    parent: Group,
    renderOrder = 0,
  ): void => {
    const mesh = new InstancedMesh(geometry, material, placements.length);
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      tmpQuat.setFromEuler(p.rotation);
      tmpMat.compose(p.position, tmpQuat, p.scale);
      mesh.setMatrixAt(i, tmpMat);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.renderOrder = renderOrder;
    // Instances span many track radii; a bounding sphere around the family
    // origin would cull the lot the moment the camera looked off-centre.
    mesh.frustumCulled = false;
    mesh.castShadow = quality.shadows;
    mesh.receiveShadow = quality.shadows;
    parent.add(mesh);
    meshes.push(mesh);
    geometries.push(geometry);
    materials.push(material);
  };

  // --- pylons -------------------------------------------------------------
  const pylons = byKind('pylon');
  if (pylons.length > 0) {
    // Origin at the base, so a beat swells the pylon upward out of the ground.
    const geometry = new CylinderGeometry(0.45, 1, 1, 6, 1, false);
    geometry.translate(0, 0.5, 0);

    const material = new MeshStandardNodeMaterial();
    material.roughness = 0.62;
    material.metalness = 0.35;

    const { origin, data } = packInstances(pylons);
    const hit: N = laneResponse(data.x, uLane).mul(uPulse);
    const vHit: N = varying(hit, 'vPylonHit');
    const vVar: N = varying(data.y, 'vPylonVar');

    const height: N = uv().y;
    // Light strips climbing the shaft, plus a bright cap.
    const strip = saturate(float(1).sub(fract(height.mul(7).add(vVar)).sub(0.5).abs().mul(9)));
    const capGlow = smoothstep(0.82, 1.0, height);
    const swell = vHit.mul(0.75).add(uIntensity.mul(0.2)).add(0.13);

    material.colorNode = mix(rgbNode(colors.body), rgbNode(colors.bodyLit), height.pow(1.6));
    material.emissiveNode = rgbNode(colors.emissive)
      .mul(strip.mul(0.3).add(capGlow.mul(1.1)))
      .mul(swell);
    // Anisotropic swell about the base: taller and slightly narrower on the
    // beat, so it reads as an intake of breath rather than a bounce.
    material.positionNode = origin.add(
      positionLocal
        .sub(origin)
        .mul(vec3(float(1).sub(vHit.mul(0.035)), float(1).add(vHit.mul(0.075)), float(1).sub(vHit.mul(0.035)))),
    );

    addFamily(geometry, material, pylons, root);
  }

  // --- monoliths ----------------------------------------------------------
  const monoliths = byKind('monolith');
  if (monoliths.length > 0) {
    const geometry = new BoxGeometry(1, 1, 1, 1, 3, 1);
    geometry.translate(0, 0.5, 0);

    const material = new MeshStandardNodeMaterial();
    material.roughness = 0.78;
    material.metalness = 0.2;

    const { data } = packInstances(monoliths);
    const hit: N = laneResponse(data.x, uLane).mul(uPulse);
    const vHit: N = varying(hit, 'vMonoHit');
    const vVar: N = varying(data.y, 'vMonoVar');

    // A single seam of light running up one face, like a sealed door.
    const seam: N = saturate(float(1).sub(uv().x.sub(0.5).abs().mul(26)));
    const travel = saturate(float(1).sub(uv().y.sub(fract(time.mul(0.05).add(vVar))).abs().mul(4)));
    const upFace = saturate(normalWorld.y.mul(0.5).add(0.55));

    material.colorNode = mix(
      rgbNode(scaleRGB(colors.body, 0.75)),
      rgbNode(colors.bodyLit),
      uv().y.pow(2).mul(0.55).add(upFace.mul(0.2)),
    );
    material.emissiveNode = rgbNode(colors.rim)
      .mul(seam.mul(travel.mul(0.85).add(0.3)))
      .mul(vHit.mul(1.1).add(0.3));

    addFamily(geometry, material, monoliths, root);
  }

  // --- energy arches ------------------------------------------------------
  const arches = byKind('arch');
  if (arches.length > 0) {
    // A half torus in the XY plane already stands on the ground with the hole
    // facing +Z — exactly the gateway shape, no extra rotation needed.
    const geometry = new TorusGeometry(1, 0.03, 8, 72, Math.PI);
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = AdditiveBlending;
    material.depthWrite = false;
    material.side = DoubleSide;

    const { origin, data } = packInstances(arches);
    const hit: N = laneResponse(data.x, uLane).mul(uPulse);
    const vHit: N = varying(hit, 'vArchHit');
    const vVar: N = varying(data.y, 'vArchVar');

    // A charge running around the arc, plus a flash on the beat.
    const along: N = uv().x;
    const head = fract(time.mul(0.22).add(vVar));
    const chase = saturate(float(1).sub(along.sub(head).abs().mul(6))).pow(2);
    const tube = saturate(float(1).sub(uv().y.sub(0.5).abs().mul(2.4)));
    const glow = tube.mul(chase.mul(0.9).add(0.3)).mul(vHit.mul(1.7).add(0.5));

    material.colorNode = vec4(
      mix(rgbNode(colors.emissive), rgbNode(colors.emissiveAlt), chase),
      glow.mul(uIntensity.mul(0.35).add(0.65)),
    );
    material.positionNode = growAbout(origin, float(1).add(vHit.mul(0.05)));

    addFamily(geometry, material, arches, root, 1);
  }

  // --- debris -------------------------------------------------------------
  const debris = byKind('debris');
  if (debris.length > 0) {
    const geometry = new IcosahedronGeometry(1, 0);
    const material = new MeshStandardNodeMaterial();
    material.roughness = 0.92;
    material.metalness = 0.08;
    material.flatShading = true;

    const { data } = packInstances(debris);
    const vVar: N = varying(data.y, 'vDebrisVar');
    material.colorNode = mix(
      rgbNode(scaleRGB(colors.body, 1.7)),
      rgbNode(colors.bodyLit),
      vVar.mul(0.75).add(saturate(normalWorld.y).mul(0.25)),
    );
    // Only a fraction of the rocks carry a live beacon.
    material.emissiveNode = rgbNode(colors.emissive).mul(
      smoothstep(0.87, 0.96, vVar).mul(uPulse.mul(0.7).add(0.25)),
    );

    // The whole cloud tumbles as one object: one matrix a frame instead of
    // rewriting hundreds of instance transforms.
    const cloud = new Group();
    root.add(cloud);
    drifters.push({ object: cloud, rate: 0.011 });
    addFamily(geometry, material, debris, cloud);
  }

  // --- distant traffic ----------------------------------------------------
  const traffic = byKind('traffic');
  if (traffic.length > 0) {
    const geometry = new IcosahedronGeometry(1, 0);
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.blending = AdditiveBlending;
    material.depthWrite = false;

    const { data } = packInstances(traffic);
    const vVar: N = varying(data.y, 'vTrafficVar');
    const vVar2: N = varying(data.z, 'vTrafficVar2');
    // Navigation lights blinking out of phase with one another, and stretching
    // a touch brighter the faster the player is going.
    const blink = sin(time.mul(vVar2.mul(3).add(1.2)).add(vVar.mul(30))).mul(0.5).add(0.5);
    const tint = mix(rgbNode(colors.emissiveAlt), rgbNode(colors.rim), vVar);
    material.colorNode = vec4(
      tint,
      blink.mul(0.7).add(0.3).mul(uIntensity.mul(0.3).add(0.7)).mul(uSpeed.mul(0.35).add(0.8)),
    );

    const lanes = new Group();
    root.add(lanes);
    drifters.push({ object: lanes, rate: -0.02 });
    addFamily(geometry, material, traffic, lanes, 1);
  }

  return {
    object: root,
    instanceCount: totalPlaced,
    update(frame: SceneryFrame): void {
      // A struck envelope rather than a sine: attack on the beat, exponential
      // decay across it. Closer to a kick drum than a strobe.
      const p = frame.beatPhase < 0 ? 0 : frame.beatPhase > 1 ? 1 : frame.beatPhase;
      uPulse.value = Math.exp(-p * 4.2) * (0.35 + frame.intensity * 0.65);
      uLane.value = ((frame.beatIndex % 4) + 4) % 4;
      uIntensity.value = frame.intensity;
      uSpeed.value = frame.speed;
      for (let i = 0; i < drifters.length; i++) {
        drifters[i].object.rotation.y += drifters[i].rate * frame.dt;
      }
    },
    dispose(): void {
      for (const m of meshes) m.dispose();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      meshes.length = 0;
      geometries.length = 0;
      materials.length = 0;
      drifters.length = 0;
      root.clear();
    },
  };
}
