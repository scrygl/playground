import * as THREE from 'three/webgpu';
import { attribute, color, mix, smoothstep, uv, vec2, vec3, vec4 } from 'three/tsl';
import type { Object3D, Vector3 } from 'three';
import type { QualitySettings } from '../core/quality';
import { Rng } from '../core/rng';

/**
 * Pooled particle system for everything that sparks, bursts or scatters.
 *
 * Every effect class owns one preallocated pool and draws in exactly one call.
 * Particles are kept *packed*: the live ones always occupy `[0, count)` of the
 * typed arrays, and a death is a swap with the last live particle. That makes
 * the draw range a single integer, keeps the GPU upload contiguous, and means
 * the update path never allocates, never sorts and never touches a free list.
 *
 * Quads are billboarded on the GPU by `SpriteNodeMaterial`, whose vertex stage
 * takes the particle centre from an instanced attribute — so the CPU only ever
 * writes positions and colours, never orientations. That path compiles on both
 * the WebGPU and WebGL2 backends; `THREE.Points` does not, because WebGPU has
 * no point size.
 *
 * The particle object holds **world-space** positions and must therefore be
 * added directly to the scene, not under a transformed parent.
 */

export type ParticleEffect = 'engine' | 'scrape' | 'boost' | 'dust' | 'debris';

/**
 * How the fixed budget is shared out. Engine trails run continuously so they
 * get the largest slice; debris is bursty but has to look violent when it goes.
 */
const EFFECT_WEIGHTS: Record<ParticleEffect, number> = {
  engine: 0.3,
  scrape: 0.16,
  boost: 0.18,
  dust: 0.14,
  debris: 0.22,
};

/** Soft blobs versus hard sparks — the two sprite looks the game needs. */
const EFFECT_SHAPE: Record<ParticleEffect, 'spark' | 'soft'> = {
  engine: 'spark',
  scrape: 'spark',
  boost: 'soft',
  dust: 'soft',
  debris: 'spark',
};

const EFFECT_ORDER: ParticleEffect[] = ['engine', 'scrape', 'boost', 'dust', 'debris'];

export interface ParticleSystemOptions {
  quality: QualitySettings;
  /** Seed for the spawn jitter, so a replay scatters identically. */
  seed?: string;
}

/**
 * One emission request. Reuse a single object per call site — nothing here is
 * retained after `emit` returns.
 */
export interface EmitParams {
  position: Vector3;
  /** Mean direction of travel. Defaults to straight up. */
  direction?: Vector3;
  /** Particles requested. Clamped to whatever the pool has spare. */
  count?: number;
  speed?: number;
  /** Fractional variation applied to `speed`. */
  speedSpread?: number;
  /** 0 is a tight beam along `direction`, 1 is a full sphere. */
  spread?: number;
  color?: number;
  /** Second colour; each particle lands somewhere between the two. */
  colorEnd?: number;
  size?: number;
  sizeEnd?: number;
  life?: number;
  lifeSpread?: number;
  /** Metres per second squared along world -Y. */
  gravity?: number;
  /** Velocity lost per second, as a fraction. */
  drag?: number;
  /** Velocity to add to every particle — usually the emitter's own. */
  inherit?: Vector3;
  inheritScale?: number;
}

export interface ParticleSystem {
  object: Object3D;
  /** Total particles across all pools. Zero when the tier has no budget. */
  readonly budget: number;
  /** Live particles this frame. */
  readonly active: number;
  /** Capacity of one effect's pool. */
  capacityOf(effect: ParticleEffect): number;
  /** Live particles in one effect's pool. */
  activeOf(effect: ParticleEffect): number;
  /** Spawns particles. Returns how many were actually created. */
  emit(effect: ParticleEffect, params: EmitParams): number;
  /**
   * Spawns at a rate rather than a count, carrying the fractional remainder
   * stochastically so a 12-per-second emitter still works at 144 fps.
   */
  emitRate(effect: ParticleEffect, params: EmitParams, perSecond: number, dt: number): number;
  update(dt: number): void;
  /** Kills everything immediately — use on a race restart. */
  clear(): void;
  dispose(): void;
}

// --- Pool -------------------------------------------------------------------

