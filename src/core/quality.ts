/**
 * Capability detection, quality tiers, and the runtime adaptive scaler.
 *
 * The game has to run on a gaming desktop and on a thermally-throttled laptop
 * without the player configuring anything, so quality is picked automatically
 * from what the adapter reports and then continuously corrected from measured
 * frame time. Players can still override any of it.
 */

export type QualityTierName = 'potato' | 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  tier: QualityTierName;
  /** Multiplier on device pixel ratio. The first thing we sacrifice. */
  resolutionScale: number;
  /** Hard ceiling on device pixel ratio regardless of the display. */
  maxPixelRatio: number;
  bloom: boolean;
  bloomStrength: number;
  motionBlur: boolean;
  chromaticAberration: boolean;
  filmGrain: boolean;
  /** Lengthwise tessellation of the track ribbon, in metres per ring. */
  trackSegmentLength: number;
  /** How far down the track we build geometry, in metres. */
  drawDistance: number;
  /** Budget for engine trails, sparks and debris. */
  particleBudget: number;
  /** Star count in the background field. */
  starCount: number;
  /** Resolution of each face of the generated nebula cubemap. */
  skyboxResolution: number;
  /** Whether scenery props (pylons, rings, debris) are instantiated. */
  scenery: boolean;
  sceneryDensity: number;
  shadows: boolean;
  antialias: boolean;
  /** Trail ribbon segments behind each ship. */
  trailLength: number;
}

const TIERS: Record<QualityTierName, QualitySettings> = {
  potato: {
    tier: 'potato',
    resolutionScale: 0.6,
    maxPixelRatio: 1,
    bloom: false,
    bloomStrength: 0,
    motionBlur: false,
    chromaticAberration: false,
    filmGrain: false,
    trackSegmentLength: 9,
    drawDistance: 900,
    particleBudget: 0,
    starCount: 900,
    skyboxResolution: 128,
    scenery: false,
    sceneryDensity: 0,
    shadows: false,
    antialias: false,
    trailLength: 0,
  },
  low: {
    tier: 'low',
    resolutionScale: 0.75,
    maxPixelRatio: 1,
    bloom: true,
    bloomStrength: 0.5,
    motionBlur: false,
    chromaticAberration: false,
    filmGrain: false,
    trackSegmentLength: 7,
    drawDistance: 1300,
    particleBudget: 300,
    starCount: 1800,
    skyboxResolution: 256,
    scenery: true,
    sceneryDensity: 0.35,
    shadows: false,
    antialias: false,
    trailLength: 14,
  },
  medium: {
    tier: 'medium',
    resolutionScale: 0.9,
    maxPixelRatio: 1.25,
    bloom: true,
    bloomStrength: 0.7,
    motionBlur: true,
    chromaticAberration: true,
    filmGrain: true,
    trackSegmentLength: 5,
    drawDistance: 1900,
    particleBudget: 900,
    starCount: 3200,
    skyboxResolution: 384,
    scenery: true,
    sceneryDensity: 0.6,
    shadows: false,
    antialias: true,
    trailLength: 22,
  },
  high: {
    tier: 'high',
    resolutionScale: 1,
    maxPixelRatio: 1.5,
    bloom: true,
    bloomStrength: 0.85,
    motionBlur: true,
    chromaticAberration: true,
    filmGrain: true,
    trackSegmentLength: 3.5,
    drawDistance: 2600,
    particleBudget: 2000,
    starCount: 5200,
    skyboxResolution: 512,
    scenery: true,
    sceneryDensity: 0.85,
    shadows: true,
    antialias: true,
    trailLength: 30,
  },
  ultra: {
    tier: 'ultra',
    resolutionScale: 1,
    maxPixelRatio: 2,
    bloom: true,
    bloomStrength: 1,
    motionBlur: true,
    chromaticAberration: true,
    filmGrain: true,
    trackSegmentLength: 2.5,
    drawDistance: 3400,
    particleBudget: 4000,
    starCount: 8000,
    skyboxResolution: 768,
    scenery: true,
    sceneryDensity: 1,
    shadows: true,
    antialias: true,
    trailLength: 40,
  },
};

export const TIER_ORDER: QualityTierName[] = ['potato', 'low', 'medium', 'high', 'ultra'];

export function tierSettings(tier: QualityTierName): QualitySettings {
  return { ...TIERS[tier] };
}

export interface DeviceProfile {
  webgpu: boolean;
  adapter: string;
  /** Rough classification used for the initial tier guess. */
  klass: 'discrete' | 'integrated' | 'software' | 'mobile' | 'unknown';
  mobile: boolean;
  cores: number;
  memoryGb: number;
  suggested: QualityTierName;
}

const SOFTWARE_HINTS = ['swiftshader', 'llvmpipe', 'software', 'lavapipe', 'basic render'];
const INTEGRATED_HINTS = ['intel', 'uhd graphics', 'iris', 'vega 8', 'radeon graphics', 'apple m1', 'adreno', 'mali'];
const DISCRETE_HINTS = ['nvidia', 'geforce', 'rtx', 'gtx', 'radeon rx', 'arc a', 'quadro', 'apple m2', 'apple m3', 'apple m4'];

/**
 * Inspects the platform once at boot. Deliberately conservative: guessing a
 * tier too low costs some sparkle, guessing too high costs a bad first minute.
 */
