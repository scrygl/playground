/**
 * SCRATCH — visual harness for the environment subsystem. Not part of the game.
 * Delete along with envtest.html once the environment is signed off.
 */
import * as THREE from 'three/webgpu';
import { color, float, mix, pass, positionLocal, sin, time, uv, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createEnvironment } from './render/environment/index';
import { tierSettings, type QualityTierName } from './core/quality';
import type { BuiltEnvironment, EnvironmentFrameState } from './render/environment/types';
import type { EnvironmentArchetype, TrackPalette } from './track/types';

type Any = any;

declare global {
  interface Window {
    __ENV_TEST__: {
      ready: boolean;
      archetype: string;
      diagnostics: unknown;
      set(archetype: string): void;
      look(yawDeg: number, pitchDeg?: number): void;
      relativeToSun(yawDeg: number, pitchDeg?: number): void;
      only(which: string): void;
      bloom(on: boolean): void;
      error?: string;
    };
  }
}

const PALETTES: Record<EnvironmentArchetype, TrackPalette> = {
  nebula: { primary: 0x37e6ff, secondary: 0xff3d8b, deep: 0x0b0f33, glow: 0xb679ff, sun: 0xfff2d0, haze: 0x3d2a78 },
  megastructure: { primary: 0x64d9ff, secondary: 0xff8a3c, deep: 0x090d14, glow: 0xbfe6ff, sun: 0xdfeaff, haze: 0x2b3a4a },
  prismatic: { primary: 0x2bf0ff, secondary: 0xff2fd0, deep: 0x120a3a, glow: 0xffe94a, sun: 0xfff6e0, haze: 0x5a2a9e },
  starfield: { primary: 0x7fd4ff, secondary: 0xffb066, deep: 0x03040a, glow: 0xc9e2ff, sun: 0xfff8ea, haze: 0x141c30 },
  ringworld: { primary: 0xffc46b, secondary: 0x5fe0c0, deep: 0x160d1f, glow: 0xffd9a0, sun: 0xffe6b8, haze: 0x6b4326 },
  void: { primary: 0x8f6bff, secondary: 0x2ea3a0, deep: 0x04030a, glow: 0x6f5bd6, sun: 0x9aa8d0, haze: 0x0d0b1a },
};

const ARCHETYPES: EnvironmentArchetype[] = [
  'nebula',
  'megastructure',
  'prismatic',
  'starfield',
  'ringworld',
  'void',
];

const TRACK_RADIUS = 420;
const params = new URLSearchParams(location.search);
const tier = (params.get('tier') ?? 'high') as QualityTierName;
const quality = tierSettings(tier);

window.__ENV_TEST__ = {
  ready: false,
  archetype: '',
  diagnostics: null,
  set: () => {},
  look: () => {},
  relativeToSun: () => {},
  only: () => {},
  bloom: () => {},
};

