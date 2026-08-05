import * as THREE from 'three/webgpu';
import { attribute, color, float, mix, positionLocal, smoothstep, time, uniform, uv, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Track } from '../track/runtime';
import type { FeatureKind, TrackFeature } from '../track/types';
import type { FeatureVisualOptions, FeatureVisuals, FeatureVisualState } from './types';

/**
 * Everything the track carries: boost pads, rhythm gates, pickups, hazards and
 * checkpoints.
 *
 * Each kind is a single `InstancedMesh` — or two, where an additive layer is
 * needed — so the whole circuit's furniture costs about seven draw calls no
 * matter how many features a track places. Per-instance state (which beat a
 * gate belongs to, how far along the track it sits, whether a pickup has been
 * taken) rides in one instanced `vec4`, and the animation is done entirely in
 * the shader from four uniforms. The CPU only writes that vec4 when a timer is
 * actually running.
 *
 * The rhythm gates are the game's signature, so they are worth describing.
 * Each gate knows which beat of the bar it belongs to. From the musical clock
 * the shader derives how long until *its* beat arrives and drives three things
 * off it: a telegraph ring that closes from the arch's rim to its centre and
 * lands exactly on the beat, a crown of four pips at the top of the arch that
 * count the bar out like a metronome, and a full white flash on the beat
 * itself. Because a run of gates is spaced one beat apart at racing pace, that
 * flash marches away down the track in time with the music — the track tells
 * you the rhythm before you have heard a bar of it.
 */

/** Height above the surface for each kind, in metres. */
const BOOST_LIFT = 0.16;
const PICKUP_LIFT = 3.2;
const HAZARD_LIFT = 2.2;

/** Boost pads are a fixed length regardless of how wide the feature is. */
const BOOST_HALF_LENGTH = 7.5;
/** How wide a beat gate may get, in metres of radius. */
const GATE_MIN_RADIUS = 8;
const GATE_MAX_RADIUS = 22;
/**
 * Fraction of the gate radius the arch centre sits above the surface. At 0.55
 * the ring meets the track exactly at its own springing points, so the arch
 * looks built into the circuit rather than dropped on top of it.
 */
const GATE_CENTRE = 0.55;
/** Seconds a gate's hit animation runs for. */
const GATE_HIT_SECONDS = 0.85;
/** Beats in a bar — the gate crown has one pip per beat. */
const BAR_BEATS = 4;

const CHECKPOINT_HEIGHT = 13;

// --- Geometry assembly ------------------------------------------------------

/**
 * Merges several primitives into one geometry, tagging each with a part index
 * so a single material can shade them differently. Merging is what keeps a
 * pickup (gem plus orbiting ring) to one draw call and one instance matrix.
 */
class PartBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly parts: number[] = [];
  private readonly indices: number[] = [];

  add(source: THREE.BufferGeometry, matrix: THREE.Matrix4 | null, part: number): this {
    const geo = matrix ? source.clone().applyMatrix4(matrix) : source;
    const pos = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    const tex = geo.getAttribute('uv');
    const index = geo.getIndex();
    const base = this.positions.length / 3;

    for (let i = 0; i < pos.count; i++) {
      this.positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (nrm) this.normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      else this.normals.push(0, 1, 0);
      if (tex) this.uvs.push(tex.getX(i), tex.getY(i));
      else this.uvs.push(0, 0);
      this.parts.push(part);
    }
    if (index) {
      for (let i = 0; i < index.count; i++) this.indices.push(base + index.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) this.indices.push(base + i);
    }
    if (matrix) geo.dispose();
    return this;
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geo.setAttribute('aPart', new THREE.Float32BufferAttribute(this.parts, 1));
    geo.setIndex(this.indices);
    geo.computeBoundingSphere();
    return geo;
  }
}

/** Flat pad lying in the XZ plane, spanning [-1, 1] on both axes. */
function buildPadGeometry(): THREE.BufferGeometry {
  const plane = new THREE.PlaneGeometry(2, 2, 1, 1);
  plane.rotateX(-Math.PI * 0.5);
  plane.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(plane.attributes.position.count), 1));
  return plane;
}

