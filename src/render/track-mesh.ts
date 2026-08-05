import * as THREE from 'three/webgpu';
import {
  color,
  float,
  mix,
  positionWorld,
  cameraPosition,
  smoothstep,
  time,
  uniform,
  uv,
  vec4,
} from 'three/tsl';
import { Vector3 } from 'three';
import type { Track } from '../track/runtime';
import type { TrackPalette } from '../track/types';
import type { QualitySettings } from '../core/quality';

/**
 * Builds the drivable ribbon: surface, structural shell, edge rails and energy
 * barriers.
 *
 * The whole circuit is emitted as a handful of merged meshes rather than being
 * streamed in chunks. A three-kilometre track at high tessellation is only
 * about twenty thousand vertices — far cheaper to draw in four calls than to
 * manage as LOD chunks, and it means the track is visible snaking away into the
 * distance, which is most of what sells the sense of speed.
 *
 * Vertex UVs carry (position across the track 0..1, distance along in metres).
 * Keeping real metres in the V channel is what lets the shaders lock their
 * scrolling energy to the music: a pulse can be placed every N metres and it
 * lands on the beat at racing pace.
 */

/** Vertical thickness of the track slab, in metres. */
const SLAB_THICKNESS = 1.4;
/** Width of the glowing edge rail, in metres. */
const RAIL_WIDTH = 2.2;
/** How far the rail sits above the driving surface. */
const RAIL_LIFT = 0.18;
/** Height of a full-strength containment barrier, in metres. */
const BARRIER_HEIGHT = 7;

/**
 * Live shader inputs, written every frame by the render loop.
 *
 * These are TSL uniform nodes, which already expose a plain `.value`, so the
 * caller assigns numbers and never has to know it is talking to a shader graph.
 */
export interface TrackMeshUniforms {
  /** 0..1 envelope that spikes on each musical beat. */
  beatPulse: { value: number };
  /** 0..1 musical intensity, widening the energy pulses as the race heats up. */
  intensity: { value: number };
  /** The player's distance along the track, so nearby rails burn brighter. */
  playerDistance: { value: number };
  /** 0..1 how hard the player is boosting. */
  boostGlow: { value: number };
}

export interface BuiltTrackMesh {
  group: THREE.Group;
  uniforms: TrackMeshUniforms;
  dispose(): void;
}

interface RingData {
  centre: Vector3;
  right: Vector3;
  up: Vector3;
  halfWidth: number;
  wall: number;
  gap: boolean;
  s: number;
}

function sampleRings(track: Track, segmentLength: number): RingData[] {
  const path = track.path;
  // Ring count is chosen so spacing divides the lap exactly; otherwise the
  // seam gets a short segment and a visible crease.
  const count = Math.max(32, Math.round(path.length / segmentLength));
  const step = path.length / count;
  const rings: RingData[] = [];
  for (let i = 0; i < count; i++) {
    const s = i * step;
    const frame = path.sample(s);
    rings.push({
      centre: frame.position.clone(),
      right: frame.right.clone(),
      up: frame.up.clone(),
      halfWidth: frame.halfWidth,
      wall: frame.wall,
      gap: frame.gap,
      s,
    });
  }
  return rings;
}

/** Contiguous runs of solid surface, so gaps genuinely have no floor. */
function solidSpans(rings: RingData[]): [number, number][] {
  const spans: [number, number][] = [];
  const n = rings.length;
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const solid = i < n ? !rings[i].gap : false;
    if (solid && start < 0) start = i;
    if (!solid && start >= 0) {
      if (i - start > 1) spans.push([start, i - 1]);
      start = -1;
    }
  }
  // Join the final run to the first if the lap starts and ends on solid track.
  if (spans.length > 1 && !rings[0].gap && !rings[n - 1].gap) {
    const first = spans[0];
    const last = spans[spans.length - 1];
    spans.pop();
    spans[0] = [last[0], first[1] + n];
  }
  return spans;
}