async function boot(): Promise<void> {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLDivElement;
  const forceWebGL = params.get('gpu') === 'webgl';
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.5, quality.drawDistance);
  const trackCentre = new THREE.Vector3(0, 0, 0);

  // --- a stand-in for the real track: bright, bloom-heavy, so the sky can be
  // judged against something that has to dominate it.
  const trackMat = new THREE.MeshBasicNodeMaterial();
  const bands = sin(uv().x.mul(420).add(time.mul(2))).mul(0.5).add(0.5);
  trackMat.colorNode = vec4(
    mix(color(0x0a1030), color(0x9ff4ff), bands.pow(2).mul(0.85).add(0.15)).mul(3.2),
    1,
  );
  trackMat.side = THREE.DoubleSide;
  const trackGeo = new THREE.TorusGeometry(TRACK_RADIUS * 0.85, 14, 3, 420);
  const trackMesh = new THREE.Mesh(trackGeo, trackMat);
  trackMesh.rotation.x = Math.PI / 2;
  trackMesh.position.y = -18;
  scene.add(trackMesh);

  const railMat = new THREE.MeshBasicNodeMaterial();
  railMat.colorNode = vec4(color(0xff2f7a).mul(float(4.5)), 1);
  railMat.positionNode = positionLocal;
  const railGeo = new THREE.TorusGeometry(TRACK_RADIUS * 0.85 + 16, 1.6, 3, 420);
  const rail = new THREE.Mesh(railGeo, railMat);
  rail.rotation.x = Math.PI / 2;
  rail.position.y = -12;
  scene.add(rail);

  const key = new THREE.DirectionalLight(0xffffff, 1);
  scene.add(key);
  const ambient = new THREE.AmbientLight(0xffffff, 1);
  scene.add(ambient);

  const post = new THREE.PostProcessing(renderer);
  const scenePass = pass(scene, camera);
  const bloomPass = bloom(scenePass.getTextureNode(), quality.bloomStrength, 0.45, 0.72);
  post.outputNode = scenePass.add(bloomPass);

  let env: (BuiltEnvironment & { diagnostics: Any }) | null = null;
  let sunYaw = 0;

  function build(archetype: EnvironmentArchetype): void {
    if (env) {
      scene.remove(env.root);
      env.dispose();
      env = null;
    }
    const t0 = performance.now();
    env = createEnvironment({
      archetype,
      palette: PALETTES[archetype],
      seed: `scratch-${archetype}`,
      quality,
      trackRadius: TRACK_RADIUS,
      trackCentre,
    });
    const total = performance.now() - t0;
    scene.add(env.root);
    scene.background = env.background;
    scene.environment = env.envMap;
    scene.fog = new THREE.FogExp2(env.fog.color, env.fog.density);

    key.color.setHex(env.keyLight.color);
    key.intensity = env.keyLight.intensity;
    key.position.copy(env.keyLight.direction).multiplyScalar(1200);
    key.target.position.set(0, 0, 0);
    scene.add(key.target);
    ambient.color.setHex(env.ambient.color);
    ambient.intensity = env.ambient.intensity;

    sunYaw = (Math.atan2(env.keyLight.direction.x, env.keyLight.direction.z) * 180) / Math.PI;

    window.__ENV_TEST__.archetype = archetype;
    window.__ENV_TEST__.diagnostics = { ...env.diagnostics, buildTotalMs: Math.round(total) };
    hud.textContent = [
      `${archetype}  [${tier}]  ${(renderer.backend as Any)?.isWebGPUBackend ? 'webgpu' : 'webgl2'}`,
      `sky ${env.diagnostics.skyboxMs.toFixed(0)}ms @ ${env.diagnostics.skyboxResolution}px  build ${total.toFixed(0)}ms`,
      `stars ${env.diagnostics.starCount}  scenery ${env.diagnostics.sceneryInstances}`,
      `skyLum ${env.diagnostics.skyLuminance.toFixed(4)}  fogD ${env.fog.density.toExponential(2)}`,
      `key #${env.keyLight.color.toString(16).padStart(6, '0')} x${env.keyLight.intensity}  amb #${env.ambient.color.toString(16).padStart(6, '0')} x${env.ambient.intensity.toFixed(2)}`,
    ].join('\n');
  }

  let yaw = 0;
  let pitch = 6;
  function aim(): void {
    const y = (yaw * Math.PI) / 180;
    const p = (pitch * Math.PI) / 180;
    camera.position.set(0, 34, 0);
    camera.lookAt(
      Math.sin(y) * Math.cos(p) * 100,
      34 + Math.sin(p) * 100,
      Math.cos(y) * Math.cos(p) * 100,
    );
  }

  window.__ENV_TEST__.set = (a: string): void => {
    build((ARCHETYPES.includes(a as EnvironmentArchetype) ? a : 'nebula') as EnvironmentArchetype);
  };
  window.__ENV_TEST__.look = (y: number, p = 6): void => {
    yaw = y;
    pitch = p;
    aim();
  };
  window.__ENV_TEST__.relativeToSun = (y: number, p = 6): void => {
    yaw = sunYaw + y;
    pitch = p;
    aim();
  };
  window.__ENV_TEST__.only = (which: string): void => {
    const want = which.split(',');
    const on = (name: string): boolean => want.includes('all') || want.includes(name);
    trackMesh.visible = on('track');
    rail.visible = on('track');
    if (!env) return;
    env.root.traverse((o: Any) => {
      if (o.name === 'Celestial') o.visible = on('celestial');
      if (o.name === 'Starfield') o.visible = on('stars');
      if (o.name === 'Scenery') o.visible = on('scenery');
    });
    scene.background = on('sky') ? env.background : null;
  };
  window.__ENV_TEST__.bloom = (b: boolean): void => {
    post.outputNode = b ? scenePass.add(bloomPass) : scenePass;
    post.needsUpdate = true;
  };

  build((params.get('arch') as EnvironmentArchetype) ?? 'nebula');
  aim();

  // A slow vignette-ish grade is the lead's job; nothing here beyond bloom.
  addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  let last = performance.now();
  let frames = 0;
  let beatClock = 0;
  const state: EnvironmentFrameState = {
    dt: 0,
    camera,
    intensity: 0.85,
    beatPhase: 0,
    beatIndex: 0,
    speed: 0.7,
  };

  renderer.setAnimationLoop(async () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    beatClock += dt * (150 / 60); // 150 bpm
    state.dt = dt;
    state.beatIndex = Math.floor(beatClock);
    state.beatPhase = beatClock - state.beatIndex;
    camera.updateMatrixWorld();
    env?.update(state);
    await post.renderAsync();
    frames++;
    if (frames > 4) window.__ENV_TEST__.ready = true;
  });
}

boot().catch((e) => {
  window.__ENV_TEST__.error = String(e?.stack ?? e);
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f66;font:12px monospace;padding:20px;white-space:pre-wrap">${window.__ENV_TEST__.error}</pre>`;
});

// Keep the imports honest under noUnusedLocals.
void vec3;
