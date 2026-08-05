import './style.css';
// Temporary spike: verify three/webgpu + TSL + postprocessing renders headless.
import * as THREE from 'three/webgpu';
import { color, mix, positionLocal, sin, time, uv, vec3, vec4, float, pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

declare global {
  interface Window {
    __SPIKE__: { ready: boolean; backend: string; error?: string; frames: number };
  }
}

window.__SPIKE__ = { ready: false, backend: 'unknown', frames: 0 };

async function boot() {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const forceWebGL = new URLSearchParams(location.search).get('gpu') === 'webgl';
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(1);
  await renderer.init();

  window.__SPIKE__.backend = (renderer.backend as any)?.isWebGPUBackend ? 'webgpu' : 'webgl2';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 1.5, 6);
  camera.lookAt(0, 0, 0);

  // TSL node material: animated emissive bands, the sort of thing the track will use.
  const mat = new THREE.MeshStandardNodeMaterial();
  const bands = sin(uv().y.mul(40).add(time.mul(3))).mul(0.5).add(0.5);
  mat.colorNode = mix(color(0x0a1230), color(0x35e0ff), bands);
  mat.emissiveNode = mix(vec3(0, 0, 0), color(0x35e0ff), bands.pow(3)).mul(2.5);
  mat.roughnessNode = float(0.25);
  mat.metalnessNode = float(0.8);
  mat.positionNode = positionLocal;

  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1.4, 0.42, 220, 32), mat);
  scene.add(knot);

  const grid = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    (() => {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true });
      const g = uv().mul(40).fract().sub(0.5).abs();
      const line = g.x.min(g.y).smoothstep(0.02, 0.0);
      m.colorNode = vec4(color(0xff2d75), line.mul(0.5));
      return m;
    })(),
  );
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = -2.4;
  scene.add(grid);

  scene.add(new THREE.AmbientLight(0x2a3a66, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(3, 5, 4);
  scene.add(key);

  // Post-processing chain through the node system.
  const post = new THREE.PostProcessing(renderer);
  const scenePass = pass(scene, camera);
  const bloomPass = bloom(scenePass.getTextureNode(), 0.9, 0.3, 0.75);
  post.outputNode = scenePass.add(bloomPass);

  addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  renderer.setAnimationLoop(async () => {
    knot.rotation.x += 0.004;
    knot.rotation.y += 0.007;
    await post.renderAsync();
    window.__SPIKE__.frames++;
    if (window.__SPIKE__.frames > 3) window.__SPIKE__.ready = true;
  });
}

boot().catch((e) => {
  window.__SPIKE__.error = String(e?.stack ?? e);
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f66;font:12px monospace;padding:20px;white-space:pre-wrap">${window.__SPIKE__.error}</pre>`;
});