export function buildTrackMesh(
  track: Track,
  palette: TrackPalette,
  quality: QualitySettings,
): BuiltTrackMesh {
  const rings = sampleRings(track, quality.trackSegmentLength);
  const spans = solidSpans(rings);
  const n = rings.length;

  const uBeat = floatUniform(0);
  const uIntensity = floatUniform(0.5);
  const uPlayer = floatUniform(0);
  const uBoost = floatUniform(0);
  const uniforms: TrackMeshUniforms = {
    beatPulse: uBeat,
    intensity: uIntensity,
    playerDistance: uPlayer,
    boostGlow: uBoost,
  };

  const group = new THREE.Group();
  group.name = 'track';
  const disposables: { dispose(): void }[] = [];

  // --- Surface ----------------------------------------------------------
  const surfaceGeo = buildSurfaceGeometry(rings, spans, n);
  const surfaceMat = createSurfaceMaterial(palette, uBeat, uIntensity, uBoost);
  const surface = new THREE.Mesh(surfaceGeo, surfaceMat);
  surface.name = 'track-surface';
  surface.frustumCulled = false;
  group.add(surface);
  disposables.push(surfaceGeo, surfaceMat);

  // --- Structural shell (underside and sides) ---------------------------
  const shellGeo = buildShellGeometry(rings, spans, n);
  const shellMat = createShellMaterial(palette);
  const shell = new THREE.Mesh(shellGeo, shellMat);
  shell.name = 'track-shell';
  shell.frustumCulled = false;
  group.add(shell);
  disposables.push(shellGeo, shellMat);

  // --- Edge rails --------------------------------------------------------
  const railGeo = buildRailGeometry(rings, spans, n);
  const railMat = createRailMaterial(palette, uBeat, uPlayer);
  const rails = new THREE.Mesh(railGeo, railMat);
  rails.name = 'track-rails';
  rails.frustumCulled = false;
  group.add(rails);
  disposables.push(railGeo, railMat);

  // --- Containment barriers ---------------------------------------------
  const barrierGeo = buildBarrierGeometry(rings, spans, n);
  if (barrierGeo) {
    const barrierMat = createBarrierMaterial(palette, uBeat);
    const barriers = new THREE.Mesh(barrierGeo, barrierMat);
    barriers.name = 'track-barriers';
    barriers.frustumCulled = false;
    barriers.renderOrder = 2;
    group.add(barriers);
    disposables.push(barrierGeo, barrierMat);
  }

  // --- Start line --------------------------------------------------------
  const startGeo = buildStartLineGeometry(track);
  const startMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const checker = uv().x.mul(14).floor().add(uv().y.mul(2).floor()).mod(2);
  startMat.colorNode = vec4(mix(color(0x101018), color(palette.glow), checker), float(0.92));
  const startLine = new THREE.Mesh(startGeo, startMat);
  startLine.renderOrder = 3;
  group.add(startLine);
  disposables.push(startGeo, startMat);

  return {
    group,
    uniforms,
    dispose() {
      for (const d of disposables) d.dispose();
      group.clear();
    },
  };
}

// --- Geometry ---------------------------------------------------------------

/** Walks a span, calling `emit` for each consecutive pair of rings. */
function forEachSpanPair(
  spans: [number, number][],
  n: number,
  emit: (a: RingData, b: RingData, indexA: number, indexB: number) => void,
  rings: RingData[],
): void {
  for (const [from, to] of spans) {
    for (let i = from; i < to; i++) {
      emit(rings[i % n], rings[(i + 1) % n], i % n, (i + 1) % n);
    }
  }
}

function buildSurfaceGeometry(rings: RingData[], spans: [number, number][], n: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const p = new Vector3();

  forEachSpanPair(
    spans,
    n,
    (a, b) => {
      const base = positions.length / 3;
      for (const ring of [a, b]) {
        for (const side of [-1, 1]) {
          p.copy(ring.centre).addScaledVector(ring.right, side * ring.halfWidth).addScaledVector(ring.up, 0.02);
          positions.push(p.x, p.y, p.z);
          normals.push(ring.up.x, ring.up.y, ring.up.z);
          uvs.push((side + 1) * 0.5, ring.s);
        }
      }
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    },
    rings,
  );

  return toGeometry(positions, normals, uvs, indices);
}

function buildShellGeometry(rings: RingData[], spans: [number, number][], n: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const p = new Vector3();
  const nrm = new Vector3();

  forEachSpanPair(
    spans,
    n,
    (a, b) => {
      // Underside, wound so it faces away from the driving surface.
      let base = positions.length / 3;
      for (const ring of [a, b]) {
        for (const side of [-1, 1]) {
          p.copy(ring.centre)
            .addScaledVector(ring.right, side * ring.halfWidth)
            .addScaledVector(ring.up, -SLAB_THICKNESS);
          positions.push(p.x, p.y, p.z);
          nrm.copy(ring.up).negate();
          normals.push(nrm.x, nrm.y, nrm.z);
          uvs.push((side + 1) * 0.5, ring.s);
        }
      }
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);

      // Two vertical side faces, giving the ribbon real thickness.
      for (const side of [-1, 1]) {
        base = positions.length / 3;
        for (const ring of [a, b]) {
          for (const h of [0.02, -SLAB_THICKNESS]) {
            p.copy(ring.centre).addScaledVector(ring.right, side * ring.halfWidth).addScaledVector(ring.up, h);
            positions.push(p.x, p.y, p.z);
            nrm.copy(ring.right).multiplyScalar(side);
            normals.push(nrm.x, nrm.y, nrm.z);
            uvs.push(h > 0 ? 1 : 0, ring.s);
          }
        }
        if (side < 0) indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        else indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
    },
    rings,
  );

  return toGeometry(positions, normals, uvs, indices);
}

