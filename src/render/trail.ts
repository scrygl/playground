import * as THREE from 'three/webgpu';
import { color, mix, smoothstep, uniform, uv, vec4 } from 'three/tsl';
import type { Object3D, Quaternion, Vector3 } from 'three';
import type { QualitySettings } from '../core/quality';

/**
 * Engine trail ribbons.
 *
 * A rolling history of nozzle positions is turned into a camera-facing ribbon.
 * The whole thing is one `BufferGeometry` allocated at construction and
 * rewritten in place every frame — no allocation, no geometry churn, one draw
 * call for both nozzles.
 *
 * Two things make a trail feel right rather than merely present. First,
 * samples are emitted on a fixed *time* interval, not per frame: the ribbon's
 * world length then follows the craft's speed for free, stretching down a
 * straight and shrinking to a stub in a hairpin, and it looks identical at 30
 * and 144 fps. Second, a respawn must never draw a streak across the level, so
 * any implausible jump between samples collapses the history onto the new
 * position instead of interpolating through it.
 */

/** Seconds between history samples at rest. Ribbon duration = this × segments. */
const BASE_INTERVAL = 0.011;
/** Samples emitted in a single frame after a long stall, at most. */
const MAX_CATCHUP = 4;
/** A gap larger than this between consecutive samples is a teleport, in metres. */
const TELEPORT_DISTANCE = 22;

/** Default nozzle positions, matching the twin nacelles in `ship-mesh`. */
const DEFAULT_EMITTERS: readonly [number, number, number][] = [
  [-2.16, -0.14, 4.35],
  [2.16, -0.14, 4.35],
];

export interface TrailOptions {
  quality: QualitySettings;
  /** Engine colour. The ribbon runs white at the nozzle and cools to this. */
  color: number;
  /** Nozzle positions in ship-local space. Defaults to the twin nacelles. */
  emitters?: readonly (readonly [number, number, number])[];
  /** Ribbon half-width at the nozzle, in metres. */
  width?: number;
}

/** Per-frame inputs. Written by the render loop; never allocated. */
export interface TrailState {
  dt: number;
  position: Vector3;
  quaternion: Quaternion;
  /** 0..1 against the craft's top speed. Fades the ribbon out when slow. */
  speedFraction: number;
  /** 0..1 boost, which lengthens and brightens the ribbon. */
  boost: number;
  /** World-space camera position; the ribbon turns to face it. */
  cameraPosition: Vector3;
}

export interface ShipTrail {
  object: Object3D;
  update(state: TrailState): void;
  /**
   * Discards the history. Call on respawn or any other teleport — the trail
   * also detects these itself, but calling is exact and free.
   */
  reset(): void;
  dispose(): void;
  /** Number of history samples. Zero means the trail is disabled entirely. */
  readonly segments: number;
}

/**
 * The rolling position history, kept separate from anything graphical so the
 * bookkeeping — and specifically the teleport rule — can be tested in Node.
 *
 * Ages are addressed from the head: `read(0)` is the newest sample. Reading
 * past the number of samples actually recorded clamps to the oldest one, which
 * makes a partially-filled buffer collapse into a point rather than smear
 * through uninitialised memory.
 */
export class TrailBuffer {
  readonly data: Float32Array;
  /** Index of the newest sample in the ring. */
  private head = 0;
  /** How many samples are valid, never more than `capacity`. */
  private count = 0;
  /** Incremented every time a teleport was detected and swallowed. */
  teleports = 0;

  constructor(
    readonly capacity: number,
    readonly strands: number,
    readonly teleportDistance = TELEPORT_DISTANCE,
  ) {
    this.data = new Float32Array(Math.max(1, capacity) * strands * 3);
  }

  get filled(): number {
    return this.count;
  }

  /**
   * Records one sample of every strand. `points` is a flat xyz triple per
   * strand. Returns false when the sample was judged a teleport, in which case
   * the history was collapsed onto it instead of extended.
   */
  push(points: ArrayLike<number>): boolean {
    if (this.count > 0 && this.jumped(points)) {
      this.collapse(points);
      this.teleports++;
      return false;
    }
    this.head = (this.head + 1) % this.capacity;
    this.write(this.head, points);
    if (this.count < this.capacity) this.count++;
    return true;
  }