/**
 * The arch: a partial torus of unit radius, trimmed to the arc that stands
 * above the track and rotated so both ends land on the surface, plus a crown
 * of four beat pips.
 */
function buildGateGeometry(): THREE.BufferGeometry {
  // Where the ring crosses the surface plane, given the centre height.
  const springing = Math.asin(-GATE_CENTRE);
  const arc = Math.PI - springing * 2;
  const torus = new THREE.TorusGeometry(1, 0.052, 8, 96, arc);
  torus.rotateZ(springing);

  const builder = new PartBuilder();
  builder.add(torus, null, 0);
  torus.dispose();

  // Inner lip: a second, thinner ring just inside the arch. Two concentric
  // lines read as a manufactured object; one reads as a wireframe.
  const lip = new THREE.TorusGeometry(0.9, 0.016, 6, 80, arc);
  lip.rotateZ(springing);
  builder.add(lip, null, 5);
  lip.dispose();

  const pip = new THREE.BoxGeometry(0.1, 0.21, 0.15);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < BAR_BEATS; i++) {
    // A crown across the top of the arch, read left to right in track order.
    const angle = Math.PI * (0.72 - i * 0.148);
    pos.set(Math.cos(angle) * 1.12, Math.sin(angle) * 1.12, 0);
    e.set(0, 0, angle);
    m.compose(pos, q.setFromEuler(e), one);
    builder.add(pip, m, i + 1);
  }
  pip.dispose();
  return builder.build();
}

/** The energy membrane filling the arch. */
function buildMembraneGeometry(): THREE.BufferGeometry {
  const disc = new THREE.CircleGeometry(1, 64);
  disc.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(disc.attributes.position.count), 1));
  return disc;
}

/** Faceted gem inside a pair of orbiting rings. */
function buildPickupGeometry(kind: 'shield' | 'weapon' | 'hazard'): THREE.BufferGeometry {
  const builder = new PartBuilder();
  const m = new THREE.Matrix4();

  if (kind === 'weapon') {
    // An eight-pointed star: two octahedra out of phase. Reads as aggressive
    // from any angle, unlike a tetrahedron, which shows one flat face and
    // stops looking like an object at all.
    const gem = new THREE.OctahedronGeometry(1, 0);
    m.makeScale(0.85, 1.15, 0.85);
    builder.add(gem, m, 0);
    m.makeRotationY(Math.PI * 0.25).multiply(new THREE.Matrix4().makeScale(0.72, 0.72, 0.72));
    builder.add(gem, m, 0);
    gem.dispose();
  } else if (kind === 'hazard') {
    const core = new THREE.IcosahedronGeometry(0.9, 0);
    builder.add(core, null, 0);
    core.dispose();
    const spike = new THREE.ConeGeometry(0.22, 0.9, 5);
    for (const [axis, rot] of [
      [new THREE.Vector3(0, 1.1, 0), 0],
      [new THREE.Vector3(0, -1.1, 0), Math.PI],
      [new THREE.Vector3(1.1, 0, 0), -Math.PI * 0.5],
      [new THREE.Vector3(-1.1, 0, 0), Math.PI * 0.5],
    ] as const) {
      m.makeRotationZ(rot).setPosition(axis);
      builder.add(spike, m, 0);
    }
    spike.dispose();
  } else {
    const gem = new THREE.OctahedronGeometry(1, 0);
    m.makeScale(0.9, 1.3, 0.9);
    builder.add(gem, m, 0);
    gem.dispose();
  }

  const ring = new THREE.TorusGeometry(1.45, 0.055, 6, 40);
  m.makeRotationX(Math.PI * 0.5);
  builder.add(ring, m, 1);
  m.makeRotationX(Math.PI * 0.5).premultiply(new THREE.Matrix4().makeRotationZ(Math.PI * 0.35));
  builder.add(ring, m, 2);
  ring.dispose();
  return builder.build();
}

/**
 * Checkpoint gate: two slim posts and a lintel, in unit space spanning
 * x in [-1, 1] and y in [0, 1]. Deliberately plain — it exists to be read at a
 * glance and then ignored.
 */
