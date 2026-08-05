/**
 * SCRATCH — visual harness for craft, trails, particles and track furniture.
 * Not part of the game. Delete along with vfxtest.html.
 */
import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { Track } from './track/runtime';
import { getTrack } from './track/library';
import { SHIPS } from './game/ships';
import { tierSettings, type QualityTierName } from './core/quality';
import { createShipVisual } from './render/ship-mesh';
import { createShipTrail } from './render/trail';
import {
  createParticleSystem,
  emitBoostBurst,
  emitEngineSparks,
  emitExplosion,
  emitLandingDust,
  emitWallSparks,
} from './render/particles';
import { createFeatureVisuals } from './render/feature-mesh';
import { buildTrackMesh } from './render/track-mesh';
import { createEnvironment } from './render/environment/index';
import type { ShipVisualState } from './render/types';
import type { FeatureVisualState } from './render/types';

type Any = any;

declare global {
  interface Window {
    __VFX__: Any;
  }
}

const params = new URLSearchParams(location.search);
const tier = (params.get('tier') ?? 'ultra') as QualityTierName;
const quality = tierSettings(tier);

window.__VFX__ = { ready: false, frames: 0 };

async function boot(): Promise<void> {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLDivElement;
  const forceWebGL = params.get('gpu') === 'webgl';
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.3, quality.drawDistance);

  const track = Track.build(getTrack('neon-meridian'));
  const palette = track.definition.palette;

  const plain = params.get('plain') === '1';
  const env = createEnvironment({
    archetype: track.definition.environment,
    palette,
    seed: track.definition.seed,
    quality,
    trackRadius: track.radius,
    trackCentre: track.centre,
  });
  if (!plain) {
    scene.add(env.root);
    scene.background = env.background;
    scene.environment = env.envMap;
    scene.fog = new THREE.FogExp2(env.fog.color, env.fog.density);
  }

  const key = new THREE.DirectionalLight(env.keyLight.color, plain ? 1.6 : env.keyLight.intensity);
  key.position.copy(env.keyLight.direction).multiplyScalar(1400);
  scene.add(key);
  scene.add(new THREE.AmbientLight(env.ambient.color, plain ? 0.35 : env.ambient.intensity));

  const trackMesh = buildTrackMesh(track, palette, quality);
  if (!plain) scene.add(trackMesh.group);

  const features = createFeatureVisuals(track, { palette, quality });
  scene.add(features.object);

  const particles = createParticleSystem({ quality, seed: 'vfx' });
  scene.add(particles.object);

  const shipDef = SHIPS[Number(params.get('ship') ?? 0)] ?? SHIPS[0];
  const ship = createShipVisual({ colors: shipDef.colors, quality, isPlayer: true });
  scene.add(ship.object);

  const trail = createShipTrail({ quality, color: shipDef.colors.engine });
  scene.add(trail.object);

  // A second craft alongside, so liveries can be compared in one shot.
  const rivalDef = SHIPS[Number(params.get('ship2') ?? 5)] ?? SHIPS[5];
  const rival = createShipVisual({ colors: rivalDef.colors, quality, isPlayer: false });
  scene.add(rival.object);
  const rivalTrail = createShipTrail({ quality, color: rivalDef.colors.engine });
  scene.add(rivalTrail.object);

  // --- Driving ----------------------------------------------------------
  const drive = {
    s: 0,
    speed: 120,
    boost: 0,
    turbo: 0,
    damage: 0,
    shield: 1,
    invuln: false,
    ghost: 1,
    slip: 0,
    airborne: false,
    wall: false,
    beat: 0,
    lateral: 0,
    paused: false,
  };

  const shipState: ShipVisualState = {
    dt: 0,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    speedFraction: 0.8,
    boost: 0,
    slip: 0,
    shieldFraction: 1,
    damageFlash: 0,
    airborne: false,
    turboTier: 0,
    invulnerable: false,
    beatPulse: 0,
    wallContact: false,
    ghostAlpha: 1,
  };
  const rivalState: ShipVisualState = { ...shipState, position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  const featureState: FeatureVisualState = { dt: 0, beatPhase: 0, beatIndex: 0, playerDistance: 0, intensity: 0.8 };

  const basis = new THREE.Matrix4();
  const forward = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const backward = new THREE.Vector3();
  const up = new THREE.Vector3();

  function placeShip(s: number, lateral: number, out: ShipVisualState): void {
    const frame = track.path.sample(s);
    track.path.toWorld(s, lateral, 2.4, out.position);
    basis.makeBasis(frame.right, frame.up, forward.copy(frame.tangent).negate());
    out.quaternion.setFromRotationMatrix(basis);
  }

  // --- Camera -----------------------------------------------------------
  const cam = { mode: 'chase', yaw: 35, pitch: 14, dist: 16, target: 'ship', gateIndex: 0 };
  const camTarget = new THREE.Vector3();
  const camOffset = new THREE.Vector3();

  let lookKind = 'beatgate';
  function gateFeatureIndex(n: number): number {
    const gates: number[] = [];
    for (let i = 0; i < track.features.length; i++) if (track.features[i].kind === lookKind) gates.push(i);
    return gates.length ? gates[Math.min(n, gates.length - 1)] : -1;
  }

  function updateCamera(): void {
    if (cam.mode === 'orbit') {
      camTarget.copy(shipState.position);
      const y = (cam.yaw * Math.PI) / 180;
      const p = (cam.pitch * Math.PI) / 180;
      camOffset.set(
        Math.sin(y) * Math.cos(p) * cam.dist,
        Math.sin(p) * cam.dist,
        Math.cos(y) * Math.cos(p) * cam.dist,
      );
      camOffset.applyQuaternion(shipState.quaternion);
      camera.position.copy(camTarget).add(camOffset);
      camera.lookAt(camTarget);
      camera.fov = 42;
    } else if (cam.mode === 'gate') {
      const idx = gateFeatureIndex(cam.gateIndex);
      const f = idx >= 0 ? track.features[idx] : null;
      const s = f ? f.s - cam.dist : drive.s;
      track.path.toWorld(s, 0, 6 + cam.pitch, camera.position);
      track.path.toWorld(s + (cam.dist > 30 ? 90 : cam.dist + 10), 0, cam.pitch > 3 ? 8 : 1.5, camTarget);
      camera.lookAt(camTarget);
      camera.fov = 62;
    } else {
      // Chase.
      const frame = track.path.sample(drive.s - cam.dist);
      track.path.toWorld(drive.s - cam.dist, drive.lateral * 0.4, 4.5 + cam.pitch * 0.1, camera.position);
      camTarget.copy(shipState.position).addScaledVector(frame.up, 1.4);
      camera.lookAt(camTarget);
      camera.fov = 62;
    }
    camera.updateProjectionMatrix();
  }

  window.__VFX__.look = (mode: string, opts: Any = {}): void => {
    cam.mode = mode;
    if (opts.yaw !== undefined) cam.yaw = opts.yaw;
    if (opts.pitch !== undefined) cam.pitch = opts.pitch;
    if (opts.dist !== undefined) cam.dist = opts.dist;
    if (opts.gate !== undefined) cam.gateIndex = opts.gate;
    if (opts.kind !== undefined) lookKind = opts.kind;
    updateCamera();
  };
  window.__VFX__.set = (patch: Any): void => {
    Object.assign(drive, patch);
  };
  window.__VFX__.hit = (perfect: boolean): void => {
    const idx = gateFeatureIndex(cam.gateIndex);
    if (idx >= 0) features.hitGate(idx, perfect);
  };
  window.__VFX__.boom = (): void => {
    ship.explode();
    emitExplosion(particles, shipState.position, shipDef.colors.engine);
  };
  window.__VFX__.info = (): Any => ({
    features: track.features.length,
    gates: track.features.filter((f) => f.kind === 'beatgate').length,
    particles: particles.active,
    budget: particles.budget,
    trail: trail.segments,
    length: track.path.length,
  });

  const post = new THREE.PostProcessing(renderer);
  const scenePass = pass(scene, camera);
  post.outputNode = plain
    ? scenePass
    : scenePass.add(bloom(scenePass.getTextureNode(), quality.bloomStrength * 0.9, 0.5, 0.7));

  addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  let last = performance.now();
  let beatClock = 0;
  let frames = 0;
  let landingTimer = 0;

  renderer.setAnimationLoop(async () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (!drive.paused) drive.s = track.path.wrap(drive.s + drive.speed * dt * (1 + drive.boost * 0.4));
    beatClock += (dt * track.definition.music.bpm) / 60;
    const beatIndex = Math.floor(beatClock);
    const beatPhase = beatClock - beatIndex;
    drive.lateral = Math.sin(drive.s * 0.012) * 6;

    placeShip(drive.s, drive.lateral, shipState);
    placeShip(drive.s - 14, drive.lateral - 9, rivalState);

    const frame = track.path.sample(drive.s);
    velocity.copy(frame.tangent).multiplyScalar(drive.speed);
    backward.copy(frame.tangent).negate();
    up.copy(frame.up);

    shipState.dt = dt;
    shipState.speedFraction = Math.min(1, drive.speed / 160);
    shipState.boost = drive.boost;
    shipState.slip = drive.slip;
    shipState.shieldFraction = drive.shield;
    shipState.damageFlash = drive.damage;
    shipState.airborne = drive.airborne;
    shipState.turboTier = drive.turbo;
    shipState.invulnerable = drive.invuln;
    shipState.beatPulse = Math.pow(1 - beatPhase, 3);
    shipState.wallContact = drive.wall;
    shipState.ghostAlpha = drive.ghost;
    ship.update(shipState);

    rivalState.dt = dt;
    rivalState.speedFraction = 0.75;
    rivalState.boost = 0.3;
    rivalState.beatPulse = shipState.beatPulse;
    rivalState.turboTier = 2;
    rival.update(rivalState);

    trail.update({
      dt,
      position: shipState.position,
      quaternion: shipState.quaternion,
      speedFraction: shipState.speedFraction,
      boost: drive.boost,
      cameraPosition: camera.position,
    });
    rivalTrail.update({
      dt,
      position: rivalState.position,
      quaternion: rivalState.quaternion,
      speedFraction: 0.75,
      boost: 0.3,
      cameraPosition: camera.position,
    });

    // Engine sparks from both nozzles.
    for (const side of [-1, 1]) {
      nozzle.set(side * 2.16, -0.14, 4.4).applyQuaternion(shipState.quaternion).add(shipState.position);
      emitEngineSparks(particles, nozzle, backward, velocity, shipDef.colors.engine, 0.3 + drive.boost, dt);
    }
    if (drive.wall) {
      nozzle.set(2.2, 0, 0).applyQuaternion(shipState.quaternion).add(shipState.position);
      emitWallSparks(particles, nozzle, frame.right, velocity, dt);
    }
    landingTimer -= dt;
    if (drive.airborne && landingTimer <= 0) {
      landingTimer = 1.2;
      emitLandingDust(particles, shipState.position, up, 0.8, palette.haze);
      emitBoostBurst(particles, shipState.position, backward, palette.glow);
    }
    particles.update(dt);

    featureState.dt = dt;
    featureState.beatPhase = beatPhase;
    featureState.beatIndex = beatIndex;
    featureState.playerDistance = drive.s;
    featureState.intensity = 0.85;
    features.update(featureState);

    trackMesh.uniforms.beatPulse.value = shipState.beatPulse;
    trackMesh.uniforms.intensity.value = 0.85;
    trackMesh.uniforms.playerDistance.value = drive.s;
    trackMesh.uniforms.boostGlow.value = drive.boost;

    updateCamera();
    camera.updateMatrixWorld();
    env.update({ dt, camera, intensity: 0.85, beatPhase, beatIndex, speed: shipState.speedFraction });

    await post.renderAsync();
    frames++;
    window.__VFX__.frames = frames;
    if (frames > 4) window.__VFX__.ready = true;
    if (frames % 10 === 0) {
      hud.textContent = [
        `${tier}  ${(renderer.backend as Any)?.isWebGPUBackend ? 'webgpu' : 'webgl2'}  cam=${cam.mode}`,
        `s=${drive.s.toFixed(0)}  boost=${drive.boost.toFixed(2)} turbo=${drive.turbo}`,
        `particles ${particles.active}/${particles.budget}  trail ${trail.segments}`,
        `features ${track.features.length}`,
      ].join('\n');
    }
  });
}

const nozzle = new THREE.Vector3();

boot().catch((e) => {
  window.__VFX__.error = String(e?.stack ?? e);
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f66;font:12px monospace;padding:20px;white-space:pre-wrap">${window.__VFX__.error}</pre>`;
});