function buildRailGeometry(rings: RingData[], spans: [number, number][], n: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const p = new Vector3();

  forEachSpanPair(
    spans,
    n,
    (a, b) => {
      for (const side of [-1, 1]) {
        const base = positions.length / 3;
        for (const ring of [a, b]) {
          const outer = ring.halfWidth;
          const inner = ring.halfWidth - RAIL_WIDTH;
          for (const [offset, u] of [
            [inner, 0],
            [outer, 1],
          ] as const) {
            p.copy(ring.centre).addScaledVector(ring.right, side * offset).addScaledVector(ring.up, RAIL_LIFT);
            positions.push(p.x, p.y, p.z);
            normals.push(ring.up.x, ring.up.y, ring.up.z);
            uvs.push(u, ring.s);
          }
        }
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    },
    rings,
  );

  return toGeometry(positions, normals, uvs, indices);
}

function buildBarrierGeometry(
  rings: RingData[],
  spans: [number, number][],
  n: number,
): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const p = new Vector3();
  const nrm = new Vector3();
  let emitted = 0;

  forEachSpanPair(
    spans,
    n,
    (a, b) => {
      // Skip stretches with no guardrail at all — that absence is the whole
      // point of a Rainbow-Road section and must be visible from a distance.
      if (a.wall < 0.12 && b.wall < 0.12) return;
      for (const side of [-1, 1]) {
        const base = positions.length / 3;
        for (const ring of [a, b]) {
          const height = BARRIER_HEIGHT * ring.wall;
          for (const [h, v] of [
            [RAIL_LIFT, 0],
            [RAIL_LIFT + height, 1],
          ] as const) {
            p.copy(ring.centre).addScaledVector(ring.right, side * ring.halfWidth).addScaledVector(ring.up, h);
            positions.push(p.x, p.y, p.z);
            nrm.copy(ring.right).multiplyScalar(-side);
            normals.push(nrm.x, nrm.y, nrm.z);
            // U carries height up the barrier; V carries distance along.
            uvs.push(v, ring.s);
          }
        }
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        emitted++;
      }
    },
    rings,
  );

  if (emitted === 0) return null;
  return toGeometry(positions, normals, uvs, indices);
}

function buildStartLineGeometry(track: Track): THREE.BufferGeometry {
  const path = track.path;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const p = new Vector3();
  const DEPTH = 7;

  for (let i = 0; i <= 1; i++) {
    const s = path.wrap(i * DEPTH - DEPTH * 0.5);
    const frame = path.sample(s);
    for (const side of [-1, 1]) {
      p.copy(frame.position)
        .addScaledVector(frame.right, side * (frame.halfWidth - RAIL_WIDTH))
        .addScaledVector(frame.up, 0.06);
      positions.push(p.x, p.y, p.z);
      normals.push(frame.up.x, frame.up.y, frame.up.z);
      uvs.push((side + 1) * 0.5, i);
    }
  }
  indices.push(0, 1, 2, 1, 3, 2);
  return toGeometry(positions, normals, uvs, indices);
}