function buildCheckpointGeometry(): THREE.BufferGeometry {
  const builder = new PartBuilder();
  const post = new THREE.BoxGeometry(0.05, 1, 0.05);
  const m = new THREE.Matrix4();
  for (const side of [-1, 1]) {
    m.makeTranslation(side, 0.5, 0);
    builder.add(post, m, 0);
  }
  post.dispose();
  const lintel = new THREE.BoxGeometry(2.06, 0.06, 0.05);
  m.makeTranslation(0, 0.98, 0);
  builder.add(lintel, m, 1);
  lintel.dispose();
  return builder.build();
}

// --- Placement --------------------------------------------------------------

const _position = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _forward = new THREE.Vector3();
const _matrix = new THREE.Matrix4();

/**
 * Resolves a feature into a world transform.
 *
 * The instance's axes match the craft's: +X across the track to the right, +Y
 * along the surface normal, -Z down the direction of travel. Exported so that
 * placement can be checked against the path in a test with no renderer.
 */
export function featureAnchor(
  track: Track,
  feature: TrackFeature,
  height: number,
  outPosition: THREE.Vector3,
  outQuaternion: THREE.Quaternion,
): void {
  const path = track.path;
  const frame = path.sample(feature.s);
  path.toWorld(feature.s, feature.lateral * frame.halfWidth, height, outPosition);
  _basis.makeBasis(frame.right, frame.up, _forward.copy(frame.tangent).negate());
  outQuaternion.setFromRotationMatrix(_basis);
}

/** Radius of the arch a gate feature asks for, clamped to something flyable. */
export function gateRadius(feature: TrackFeature, halfWidth: number): number {
  return Math.min(GATE_MAX_RADIUS, Math.max(GATE_MIN_RADIUS, feature.size * halfWidth));
}

// --- Shader plumbing --------------------------------------------------------

function floatUniform(value: number) {
  return uniform(value, 'float');
}
type FloatUniform = ReturnType<typeof floatUniform>;

interface FeatureUniforms {
  beatPhase: FloatUniform;
  beatIndex: FloatUniform;
  player: FloatUniform;
  intensity: FloatUniform;
  trackLength: FloatUniform;
}

function stateAttribute() {
  return attribute<'vec4'>('iState', 'vec4');
}
function centreAttribute() {
  return attribute<'vec3'>('iCentre', 'vec3');
}
function partAttribute() {
  return attribute<'float'>('aPart', 'float');
}

/**
 * A plain float in the shader graph. Naming the type once keeps the helpers
 * below readable — the concrete node classes TSL returns differ per call site
 * but they all satisfy this.
 */
type FloatNode = Node<'float'>;

/** Wrap-aware distance from this instance to the player, in metres. */
function proximity(u: FeatureUniforms, s: FloatNode, near: number, far: number) {
  const raw = s.sub(u.player).abs();
  const wrapped = raw.min(u.trackLength.sub(raw));
  return smoothstep(far, near, wrapped);
}

/**
 * Where this instance sits in the bar. Returns 0 exactly when the gate's own
 * beat lands and climbs to 1 over the following bar.
 */
function barPhase(u: FeatureUniforms, beat: FloatNode) {
  return u.beatIndex.sub(beat).add(u.beatPhase).div(BAR_BEATS).fract();
}