  /** True when the first strand moved implausibly far since the last sample. */
  private jumped(points: ArrayLike<number>): boolean {
    const o = this.head * this.strands * 3;
    const dx = points[0] - this.data[o];
    const dy = points[1] - this.data[o + 1];
    const dz = points[2] - this.data[o + 2];
    const limit = this.teleportDistance;
    return dx * dx + dy * dy + dz * dz > limit * limit;
  }

  /** Drops every sample and restarts the history at `points`. */
  collapse(points: ArrayLike<number>): void {
    for (let i = 0; i < this.capacity; i++) this.write(i, points);
    this.head = 0;
    this.count = 1;
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
    this.data.fill(0);
  }

  private write(slot: number, points: ArrayLike<number>): void {
    const o = slot * this.strands * 3;
    for (let i = 0; i < this.strands * 3; i++) this.data[o + i] = points[i];
  }

  /** Offset into `data` of the sample `age` steps behind the head. */
  offset(age: number, strand: number): number {
    const clamped = Math.min(Math.max(age, 0), Math.max(0, this.count - 1));
    const slot = (((this.head - clamped) % this.capacity) + this.capacity) % this.capacity;
    return (slot * this.strands + strand) * 3;
  }
}

function floatUniform(value: number) {
  return uniform(value, 'float');
}

function createTrailMaterial(tint: number, uStrength: ReturnType<typeof floatUniform>, uBoost: ReturnType<typeof floatUniform>): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  mat.blending = THREE.AdditiveBlending;
  mat.side = THREE.DoubleSide;

  const across = uv().x;
  const age = uv().y;

  // Soft shoulders across the ribbon, so it never shows a hard polygon edge.
  const profile = smoothstep(1.0, 0.05, across.mul(2).sub(1).abs());
  // Hot core down the middle of the ribbon, which is what sells it as plasma
  // rather than a painted stripe.
  const core = smoothstep(0.55, 0.0, across.mul(2).sub(1).abs());
  const fade = age.oneMinus().pow(1.7);

  const hot = mix(color(tint), color(0xffffff), fade.pow(2.5).mul(0.85));
  const brightness = uBoost.mul(2.4).add(1.1);
  mat.colorNode = vec4(
    hot.mul(profile.add(core.mul(1.6))).mul(brightness),
    fade.mul(profile).mul(uStrength).clamp(0, 1).mul(0.9),
  );
  return mat;
}

const _emitterWorld = new THREE.Vector3();
const _prevPoint = new THREE.Vector3();
const _nextPoint = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _view = new THREE.Vector3();
const _side = new THREE.Vector3();
const _here = new THREE.Vector3();