export async function detectDevice(): Promise<DeviceProfile> {
  const nav = navigator as Navigator & {
    gpu?: { requestAdapter(opts?: unknown): Promise<unknown> };
    deviceMemory?: number;
  };
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const cores = nav.hardwareConcurrency ?? 4;
  const memoryGb = nav.deviceMemory ?? (mobile ? 4 : 8);

  let webgpu = false;
  let adapter = 'unknown';

  if (nav.gpu) {
    try {
      const a = (await nav.gpu.requestAdapter({ powerPreference: 'high-performance' })) as {
        info?: { vendor?: string; architecture?: string; description?: string };
      } | null;
      if (a) {
        webgpu = true;
        const info = a.info;
        adapter = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ') || 'webgpu adapter';
      }
    } catch {
      webgpu = false;
    }
  }

  if (!webgpu) {
    // Fall back to the WebGL debug renderer string, which is more descriptive.
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') as WebGL2RenderingContext | null;
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      if (gl && ext) adapter = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
      else if (gl) adapter = String(gl.getParameter(gl.RENDERER));
    } catch {
      /* keep 'unknown' */
    }
  }

  const lower = adapter.toLowerCase();
  let klass: DeviceProfile['klass'] = 'unknown';
  if (SOFTWARE_HINTS.some((h) => lower.includes(h))) klass = 'software';
  else if (mobile) klass = 'mobile';
  else if (DISCRETE_HINTS.some((h) => lower.includes(h))) klass = 'discrete';
  else if (INTEGRATED_HINTS.some((h) => lower.includes(h))) klass = 'integrated';

  let suggested: QualityTierName;
  switch (klass) {
    case 'software':
      suggested = 'potato';
      break;
    case 'mobile':
      suggested = cores >= 6 && memoryGb >= 4 ? 'medium' : 'low';
      break;
    case 'discrete':
      suggested = webgpu && cores >= 8 ? 'ultra' : 'high';
      break;
    case 'integrated':
      suggested = cores >= 8 && memoryGb >= 8 ? 'medium' : 'low';
      break;
    default:
      // Unknown hardware with WebGPU is probably modern; without it, be careful.
      suggested = webgpu ? 'high' : 'medium';
  }

  return { webgpu, adapter, klass, mobile, cores, memoryGb, suggested };
}

export interface AdaptiveOptions {
  targetFps: number;
  /** Never scale resolution below this fraction of native. */
  minScale: number;
  maxScale: number;
  enabled: boolean;
}

/**
 * Watches frame time and nudges the resolution scale to hold the target rate.
 *
 * Resolution is corrected before anything else because it is continuous and
 * reversible — dropping effects is visible and jarring, so that only happens
 * when we have run out of resolution headroom and stayed slow for a while.
 */
export class AdaptiveQuality {
  private samples: number[] = [];
  private cooldown = 0;
  private sustainedSlow = 0;
  private sustainedFast = 0;

  scale = 1;
  /** Rises when we have had to strip effects; the UI surfaces this. */
  effectReduction = 0;
  fps = 60;

  constructor(private options: AdaptiveOptions) {}

  configure(options: Partial<AdaptiveOptions>): void {
    this.options = { ...this.options, ...options };
  }

  reset(): void {
    this.samples.length = 0;
    this.cooldown = 0;
    this.sustainedSlow = 0;
    this.sustainedFast = 0;
    this.scale = 1;
    this.effectReduction = 0;
  }

  /** Feed one frame's delta in seconds. Returns true when the scale changed. */
  update(dt: number): boolean {
    // Ignore obvious hitches: tab restore, GC pause, shader compile spike.
    if (dt > 0.5 || dt <= 0) return false;

    this.samples.push(dt);
    if (this.samples.length > 90) this.samples.shift();
    if (this.samples.length < 45) return false;

    // Median is far more honest than a mean when a few frames are outliers.
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.fps = 1 / median;

    if (!this.options.enabled) return false;

    this.cooldown -= dt;
    if (this.cooldown > 0) return false;

    const target = 1 / this.options.targetFps;
    const slow = median > target * 1.18;
    const fast = median < target * 0.82;

    if (slow) {
      this.sustainedSlow++;
      this.sustainedFast = 0;
    } else if (fast) {
      this.sustainedFast++;
      this.sustainedSlow = 0;
    } else {
      this.sustainedSlow = 0;
      this.sustainedFast = 0;
      return false;
    }

    let changed = false;
    if (this.sustainedSlow >= 2) {
      if (this.scale > this.options.minScale + 1e-3) {
        this.scale = Math.max(this.options.minScale, this.scale - 0.1);
        changed = true;
      } else if (this.effectReduction < 2) {
        // Out of resolution headroom — start shedding effects instead.
        this.effectReduction++;
        changed = true;
      }
      this.sustainedSlow = 0;
      // Long cooldown after a downgrade: the fix needs time to show up in the
      // samples, and thrashing quality is worse than being slightly slow.
      this.cooldown = 2.5;
    } else if (this.sustainedFast >= 4) {
      if (this.effectReduction > 0) {
        this.effectReduction--;
        changed = true;
      } else if (this.scale < this.options.maxScale - 1e-3) {
        // Climb back more slowly than we fell, so we settle instead of oscillate.
        this.scale = Math.min(this.options.maxScale, this.scale + 0.05);
        changed = true;
      }
      this.sustainedFast = 0;
      this.cooldown = 4;
    }
    return changed;
  }
}