function createBoostMaterial(options: FeatureVisualOptions, u: FeatureUniforms): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  mat.blending = THREE.AdditiveBlending;
  mat.side = THREE.DoubleSide;
  const st = stateAttribute();
  const across = uv().x;
  const along = uv().y;

  // Offsetting the band phase by the distance from the centre line is what
  // turns stripes into chevrons; the scroll direction is the way you drive.
  const bend = across.sub(0.5).abs().mul(2.4);
  const band = along.mul(4).add(bend).sub(time.mul(1.9)).fract();
  const chevron = smoothstep(0.55, 0.88, band).mul(smoothstep(1.0, 0.92, band));

  // Feather every edge so the pad melts into the surface instead of sitting
  // on it as a rectangle.
  const edge = smoothstep(0.0, 0.14, across)
    .mul(smoothstep(1.0, 0.86, across))
    .mul(smoothstep(0.0, 0.1, along))
    .mul(smoothstep(1.0, 0.9, along));

  const beat = barPhase(u, float(0));
  const pulse = smoothstep(0.25, 0.0, beat).mul(0.5).add(1);
  const prox = proximity(u, st.x, 20, 420).mul(0.4).add(0.7);

  const tint = mix(color(options.palette.primary), color(options.palette.glow), chevron.pow(2));
  const amount = chevron.mul(1.1).add(0.12).mul(edge).mul(pulse).mul(prox);
  mat.colorNode = vec4(tint.mul(amount).mul(1.1), amount.clamp(0, 1).mul(0.8));
  return mat;
}

function createGateMaterial(options: FeatureVisualOptions, u: FeatureUniforms): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  const st = stateAttribute();
  const centre = centreAttribute();
  const part = partAttribute();

  const hit = st.w.abs();
  const perfect = st.w.max(0);
  const g = barPhase(u, st.y);

  // On its own beat the whole arch goes white; the beat before, it charges.
  const onBeat = smoothstep(0.16, 0.0, g);
  const charge = smoothstep(0.6, 1.0, g);
  const prox = proximity(u, st.x, 15, 500);

  // A hit punches the arch outward from its own centre. `iCentre` is what makes
  // that possible: the instance transform is already baked into positionLocal
  // by the time a positionNode runs, so the pivot has to travel with the data.
  mat.positionNode = centre.add(positionLocal.sub(centre).mul(hit.mul(0.14).add(1)));

  const isRing = smoothstep(0.5, 0.0, part);
  const isLip = smoothstep(4.5, 5.0, part);
  const pipIndex = part.sub(1);
  // Which pip the bar is on right now, and which one this gate wants.
  const currentBeat = u.beatIndex.add(u.beatPhase).mod(BAR_BEATS);
  const pipLive = smoothstep(0.55, 0.0, currentBeat.sub(pipIndex).abs()).mul(smoothstep(0.5, 1.5, part)).mul(smoothstep(4.5, 3.5, part));
  const pipOwn = smoothstep(0.4, 0.0, st.y.sub(pipIndex).abs()).mul(smoothstep(0.5, 1.5, part)).mul(smoothstep(4.5, 3.5, part));

  // Energy running around the arch, accelerating as the beat approaches.
  const flow = uv().x.mul(5).sub(time.mul(0.5)).sub(charge.mul(0.6)).fract();
  const runner = smoothstep(0.72, 1.0, flow);

  const cool = mix(color(options.palette.primary), color(options.palette.glow), runner);
  const hot = mix(color(0xffffff), color(0xffd76a), perfect);
  const tint = mix(cool, hot, hit.max(onBeat.mul(0.8)).clamp(0, 1));

  const ringAmount = runner
    .mul(0.4)
    .add(0.3)
    .add(onBeat.mul(1.5))
    .add(charge.mul(0.35))
    .add(hit.mul(2))
    .mul(prox.mul(0.6).add(0.5));
  // The crown is always legible; the pip for the current beat blows out, the
  // pip this gate wants sits half-lit, the rest stay as dark markers.
  const pipAmount = pipLive.mul(3).add(pipOwn.mul(1.2)).add(0.3).add(hit.mul(1.5));

  const emissive = tint.mul(
    isRing
      .mul(ringAmount)
      .add(isLip.mul(ringAmount.mul(1.6)))
      .add(pipAmount)
      .mul(u.intensity.mul(0.4).add(0.8)),
  );

  mat.colorNode = color(0x0a0d16);
  mat.emissiveNode = emissive;
  mat.metalnessNode = float(0.85);
  mat.roughnessNode = float(0.3);
  return mat;
}