interface Pool {
  effect: ParticleEffect;
  capacity: number;
  count: number;
  /** Packed live-particle state. Doubles as the instanced attribute storage. */
  position: Float32Array;
  tint: Float32Array;
  /** (size, alpha, rotation, unused) per particle. */
  packed: Float32Array;
  velocity: Float32Array;
  life: Float32Array;
  lifespan: Float32Array;
  sizeStart: Float32Array;
  sizeEnd: Float32Array;
  spin: Float32Array;
  drag: Float32Array;
  gravity: Float32Array;
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.SpriteNodeMaterial;
  mesh: THREE.Mesh;
  positionAttribute: THREE.InstancedBufferAttribute;
  tintAttribute: THREE.InstancedBufferAttribute;
  packedAttribute: THREE.InstancedBufferAttribute;
}

function createSpriteMaterial(shape: 'spark' | 'soft'): THREE.SpriteNodeMaterial {
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  mat.blending = THREE.AdditiveBlending;

  const iPos = attribute<'vec3'>('iPos', 'vec3');
  const iTint = attribute<'vec3'>('iTint', 'vec3');
  const iPacked = attribute<'vec4'>('iPacked', 'vec4');

  mat.positionNode = iPos;
  mat.scaleNode = vec2(iPacked.x, iPacked.x);
  mat.rotationNode = iPacked.z;

  const radius = uv().sub(vec2(0.5, 0.5)).length().mul(2).clamp(0, 1);
  let mask;
  if (shape === 'spark') {
    // A tight hot core with a short halo: this is what a spark looks like once
    // bloom gets hold of it. A plain gaussian just reads as fog.
    const core = smoothstep(0.34, 0.0, radius).pow(1.4);
    const halo = smoothstep(1.0, 0.0, radius).pow(2.6);
    mask = core.mul(1.4).add(halo.mul(0.45));
  } else {
    mask = smoothstep(1.0, 0.0, radius).pow(1.9);
  }

  const alpha = iPacked.y;
  // Particles wash out to white as they are born and cool to their tint.
  const hot = mix(vec3(iTint), color(0xffffff), alpha.pow(3).mul(0.55));
  mat.colorNode = vec4(hot.mul(mask).mul(1.9), mask.mul(alpha).clamp(0, 1));
  return mat;
}

function createPool(effect: ParticleEffect, capacity: number, quad: THREE.PlaneGeometry): Pool {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute('position', quad.getAttribute('position'));
  geometry.setAttribute('uv', quad.getAttribute('uv'));
  geometry.instanceCount = 0;

  const position = new Float32Array(capacity * 3);
  const tint = new Float32Array(capacity * 3);
  const packed = new Float32Array(capacity * 4);

  const positionAttribute = new THREE.InstancedBufferAttribute(position, 3);
  const tintAttribute = new THREE.InstancedBufferAttribute(tint, 3);
  const packedAttribute = new THREE.InstancedBufferAttribute(packed, 4);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  tintAttribute.setUsage(THREE.DynamicDrawUsage);
  packedAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('iPos', positionAttribute);
  geometry.setAttribute('iTint', tintAttribute);
  geometry.setAttribute('iPacked', packedAttribute);

  const material = createSpriteMaterial(EFFECT_SHAPE[effect]);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `particles-${effect}`;
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;

  return {
    effect,
    capacity,
    count: 0,
    position,
    tint,
    packed,
    velocity: new Float32Array(capacity * 3),
    life: new Float32Array(capacity),
    lifespan: new Float32Array(capacity),
    sizeStart: new Float32Array(capacity),
    sizeEnd: new Float32Array(capacity),
    spin: new Float32Array(capacity),
    drag: new Float32Array(capacity),
    gravity: new Float32Array(capacity),
    geometry,
    material,
    mesh,
    positionAttribute,
    tintAttribute,
    packedAttribute,
  };
}

/** Moves the last live particle into `slot`, so the pool stays packed. */
function swapRemove(pool: Pool, slot: number): void {
  const last = pool.count - 1;
  if (slot !== last) {
    copy3(pool.position, last, slot);
    copy3(pool.tint, last, slot);
    copy3(pool.velocity, last, slot);
    for (let i = 0; i < 4; i++) pool.packed[slot * 4 + i] = pool.packed[last * 4 + i];
    pool.life[slot] = pool.life[last];
    pool.lifespan[slot] = pool.lifespan[last];
    pool.sizeStart[slot] = pool.sizeStart[last];
    pool.sizeEnd[slot] = pool.sizeEnd[last];
    pool.spin[slot] = pool.spin[last];
    pool.drag[slot] = pool.drag[last];
    pool.gravity[slot] = pool.gravity[last];
  }
  pool.count = last;
}

