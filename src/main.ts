import './style.css';
import * as THREE from 'three/webgpu';
import { getTrack } from './track/library';
import { Track } from './track/runtime';
import { getShip } from './game/ships';
import { Vehicle } from './game/vehicle';
import { Driver } from './game/driver';
import { GameRenderer } from './render/renderer';
import { ChaseCamera } from './render/camera';
import { buildTrackMesh } from './render/track-mesh';
import { createEnvironment } from './render/environment';
import { tierSettings, type QualityTierName } from './core/quality';

/**
 * Temporary integration harness: a craft driving a real circuit with the real
 * renderer, track mesh, environment and camera.
 *
 * Replaced by the full application once the interface and craft visuals land.
 */

declare global {
  interface Window {
    __GAME_DEBUG__: Record<string, unknown>;
  }
}

const params = new URLSearchParams(location.search);
window.__GAME_DEBUG__ = { ready: false, frames: 0 };

async function boot() {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const quality = tierSettings((params.get('tier') as QualityTierName) ?? 'high');
  const trackId = params.get('track') ?? 'neon-meridian';

  const renderer = new GameRenderer(canvas, quality, params.get('gpu') === 'webgl');
  await renderer.init();
  window.__GAME_DEBUG__.backend = renderer.backend;

  const definition = getTrack(trackId);
  const track = Track.build(definition);
  window.__GAME_DEBUG__.trackLength = Math.round(track.path.length);

  const trackMesh = buildTrackMesh(track, definition.palette, quality);
  renderer.scene.add(trackMesh.group);

  const environment = createEnvironment({
    archetype: definition.environment,
    palette: definition.palette,
    seed: definition.seed,
    quality,
    trackRadius: track.radius,
    trackCentre: track.centre,
  });
  renderer.scene.add(environment.root);
  renderer.scene.background = environment.background;
  renderer.scene.environment = environment.envMap;
  window.__GAME_DEBUG__.envDiagnostics = environment.diagnostics;

  const key = new THREE.DirectionalLight(environment.keyLight.color, environment.keyLight.intensity);
  key.position.copy(environment.keyLight.direction).multiplyScalar(600).add(track.centre);
  renderer.scene.add(key);
  renderer.scene.add(new THREE.AmbientLight(environment.ambient.color, environment.ambient.intensity));
  renderer.scene.fog = new THREE.FogExp2(environment.fog.color, environment.fog.density);

  const vehicle = new Vehicle({ track, stats: getShip('kestrel').stats, s: 0, lateral: 0 });
  const driver = new Driver(track, { skill: 0.85, seed: 'preview' });

  const camera = new ChaseCamera(window.innerWidth / window.innerHeight, {
    baseFov: 78,
    shakeScale: 1,
    reducedMotion: false,
  });
  camera.snapTo(track, vehicle);

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.setAspect(window.innerWidth / window.innerHeight);
  };
  addEventListener('resize', resize);
  resize();

  // Fast-forward the simulation before the first frame. Under software
  // rendering a capture only gets a handful of frames, and a craft still on
  // the start line tells you nothing about how the circuit looks.
  const prewarm = Number(params.get('prewarm') ?? 0);
  if (prewarm > 0) {
    const WARM_STEP = 1 / 120;
    for (let t = 0; t < prewarm; t += WARM_STEP) {
      vehicle.step(driver.update(vehicle, WARM_STEP), WARM_STEP);
      vehicle.events.length = 0;
    }
    camera.snapTo(track, vehicle);
  }

  let last = performance.now();
  let elapsed = 0;

  renderer.renderer.setAnimationLoop(async () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    elapsed += dt;

    // Fixed-step the craft so the preview matches the real simulation.
    const STEP = 1 / 120;
    let remaining = dt;
    while (remaining > 0) {
      const step = Math.min(STEP, remaining);
      vehicle.step(driver.update(vehicle, step), step);
      vehicle.events.length = 0;
      remaining -= step;
    }

    camera.update(track, vehicle, dt, false);

    const beat = elapsed * 2.2;
    trackMesh.uniforms.playerDistance.value = vehicle.s;
    trackMesh.uniforms.beatPulse.value = Math.max(0, 1 - (beat % 1) * 3);
    trackMesh.uniforms.boostGlow.value = vehicle.boostAmount;
    trackMesh.uniforms.intensity.value = 0.4 + vehicle.normalisedSpeed * 0.5;

    environment.update({
      dt,
      camera: camera.camera,
      intensity: 0.6,
      beatPhase: beat % 1,
      beatIndex: Math.floor(beat),
      speed: vehicle.normalisedSpeed,
    });

    renderer.post.speed.value = camera.speedEffect(vehicle);
    renderer.post.aberration.value = vehicle.normalisedSpeed * 0.6 + vehicle.boostAmount;
    renderer.post.boost.value = vehicle.boostAmount;

    await renderer.render(camera.camera, elapsed);

    const debug = window.__GAME_DEBUG__;
    debug.frames = (debug.frames as number) + 1;
    debug.speed = Math.round(vehicle.speed);
    debug.lap = vehicle.lap;
    debug.s = Math.round(vehicle.s);
    if ((debug.frames as number) > 4) debug.ready = true;
  });
}

boot().catch((e) => {
  window.__GAME_DEBUG__.error = String(e?.stack ?? e);
  console.error(e);
  const pre = document.createElement('pre');
  pre.style.cssText = 'color:#f66;font:12px monospace;padding:20px;white-space:pre-wrap';
  pre.textContent = String(window.__GAME_DEBUG__.error);
  document.body.appendChild(pre);
});