export function createShipTrail(options: TrailOptions): ShipTrail {
  const group = new THREE.Group();
  group.name = 'ship-trail';

  const segments = Math.max(0, Math.floor(options.quality.trailLength));
  const emitters = options.emitters ?? DEFAULT_EMITTERS;
  const strands = emitters.length;
  const halfWidth = options.width ?? 0.42;

  // A quality tier with no trail budget gets a real no-op: an empty group whose
  // update does nothing at all, rather than a hidden mesh still being walked.
  if (segments < 2 || strands === 0) {
    return {
      object: group,
      segments: 0,
      update: () => {},
      reset: () => {},
      dispose: () => {
        group.clear();
      },
    };
  }

  const buffer = new TrailBuffer(segments, strands);
  const vertexCount = segments * 2 * strands;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices: number[] = [];

  for (let e = 0; e < strands; e++) {
    for (let i = 0; i < segments; i++) {
      const v = i / (segments - 1);
      const base = (e * segments + i) * 2;
      uvs[base * 2] = 0;
      uvs[base * 2 + 1] = v;
      uvs[base * 2 + 2] = 1;
      uvs[base * 2 + 3] = v;
      if (i < segments - 1) {
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);

  const uStrength = floatUniform(0);
  const uBoost = floatUniform(0);
  const material = createTrailMaterial(options.color, uStrength, uBoost);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ship-trail-ribbon';
  // The ribbon's bounds change every frame and it is never large on screen;
  // skipping the cull is cheaper than maintaining a bounding sphere.
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  group.add(mesh);

  // Working set for one emission, allocated once.
  const sample = new Float32Array(strands * 3);
  const previousSample = new Float32Array(strands * 3);
  const interpolated = new Float32Array(strands * 3);
  let accumulator = 0;
  let strength = 0;
  let primed = false;

  /** Writes the current world-space nozzle positions into `sample`. */
  function readEmitters(state: TrailState): void {
    for (let e = 0; e < strands; e++) {
      const local = emitters[e];
      _emitterWorld.set(local[0], local[1], local[2]).applyQuaternion(state.quaternion).add(state.position);
      sample[e * 3] = _emitterWorld.x;
      sample[e * 3 + 1] = _emitterWorld.y;
      sample[e * 3 + 2] = _emitterWorld.z;
    }
  }

  function writeRibbon(state: TrailState, width: number): void {
    const filled = buffer.filled;
    for (let e = 0; e < strands; e++) {
      for (let i = 0; i < segments; i++) {
        const o = buffer.offset(i, e);
        _here.set(buffer.data[o], buffer.data[o + 1], buffer.data[o + 2]);

        // Tangent from the neighbouring samples, clamped at both ends.
        const op = buffer.offset(Math.max(0, i - 1), e);
        const on = buffer.offset(Math.min(segments - 1, i + 1), e);
        _prevPoint.set(buffer.data[op], buffer.data[op + 1], buffer.data[op + 2]);
        _nextPoint.set(buffer.data[on], buffer.data[on + 1], buffer.data[on + 2]);
        _tangent.subVectors(_prevPoint, _nextPoint);
        if (_tangent.lengthSq() < 1e-8) _tangent.set(0, 0, 1);
        _tangent.normalize();

        _view.subVectors(_here, state.cameraPosition);
        if (_view.lengthSq() < 1e-8) _view.set(0, 0, 1);
        _side.crossVectors(_tangent, _view);
        if (_side.lengthSq() < 1e-8) _side.set(1, 0, 0);
        _side.normalize();

        // Taper along the ribbon, and collapse entirely until enough samples
        // exist for the shape to mean anything.
        const age = i / (segments - 1);
        const taper = Math.pow(1 - age, 0.55) * (i < filled ? 1 : 0);
        _side.multiplyScalar(width * taper);

        const base = ((e * segments + i) * 2) * 3;
        positions[base] = _here.x - _side.x;
        positions[base + 1] = _here.y - _side.y;
        positions[base + 2] = _here.z - _side.z;
        positions[base + 3] = _here.x + _side.x;
        positions[base + 4] = _here.y + _side.y;
        positions[base + 5] = _here.z + _side.z;
      }
    }
    positionAttribute.needsUpdate = true;
  }

  function update(state: TrailState): void {
    const dt = state.dt > 0 ? Math.min(state.dt, 0.1) : 0;
    readEmitters(state);

    if (!primed) {
      buffer.collapse(sample);
      previousSample.set(sample);
      primed = true;
    }

    // Emit on a fixed clock so the ribbon's length tracks speed, not framerate.
    // Boost stretches the spacing, which is what makes a boost visibly *long*.
    const interval = BASE_INTERVAL * (1 + state.boost * 0.7);
    accumulator += dt;
    let emitted = 0;
    while (accumulator >= interval && emitted < MAX_CATCHUP) {
      accumulator -= interval;
      emitted++;
      // Interpolate back to where the craft was when this sample was due.
      const f = dt > 0 ? Math.min(1, 1 - accumulator / dt) : 1;
      for (let i = 0; i < strands * 3; i++) {
        interpolated[i] = previousSample[i] + (sample[i] - previousSample[i]) * f;
      }
      if (!buffer.push(interpolated)) {
        // Teleported: history is now a single point. Fade back in from zero so
        // the first frames after a respawn do not flash a full-length ribbon.
        strength = 0;
      }
    }
    if (emitted >= MAX_CATCHUP) accumulator = 0;
    previousSample.set(sample);

    // Fade the ribbon with speed and let it fill in after a reset.
    const target = Math.min(1, state.speedFraction * 2.4) * (0.55 + state.boost * 0.45);
    const fill = Math.min(1, buffer.filled / Math.max(2, segments * 0.35));
    strength += (target * fill - strength) * Math.min(1, dt * 6);
    uStrength.value = strength;
    uBoost.value = state.boost;

    writeRibbon(state, halfWidth * (1 + state.boost * 0.75 + state.speedFraction * 0.2));
  }

  function reset(): void {
    buffer.clear();
    primed = false;
    strength = 0;
    accumulator = 0;
    positions.fill(0);
    positionAttribute.needsUpdate = true;
  }

  return {
    object: group,
    segments,
    update,
    reset,
    dispose() {
      geometry.dispose();
      material.dispose();
      group.clear();
    },
  };
}