function copy3(array: Float32Array, from: number, to: number): void {
  array[to * 3] = array[from * 3];
  array[to * 3 + 1] = array[from * 3 + 1];
  array[to * 3 + 2] = array[from * 3 + 2];
}

// --- System -----------------------------------------------------------------

const _dir = new THREE.Vector3();
const _jitter = new THREE.Vector3();
const _colorA = new THREE.Color();
const _colorB = new THREE.Color();

export function createParticleSystem(options: ParticleSystemOptions): ParticleSystem {
  const group = new THREE.Group();
  group.name = 'particles';
  const budget = Math.max(0, Math.floor(options.quality.particleBudget));
  const rng = new Rng(options.seed ?? 'particles');

  // A tier with no budget gets a genuine no-op: no geometry, no materials, no
  // per-frame work at all beyond an early return.
  if (budget === 0) {
    return {
      object: group,
      budget: 0,
      get active() {
        return 0;
      },
      capacityOf: () => 0,
      activeOf: () => 0,
      emit: () => 0,
      emitRate: () => 0,
      update: () => {},
      clear: () => {},
      dispose: () => {
        group.clear();
      },
    };
  }

  const quad = new THREE.PlaneGeometry(1, 1);
  const pools = new Map<ParticleEffect, Pool>();
  let allocated = 0;
  for (const effect of EFFECT_ORDER) {
    const capacity = Math.max(8, Math.floor(budget * EFFECT_WEIGHTS[effect]));
    const pool = createPool(effect, capacity, quad);
    pools.set(effect, pool);
    group.add(pool.mesh);
    allocated += capacity;
  }

  function spawn(pool: Pool, params: EmitParams, requested: number): number {
    const spare = pool.capacity - pool.count;
    const n = Math.min(requested, spare);
    if (n <= 0) return 0;

    const speed = params.speed ?? 6;
    const spread = params.spread ?? 0.3;
    const speedSpread = params.speedSpread ?? 0.4;
    const life = params.life ?? 0.6;
    const lifeSpread = params.lifeSpread ?? 0.35;
    const size = params.size ?? 0.35;
    const sizeEnd = params.sizeEnd ?? size * 0.2;
    const drag = params.drag ?? 1.6;
    const gravity = params.gravity ?? 0;
    const inheritScale = params.inheritScale ?? 1;

    _colorA.setHex(params.color ?? 0xffffff);
    _colorB.setHex(params.colorEnd ?? params.color ?? 0xffffff);

    if (params.direction) _dir.copy(params.direction).normalize();
    else _dir.set(0, 1, 0);

    for (let k = 0; k < n; k++) {
      const i = pool.count++;
      const o3 = i * 3;
      const o4 = i * 4;

      pool.position[o3] = params.position.x;
      pool.position[o3 + 1] = params.position.y;
      pool.position[o3 + 2] = params.position.z;

      // Uniform point on a sphere, then blended toward the mean direction.
      const z = rng.range(-1, 1);
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const phi = rng.range(0, Math.PI * 2);
      _jitter.set(Math.cos(phi) * r, Math.sin(phi) * r, z);
      _jitter.lerp(_dir, 1 - spread);
      if (_jitter.lengthSq() < 1e-6) _jitter.copy(_dir);
      _jitter.normalize();

      const v = speed * (1 + rng.range(-speedSpread, speedSpread));
      pool.velocity[o3] = _jitter.x * v;
      pool.velocity[o3 + 1] = _jitter.y * v;
      pool.velocity[o3 + 2] = _jitter.z * v;
      if (params.inherit) {
        pool.velocity[o3] += params.inherit.x * inheritScale;
        pool.velocity[o3 + 1] += params.inherit.y * inheritScale;
        pool.velocity[o3 + 2] += params.inherit.z * inheritScale;
      }

      const mixT = rng.next();
      pool.tint[o3] = _colorA.r + (_colorB.r - _colorA.r) * mixT;
      pool.tint[o3 + 1] = _colorA.g + (_colorB.g - _colorA.g) * mixT;
      pool.tint[o3 + 2] = _colorA.b + (_colorB.b - _colorA.b) * mixT;

      const span = Math.max(0.02, life * (1 + rng.range(-lifeSpread, lifeSpread)));
      pool.life[i] = span;
      pool.lifespan[i] = span;
      pool.sizeStart[i] = size * (1 + rng.range(-0.3, 0.3));
      pool.sizeEnd[i] = sizeEnd;
      pool.spin[i] = rng.range(-4, 4);
      pool.drag[i] = drag;
      pool.gravity[i] = gravity;

      pool.packed[o4] = pool.sizeStart[i];
      pool.packed[o4 + 1] = 1;
      pool.packed[o4 + 2] = rng.range(0, Math.PI * 2);
      pool.packed[o4 + 3] = 0;
    }
    return n;
  }

  function update(dt: number): void {
    if (dt <= 0) return;
    const step = Math.min(dt, 0.1);
    for (const pool of pools.values()) {
      let i = 0;
      while (i < pool.count) {
        pool.life[i] -= step;
        if (pool.life[i] <= 0) {
          swapRemove(pool, i);
          continue;
        }
        const o3 = i * 3;
        const o4 = i * 4;
        const damping = Math.max(0, 1 - pool.drag[i] * step);
        pool.velocity[o3] *= damping;
        pool.velocity[o3 + 1] = pool.velocity[o3 + 1] * damping - pool.gravity[i] * step;
        pool.velocity[o3 + 2] *= damping;
        pool.position[o3] += pool.velocity[o3] * step;
        pool.position[o3 + 1] += pool.velocity[o3 + 1] * step;
        pool.position[o3 + 2] += pool.velocity[o3 + 2] * step;

        const remaining = pool.life[i] / pool.lifespan[i];
        pool.packed[o4] = pool.sizeEnd[i] + (pool.sizeStart[i] - pool.sizeEnd[i]) * remaining;
        // Fade in fast, out slow: a particle that appears at full brightness
        // pops, and one that fades linearly looks like it is being switched off.
        pool.packed[o4 + 1] = remaining * remaining * Math.min(1, (1 - remaining) * 12 + 0.25);
        pool.packed[o4 + 2] += pool.spin[i] * step;
        i++;
      }

      pool.geometry.instanceCount = pool.count;
      if (pool.count > 0) {
        pool.positionAttribute.needsUpdate = true;
        pool.tintAttribute.needsUpdate = true;
        pool.packedAttribute.needsUpdate = true;
      }
    }
  }

  return {
    object: group,
    budget: allocated,
    get active() {
      let total = 0;
      for (const pool of pools.values()) total += pool.count;
      return total;
    },
    capacityOf: (effect) => pools.get(effect)?.capacity ?? 0,
    activeOf: (effect) => pools.get(effect)?.count ?? 0,
    emit(effect, params) {
      const pool = pools.get(effect);
      if (!pool) return 0;
      return spawn(pool, params, Math.max(0, Math.floor(params.count ?? 8)));
    },
    emitRate(effect, params, perSecond, dt) {
      const pool = pools.get(effect);
      if (!pool || dt <= 0) return 0;
      const exact = perSecond * Math.min(dt, 0.1);
      let n = Math.floor(exact);
      if (rng.next() < exact - n) n++;
      return n > 0 ? spawn(pool, params, n) : 0;
    },
    update,
    clear() {
      for (const pool of pools.values()) {
        pool.count = 0;
        pool.geometry.instanceCount = 0;
      }
    },
    dispose() {
      for (const pool of pools.values()) {
        pool.geometry.dispose();
        pool.material.dispose();
      }
      quad.dispose();
      pools.clear();
      group.clear();
    },
  };
}