function createMembraneMaterial(options: FeatureVisualOptions, u: FeatureUniforms): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  mat.blending = THREE.AdditiveBlending;
  mat.side = THREE.DoubleSide;
  const st = stateAttribute();

  const hit = st.w.abs();
  const perfect = st.w.max(0);
  const g = barPhase(u, st.y);
  const toBeat = g.oneMinus();
  const onBeat = smoothstep(0.18, 0.0, g);
  const prox = proximity(u, st.x, 15, 460);

  const r = uv().sub(0.5).length().mul(2);

  // The telegraph: an annulus closing from the rim to the centre, arriving
  // exactly on this gate's beat. Two beats of warning is enough to aim by and
  // short enough that a run of gates never has more than two ringing at once.
  const closing = toBeat.mul(BAR_BEATS * 0.5).clamp(0, 1);
  const telegraph = smoothstep(0.13, 0.0, r.sub(closing).abs()).mul(smoothstep(1.02, 0.9, closing));

  // Hit shockwave, racing outward past the rim.
  const wave = hit.oneMinus().mul(1.7);
  const shock = smoothstep(0.16, 0.0, r.sub(wave).abs()).mul(hit);

  // Resting state: a faint pane with a soft edge, so the arch always reads as
  // something you pass *through* rather than an empty hoop.
  const pane = r.pow(2.4).mul(0.16).add(0.05);
  const rim = smoothstep(0.7, 0.99, r).mul(smoothstep(1.01, 0.97, r));
  const wash = r.oneMinus().pow(1.6).mul(onBeat.mul(0.55).add(hit.mul(0.8)));

  const tint = mix(color(options.palette.primary), mix(color(0xffffff), color(0xffd76a), perfect), hit.max(onBeat.mul(0.6)));
  const amount = telegraph
    .mul(1.1)
    .add(shock.mul(1.2))
    .add(rim.mul(0.35))
    .add(pane)
    .add(wash)
    .mul(prox.mul(0.6).add(0.4));
  mat.colorNode = vec4(tint.mul(amount).mul(1.5), amount.clamp(0, 1).mul(0.7));
  return mat;
}

function createPickupMaterial(
  options: FeatureVisualOptions,
  u: FeatureUniforms,
  gemColor: number,
): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: true });
  const st = stateAttribute();
  const part = partAttribute();
  const fade = st.z;

  const isRing = smoothstep(0.5, 1.0, part);
  const beat = barPhase(u, float(0));
  const pulse = smoothstep(0.3, 0.0, beat).mul(0.6).add(1);
  const prox = proximity(u, st.x, 12, 320).mul(0.5).add(0.7);

  const tint = mix(color(gemColor), color(options.palette.glow), isRing);
  mat.colorNode = mix(color(gemColor).mul(0.35), color(0x0b0f18), isRing);
  mat.emissiveNode = tint.mul(isRing.mul(0.35).add(0.4)).mul(pulse).mul(prox).mul(fade.pow(0.6));
  mat.metalnessNode = float(0.55);
  mat.roughnessNode = float(0.3);
  mat.envMapIntensity = 0.25;
  mat.opacityNode = fade.clamp(0, 1);
  return mat;
}

function createCheckpointMaterial(options: FeatureVisualOptions, u: FeatureUniforms): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  mat.blending = THREE.AdditiveBlending;
  const st = stateAttribute();
  const part = partAttribute();
  // Bright only when you are nearly on it, and never bright enough to compete
  // with a gate.
  const prox = proximity(u, st.x, 8, 220);
  const lintel = smoothstep(0.5, 1.0, part);
  const tint = mix(color(options.palette.secondary), color(options.palette.glow), lintel);
  const amount = prox.mul(0.8).add(0.14).mul(lintel.mul(0.6).add(0.7));
  mat.colorNode = vec4(tint.mul(amount).mul(1.5), amount.clamp(0, 1).mul(0.8));
  return mat;
}

// --- Buckets ----------------------------------------------------------------

