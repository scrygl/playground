import * as THREE from 'three/webgpu';
import { Fn, float, fract, mix, pass, sin, smoothstep, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type { QualitySettings } from '../core/quality';

/**
 * Renderer, scene, and the post-processing chain.
 *
 * WebGPU is the target; Three's node renderer falls back to WebGL2 by itself
 * when it has to, and because every material in the game is written in TSL the
 * two paths render the same picture rather than being two codebases.
 *
 * The post chain is where most of the game's look lives: bloom for the neon,
 * radial blur and chromatic aberration keyed to speed, then vignette and grain
 * to keep the image from feeling clinically clean.
 */

/** Helper that preserves the concrete uniform type (see the note in track-mesh). */
function floatUniform(value: number) {
  return uniform(value, 'float');
}

export interface RendererHandle {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  backend: 'webgpu' | 'webgl2';
}

export interface PostUniforms {
  /** 0..1 how much radial speed blur to apply. */
  speed: { value: number };
  /** 0..1 chromatic aberration strength. */
  aberration: { value: number };
  /** 0..1 spikes on damage, flashing the frame red. */
  damage: { value: number };
  /** 0..1 fades the whole image to black, for transitions. */
  fade: { value: number };
  /** 0..1 extra warmth and glow while boosting. */
  boost: { value: number };
}

export class GameRenderer {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly post: PostUniforms;

  backend: 'webgpu' | 'webgl2' = 'webgl2';
  private postProcessing: THREE.PostProcessing | null = null;
  private quality: QualitySettings;
  private resolutionScale = 1;
  private pixelRatioCap = 2;
  private width = 1;
  private height = 1;
  private camera: THREE.PerspectiveCamera | null = null;
  private disposed = false;

  private readonly uSpeed = floatUniform(0);
  private readonly uAberration = floatUniform(0);
  private readonly uDamage = floatUniform(0);
  private readonly uFade = floatUniform(0);
  private readonly uBoost = floatUniform(0);
  /** Advanced every frame so film grain does not freeze into a static pattern. */
  private readonly uTime = floatUniform(0);

  constructor(canvas: HTMLCanvasElement, quality: QualitySettings, forceWebGL: boolean) {
    this.quality = quality;
    this.renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: quality.antialias,
      forceWebGL,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x03040a, 1);

    this.post = {
      speed: this.uSpeed,
      aberration: this.uAberration,
      damage: this.uDamage,
      fade: this.uFade,
      boost: this.uBoost,
    };
  }

  async init(): Promise<void> {
    await this.renderer.init();
    // `isWebGPUBackend` is the only reliable way to know which path we got,
    // since construction succeeds either way.
    this.backend = (this.renderer.backend as { isWebGPUBackend?: boolean })?.isWebGPUBackend ? 'webgpu' : 'webgl2';
  }

  /** Builds (or rebuilds) the post chain for the current quality settings. */
  buildPostProcessing(camera: THREE.PerspectiveCamera): void {
    this.camera = camera;
    this.postProcessing?.dispose?.();

    const scenePass = pass(this.scene, camera);
    // Only the raw pass texture can be sampled at arbitrary coordinates, so
    // every effect that displaces UVs — radial blur, chromatic aberration —
    // has to read from this, before anything is added on top of it.
    const sceneTexture = scenePass.getTextureNode();
    const bloomNode = this.quality.bloom ? bloom(sceneTexture, this.quality.bloomStrength, 0.42, 0.62) : null;

    const wantsBlur = this.quality.motionBlur;
    const wantsAberration = this.quality.chromaticAberration;
    const wantsGrain = this.quality.filmGrain;

    const composite = Fn(() => {
      const coord = uv();
      const offset = coord.sub(vec2(0.5, 0.5));
      const radius = offset.length();

      // Radial blur: taps march outward from the centre, so the middle of the
      // screen stays sharp and the edges smear. That reads as speed, where a
      // uniform blur just reads as being out of focus.
      let base = sceneTexture.sample(coord).rgb;
      if (wantsBlur) {
        const strength = this.uSpeed.mul(0.05).mul(smoothstep(0.04, 0.6, radius));
        const TAPS = 6;
        let accum = base;
        for (let i = 1; i < TAPS; i++) {
          const t = float(i / (TAPS - 1));
          accum = accum.add(sceneTexture.sample(coord.sub(offset.mul(strength.mul(t)))).rgb);
        }
        base = accum.div(float(TAPS));
      }

      if (wantsAberration) {
        // Scales with the square of the radius, matching how a real lens
        // misbehaves: invisible in the centre, obvious in the corners.
        const ca = this.uAberration.mul(0.005).mul(radius.mul(radius));
        const r = sceneTexture.sample(coord.sub(offset.mul(ca))).r;
        const b = sceneTexture.sample(coord.add(offset.mul(ca))).b;
        base = vec3(r, base.g, b);
      }

      let colour = base;
      if (bloomNode) colour = colour.add(bloomNode.rgb);

      // Boost warms the image; damage flashes red inward from the edges.
      colour = mix(colour, colour.mul(vec3(1.14, 1.02, 0.92)), this.uBoost.mul(0.8));
      colour = mix(colour, vec3(0.95, 0.08, 0.14), this.uDamage.mul(smoothstep(0.1, 0.85, radius)).mul(0.65));

      // Vignette kept gentle: enough to hold the eye centre-frame, not enough
      // to be noticed as an effect.
      colour = colour.mul(smoothstep(0.98, 0.3, radius).mul(0.32).add(0.68));

      if (wantsGrain) {
        // Cheap value hash. Its real job is breaking up the banding that dark
        // nebula gradients produce on 8-bit displays.
        const n = fract(sin(coord.x.mul(12.9898).add(coord.y.mul(78.233)).add(this.uTime)).mul(43758.5453));
        colour = colour.add(n.sub(0.5).mul(0.024));
      }

      return vec4(colour.mul(this.uFade.oneMinus()), 1);
    });

    this.postProcessing = new THREE.PostProcessing(this.renderer);
    this.postProcessing.outputNode = composite();
  }

  setQuality(quality: QualitySettings): void {
    const needsRebuild =
      quality.bloom !== this.quality.bloom ||
      quality.bloomStrength !== this.quality.bloomStrength ||
      quality.chromaticAberration !== this.quality.chromaticAberration ||
      quality.filmGrain !== this.quality.filmGrain;
    this.quality = quality;
    this.pixelRatioCap = quality.maxPixelRatio;
    this.applyResolution();
    if (needsRebuild && this.camera) this.buildPostProcessing(this.camera);
  }

  /** Runtime resolution scaling from the adaptive quality controller. */
  setResolutionScale(scale: number): void {
    if (Math.abs(scale - this.resolutionScale) < 0.001) return;
    this.resolutionScale = scale;
    this.applyResolution();
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.applyResolution();
  }

  private applyResolution(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.pixelRatioCap);
    this.renderer.setPixelRatio(dpr * this.quality.resolutionScale * this.resolutionScale);
    this.renderer.setSize(this.width, this.height, false);
  }

  get currentPixelRatio(): number {
    return this.renderer.getPixelRatio();
  }

  async render(camera: THREE.PerspectiveCamera, elapsed: number): Promise<void> {
    if (this.disposed) return;
    if (!this.postProcessing || this.camera !== camera) this.buildPostProcessing(camera);
    this.uTime.value = elapsed;
    await this.postProcessing!.renderAsync();
  }

  dispose(): void {
    this.disposed = true;
    this.postProcessing?.dispose?.();
    this.renderer.dispose();
  }
}