// --- Presets ----------------------------------------------------------------
//
// The race loop should not have to know what a landing plume costs in metres
// per second. These wrap `emit` with numbers that have been looked at.

const _params: EmitParams = { position: new THREE.Vector3() };

function preset(position: Vector3): EmitParams {
  const p = _params;
  p.position = position;
  p.direction = undefined;
  p.count = undefined;
  p.speed = undefined;
  p.speedSpread = undefined;
  p.spread = undefined;
  p.color = undefined;
  p.colorEnd = undefined;
  p.size = undefined;
  p.sizeEnd = undefined;
  p.life = undefined;
  p.lifeSpread = undefined;
  p.gravity = undefined;
  p.drag = undefined;
  p.inherit = undefined;
  p.inheritScale = undefined;
  return p;
}

/** Continuous exhaust sparks. Call every frame with the craft's own velocity. */
export function emitEngineSparks(
  system: ParticleSystem,
  position: Vector3,
  backward: Vector3,
  velocity: Vector3,
  tint: number,
  intensity: number,
  dt: number,
): number {
  const p = preset(position);
  p.direction = backward;
  p.speed = 9 + intensity * 26;
  p.speedSpread = 0.5;
  p.spread = 0.16;
  p.color = tint;
  p.colorEnd = 0xffffff;
  p.size = 0.3 + intensity * 0.35;
  p.sizeEnd = 0.02;
  p.life = 0.22 + intensity * 0.2;
  p.drag = 2.6;
  p.inherit = velocity;
  p.inheritScale = 0.45;
  return system.emitRate('engine', p, 40 + intensity * 190, dt);
}