interface Bucket {
  kind: FeatureKind;
  count: number;
  /** Global index in `track.features` for each instance. */
  features: Int32Array;
  /** (s, beat, fade, hit) per instance. */
  state: Float32Array;
  stateAttribute: THREE.InstancedBufferAttribute;
  centreAttribute: THREE.InstancedBufferAttribute | null;
  meshes: THREE.InstancedMesh[];
  /** Base transforms, so a spinning pickup can be recomposed each frame. */
  basePosition: Float32Array;
  baseQuaternion: Float32Array;
  baseScale: Float32Array;
  /** Seconds until a consumed pickup returns; negative when it is present. */
  respawn: Float32Array;
  /** Seconds left of a gate's hit animation. */
  hitTimer: Float32Array;
  hitSign: Float32Array;
  /** Radians per second of idle spin. Zero for anything bolted down. */
  spin: number;
  bobHeight: number;
  dirty: boolean;
}

const KIND_ORDER: FeatureKind[] = ['checkpoint', 'boost', 'shield', 'weapon', 'hazard', 'beatgate'];

export function createFeatureVisuals(track: Track, options: FeatureVisualOptions): FeatureVisuals {
  const root = new THREE.Group();
  root.name = 'track-features';

  const u: FeatureUniforms = {
    beatPhase: floatUniform(0),
    beatIndex: floatUniform(0),
    player: floatUniform(0),
    intensity: floatUniform(0.5),
    trackLength: floatUniform(track.path.length),
  };

  const disposables: { dispose(): void }[] = [];
  const buckets = new Map<FeatureKind, Bucket>();
  /** Global feature index → (kind, instance). -1 means the feature has no visual. */
  const slotKind = new Int8Array(track.features.length).fill(-1);
  const slotIndex = new Int32Array(track.features.length).fill(-1);

  for (let k = 0; k < KIND_ORDER.length; k++) {
    const kind = KIND_ORDER[k];
    const members: number[] = [];
    for (let i = 0; i < track.features.length; i++) {
      if (track.features[i].kind === kind) members.push(i);
    }
    if (members.length === 0) continue;

    const count = members.length;
    const state = new Float32Array(count * 4);
    const centre = new Float32Array(count * 3);
    const stateAttr = new THREE.InstancedBufferAttribute(state, 4);
    stateAttr.setUsage(THREE.DynamicDrawUsage);
    const centreAttr = kind === 'beatgate' ? new THREE.InstancedBufferAttribute(centre, 3) : null;

    const bucket: Bucket = {
      kind,
      count,
      features: Int32Array.from(members),
      state,
      stateAttribute: stateAttr,
      centreAttribute: centreAttr,
      meshes: [],
      basePosition: new Float32Array(count * 3),
      baseQuaternion: new Float32Array(count * 4),
      baseScale: new Float32Array(count * 3),
      respawn: new Float32Array(count).fill(-1),
      hitTimer: new Float32Array(count),
      hitSign: new Float32Array(count).fill(1),
      spin: kind === 'shield' || kind === 'weapon' || kind === 'hazard' ? 1.1 : 0,
      bobHeight: kind === 'shield' || kind === 'weapon' ? 0.6 : 0,
      dirty: true,
    };

    // --- Geometry and materials for this kind ---------------------------
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    switch (kind) {
      case 'boost':
        geometries.push(buildPadGeometry());
        materials.push(createBoostMaterial(options, u));
        break;
      case 'beatgate':
        geometries.push(buildGateGeometry(), buildMembraneGeometry());
        materials.push(createGateMaterial(options, u), createMembraneMaterial(options, u));
        break;
      case 'shield':
        geometries.push(buildPickupGeometry('shield'));
        materials.push(createPickupMaterial(options, u, 0x6cf0c4));
        break;
      case 'weapon':
        geometries.push(buildPickupGeometry('weapon'));
        materials.push(createPickupMaterial(options, u, 0xff7a4a));
        break;
      case 'hazard':
        geometries.push(buildPickupGeometry('hazard'));
        materials.push(createPickupMaterial(options, u, 0xff2f4a));
        break;
      case 'checkpoint':
        geometries.push(buildCheckpointGeometry());
        materials.push(createCheckpointMaterial(options, u));
        break;
    }

    for (let g = 0; g < geometries.length; g++) {
      const geo = geometries[g];
      // Sharing one attribute object across geometries means one GPU buffer
      // and one upload for the whole kind.
      geo.setAttribute('iState', stateAttr);
      if (centreAttr) geo.setAttribute('iCentre', centreAttr);
      const mesh = new THREE.InstancedMesh(geo, materials[g], count);
      mesh.name = `feature-${kind}-${g}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = kind === 'boost' ? 1 : g === 1 ? 5 : 0;
      bucket.meshes.push(mesh);
      root.add(mesh);
      disposables.push(geo, materials[g]);
    }

    // --- Placement ------------------------------------------------------
    for (let i = 0; i < count; i++) {
      const feature = track.features[members[i]];
      const halfWidth = track.path.halfWidthAt(feature.s);
      let height = 0;
      let scaleX = 1;
      let scaleY = 1;
      let scaleZ = 1;

      switch (kind) {
        case 'boost':
          height = BOOST_LIFT;
          scaleX = Math.max(3.5, feature.size * halfWidth);
          scaleZ = BOOST_HALF_LENGTH;
          break;
        case 'beatgate': {
          const radius = gateRadius(feature, halfWidth);
          height = radius * GATE_CENTRE;
          scaleX = scaleY = scaleZ = radius;
          break;
        }
        case 'shield':
        case 'weapon':
          height = PICKUP_LIFT;
          scaleX = scaleY = scaleZ = Math.max(1.6, feature.size * halfWidth * 0.5);
          break;
        case 'hazard':
          height = HAZARD_LIFT;
          scaleX = scaleY = scaleZ = Math.max(1.4, feature.size * halfWidth * 0.5);
          break;
        case 'checkpoint':
          height = 0;
          scaleX = halfWidth;
          scaleY = CHECKPOINT_HEIGHT;
          scaleZ = 1;
          break;
      }

      featureAnchor(track, feature, height, _position, _quaternion);
      bucket.basePosition[i * 3] = _position.x;
      bucket.basePosition[i * 3 + 1] = _position.y;
      bucket.basePosition[i * 3 + 2] = _position.z;
      bucket.baseQuaternion[i * 4] = _quaternion.x;
      bucket.baseQuaternion[i * 4 + 1] = _quaternion.y;
      bucket.baseQuaternion[i * 4 + 2] = _quaternion.z;
      bucket.baseQuaternion[i * 4 + 3] = _quaternion.w;
      bucket.baseScale[i * 3] = scaleX;
      bucket.baseScale[i * 3 + 1] = scaleY;
      bucket.baseScale[i * 3 + 2] = scaleZ;

      _matrix.compose(_position, _quaternion, _scale.set(scaleX, scaleY, scaleZ));
      for (const mesh of bucket.meshes) mesh.setMatrixAt(i, _matrix);

      state[i * 4] = feature.s;
      state[i * 4 + 1] = feature.beat ?? 0;
      state[i * 4 + 2] = 1;
      state[i * 4 + 3] = 0;
      if (centreAttr) {
        // The pivot has to be expressed after the instance matrix, which is
        // exactly the instance's own translation in the group's space.
        centre[i * 3] = _position.x;
        centre[i * 3 + 1] = _position.y;
        centre[i * 3 + 2] = _position.z;
      }

      slotKind[members[i]] = k;
      slotIndex[members[i]] = i;
    }

    for (const mesh of bucket.meshes) mesh.instanceMatrix.needsUpdate = true;
    if (centreAttr) centreAttr.needsUpdate = true;
    stateAttr.needsUpdate = true;
    buckets.set(kind, bucket);
  }

  let clock = 0;

  function bucketFor(featureIndex: number): { bucket: Bucket; index: number } | null {
    if (featureIndex < 0 || featureIndex >= slotKind.length) return null;
    const k = slotKind[featureIndex];
    if (k < 0) return null;
    const bucket = buckets.get(KIND_ORDER[k]);
    if (!bucket) return null;
    return { bucket, index: slotIndex[featureIndex] };
  }

  function update(state: FeatureVisualState): void {
    const dt = state.dt > 0 ? Math.min(state.dt, 0.1) : 0;
    clock += dt;
    u.beatPhase.value = state.beatPhase;
    u.beatIndex.value = state.beatIndex;
    u.intensity.value = state.intensity;
    // Feature `s` values live in [0, length); fold the player's progress in so
    // the wrap-aware proximity term in the shader lines up.
    const length = track.path.length;
    u.player.value = ((state.playerDistance % length) + length) % length;

    for (const bucket of buckets.values()) {
      let dirty = bucket.dirty;

      // Respawn timers and hit decays.
      for (let i = 0; i < bucket.count; i++) {
        if (bucket.respawn[i] >= 0) {
          bucket.respawn[i] -= dt;
          // Out fast, back in over the last second of the timer.
          const fade = bucket.respawn[i] <= 0 ? 1 : Math.max(0, 1 - Math.min(1, bucket.respawn[i]));
          bucket.state[i * 4 + 2] = fade;
          if (bucket.respawn[i] <= 0) bucket.respawn[i] = -1;
          dirty = true;
        }
        if (bucket.hitTimer[i] > 0) {
          bucket.hitTimer[i] -= dt;
          const amount = Math.max(0, bucket.hitTimer[i] / GATE_HIT_SECONDS);
          bucket.state[i * 4 + 3] = amount * amount * bucket.hitSign[i];
          dirty = true;
        }
      }

      // Idle motion for the floating pickups. A handful of instances, so a CPU
      // recompose is far cheaper than the shader gymnastics needed to spin a
      // mesh about its own instance origin.
      if (bucket.spin !== 0) {
        for (let i = 0; i < bucket.count; i++) {
          _position.set(bucket.basePosition[i * 3], bucket.basePosition[i * 3 + 1], bucket.basePosition[i * 3 + 2]);
          _quaternion.set(
            bucket.baseQuaternion[i * 4],
            bucket.baseQuaternion[i * 4 + 1],
            bucket.baseQuaternion[i * 4 + 2],
            bucket.baseQuaternion[i * 4 + 3],
          );
          const angle = clock * bucket.spin + i * 1.7;
          _spinQuat.setFromAxisAngle(_up, angle);
          _quaternion.multiply(_spinQuat);
          if (bucket.bobHeight !== 0) {
            _bob.set(0, Math.sin(clock * 1.6 + i) * bucket.bobHeight, 0);
            _bob.applyQuaternion(_quaternion);
            _position.add(_bob);
          }
          _scale.set(bucket.baseScale[i * 3], bucket.baseScale[i * 3 + 1], bucket.baseScale[i * 3 + 2]);
          _matrix.compose(_position, _quaternion, _scale);
          for (const mesh of bucket.meshes) mesh.setMatrixAt(i, _matrix);
        }
        for (const mesh of bucket.meshes) mesh.instanceMatrix.needsUpdate = true;
      }

      if (dirty) {
        bucket.stateAttribute.needsUpdate = true;
        bucket.dirty = false;
      }
    }
  }

  function consume(featureIndex: number, respawnSeconds: number): void {
    const slot = bucketFor(featureIndex);
    if (!slot) return;
    slot.bucket.state[slot.index * 4 + 2] = 0;
    slot.bucket.respawn[slot.index] = Math.max(0.05, respawnSeconds);
    slot.bucket.dirty = true;
  }

  function hitGate(featureIndex: number, perfect: boolean): void {
    const slot = bucketFor(featureIndex);
    if (!slot) return;
    slot.bucket.hitTimer[slot.index] = GATE_HIT_SECONDS * (perfect ? 1.25 : 1);
    slot.bucket.hitSign[slot.index] = perfect ? 1 : -1;
    slot.bucket.state[slot.index * 4 + 3] = perfect ? 1.25 : -1;
    slot.bucket.dirty = true;
  }

  function dispose(): void {
    for (const d of disposables) d.dispose();
    for (const bucket of buckets.values()) {
      for (const mesh of bucket.meshes) mesh.dispose();
    }
    buckets.clear();
    root.clear();
  }

  return { object: root, update, consume, hitGate, dispose };
}

const _spinQuat = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _bob = new THREE.Vector3();