function toGeometry(
  positions: number[],
  normals: number[],
  uvs: number[],
  indices: number[],
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

// --- Materials --------------------------------------------------------------

/**
 * `uniform` is heavily overloaded, and `ReturnType<typeof uniform>` silently
 * resolves to the last overload — an untyped `UniformNode<unknown, unknown>`
 * with no arithmetic methods on it. Going through a concrete helper keeps the
 * real node type, so `.mul()` and friends stay available.
 */
function floatUniform(value: number) {
  return uniform(value, 'float');
}
type UniformNode = ReturnType<typeof floatUniform>;

function createSurfaceMaterial(
  palette: TrackPalette,
  uBeat: UniformNode,
  uIntensity: UniformNode,
  uBoost: UniformNode,
): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  const across = uv().x;
  const along = uv().y;
  // 0 at the centre line, 1 at either barrier.
  const side = across.sub(0.5).mul(2).abs();

  // Lateral rungs every few metres. These are the main cue for how fast the
  // surface is passing underneath, so they need to be legible without being
  // bright enough to compete with the rails.
  const grid = along.mul(0.14).fract();
  const rungs = smoothstep(0.955, 1.0, grid).mul(0.3);

  // Lane guides either side of the racing line.
  const lane = smoothstep(0.02, 0.0, side.sub(0.34).abs()).mul(0.35);
  const centre = smoothstep(0.035, 0.0, side).mul(0.55);

  // Energy pulses running along the track, locked to the beat grid so they
  // arrive in time with the music rather than at an arbitrary rate.
  const wave = along.mul(0.012).add(time.mul(0.55)).fract();
  const pulse = smoothstep(0.86, 1.0, wave).mul(uIntensity.mul(0.6).add(0.3));

  // Bright shoulder just inside the barrier, which is what the eye actually
  // tracks when reading a corner at three hundred miles an hour.
  const shoulder = smoothstep(0.72, 0.99, side);

  const emissiveAmount = rungs.add(lane).add(centre).add(pulse).add(shoulder.mul(1.4));
  const beatBoost = uBeat.mul(0.55).add(1);

  const tint = mix(color(palette.primary), color(palette.secondary), side.mul(0.7));
  mat.colorNode = mix(color(palette.deep), color(0x11151f), side.oneMinus().mul(0.4));
  mat.emissiveNode = tint.mul(emissiveAmount).mul(beatBoost).mul(uBoost.mul(0.6).add(1));
  mat.roughnessNode = float(0.34).sub(shoulder.mul(0.18));
  mat.metalnessNode = float(0.72);

  // Fade the very furthest track into the haze so the horizon never ends in a
  // hard edge against the sky.
  const distance = positionWorld.sub(cameraPosition).length();
  mat.opacityNode = smoothstep(2600, 1400, distance).mul(0.25).add(0.75);
  mat.transparent = true;
  mat.side = THREE.DoubleSide;
  return mat;
}

function createShellMaterial(palette: TrackPalette): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  const along = uv().y;
  const ribs = smoothstep(0.9, 1.0, along.mul(0.08).fract()).mul(0.7);
  mat.colorNode = color(0x0a0c12);
  mat.emissiveNode = color(palette.secondary).mul(ribs).mul(0.5);
  mat.roughnessNode = float(0.62);
  mat.metalnessNode = float(0.85);
  mat.side = THREE.DoubleSide;
  return mat;
}

function createRailMaterial(
  palette: TrackPalette,
  uBeat: UniformNode,
  uPlayer: UniformNode,
): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  const across = uv().x;
  const along = uv().y;

  // Chevrons streaming toward the player, the classic readability cue.
  const stream = along.mul(0.06).sub(time.mul(1.4)).fract();
  const chevron = smoothstep(0.55, 1.0, stream);
  // Brightest at the outer lip of the rail.
  const profile = smoothstep(0.1, 1.0, across);

  // Highlight the rail near the player so the immediate corner reads hottest.
  const proximity = smoothstep(320, 0, along.sub(uPlayer).abs()).mul(0.5).add(0.6);

  const glow = chevron.mul(0.7).add(0.55).mul(profile).mul(proximity).mul(uBeat.mul(0.4).add(1));
  mat.colorNode = vec4(mix(color(palette.primary), color(palette.glow), chevron).mul(glow.mul(2.4)), float(1));
  mat.side = THREE.DoubleSide;
  return mat;
}

function createBarrierMaterial(palette: TrackPalette, uBeat: UniformNode): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const up = uv().x;
  const along = uv().y;

  // Two interfering diagonal stripe fields read as a lattice without the cost
  // or the aliasing of an actual texture. Kept coarse: a fine mesh at this
  // scale shimmers badly once the craft is moving.
  const a = smoothstep(0.9, 1.0, along.mul(0.13).add(up.mul(1.1)).fract());
  const b = smoothstep(0.9, 1.0, along.mul(0.13).sub(up.mul(1.1)).fract());
  const lattice = a.add(b).clamp(0, 1);

  // A barrier's job is to say "the track ends here", not to wall the player
  // into a corridor. It is brightest in the first metre or so above the rail
  // and has largely dissolved by the top, so corner exits stay readable and
  // the eye is never pulled off the racing line.
  const fade = smoothstep(0.75, 0.0, up);
  const base = smoothstep(0.18, 0.0, up).mul(0.5);
  const scan = smoothstep(0.93, 1.0, along.mul(0.02).sub(time.mul(0.35)).fract()).mul(0.35);

  const alpha = lattice.mul(0.16).add(scan).add(base).add(0.05).mul(fade).mul(0.9);
  const tint = mix(color(palette.secondary), color(palette.glow), lattice.mul(0.6));
  mat.colorNode = vec4(tint.mul(uBeat.mul(0.35).add(1)), alpha);
  mat.side = THREE.DoubleSide;
  return mat;
}