/** Sparks off a barrier. `normal` points away from the wall. */
export function emitWallSparks(
  system: ParticleSystem,
  position: Vector3,
  normal: Vector3,
  velocity: Vector3,
  dt: number,
): number {
  const p = preset(position);
  p.direction = normal;
  p.speed = 16;
  p.speedSpread = 0.7;
  p.spread = 0.55;
  p.color = 0xffd07a;
  p.colorEnd = 0xff5a20;
  p.size = 0.18;
  p.sizeEnd = 0.01;
  p.life = 0.45;
  p.drag = 1.1;
  p.gravity = 14;
  p.inherit = velocity;
  p.inheritScale = 0.3;
  return system.emitRate('scrape', p, 220, dt);
}

/** One-shot bloom off a boost pad, thrown forward along the craft's heading. */
export function emitBoostBurst(
  system: ParticleSystem,
  position: Vector3,
  forward: Vector3,
  tint: number,
): number {
  const p = preset(position);
  p.direction = forward;
  p.count = 46;
  p.speed = 26;
  p.speedSpread = 0.6;
  p.spread = 0.5;
  p.color = tint;
  p.colorEnd = 0xffffff;
  p.size = 1.5;
  p.sizeEnd = 0.1;
  p.life = 0.65;
  p.drag = 2.4;
  return system.emit('boost', p);
}

/** Dust kicked up on touchdown. `up` is the track's surface normal. */
export function emitLandingDust(
  system: ParticleSystem,
  position: Vector3,
  up: Vector3,
  impact: number,
  tint: number,
): number {
  const p = preset(position);
  p.direction = up;
  p.count = Math.round(10 + impact * 34);
  p.speed = 5 + impact * 9;
  p.speedSpread = 0.6;
  p.spread = 0.85;
  p.color = tint;
  p.colorEnd = 0x384a66;
  p.size = 1.5 + impact * 1.8;
  p.sizeEnd = 3.2;
  p.life = 0.85;
  p.drag = 3.2;
  return system.emit('dust', p);
}

/** Craft destruction: a fast white flash of shards followed by cooling embers. */
export function emitExplosion(system: ParticleSystem, position: Vector3, tint: number): number {
  const p = preset(position);
  p.count = 90;
  p.speed = 34;
  p.speedSpread = 0.75;
  p.spread = 1;
  p.color = 0xffffff;
  p.colorEnd = tint;
  p.size = 0.85;
  p.sizeEnd = 0.05;
  p.life = 1.1;
  p.lifeSpread = 0.6;
  p.drag = 1.4;
  p.gravity = 9;
  let n = system.emit('debris', p);

  const q = preset(position);
  q.count = 26;
  q.speed = 9;
  q.spread = 1;
  q.color = tint;
  q.colorEnd = 0xffffff;
  q.size = 4;
  q.sizeEnd = 9;
  q.life = 0.5;
  q.drag = 3;
  n += system.emit('boost', q);
  return n;
}
