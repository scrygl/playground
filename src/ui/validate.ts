/**
 * Settings validation.
 *
 * The settings screen writes straight into a working copy of `GameSettings`
 * and hands it to the host, so this is the one place that guarantees a slider
 * dragged to an extreme, a stale saved profile, or a hand-edited localStorage
 * blob cannot put an out-of-range number into the renderer.
 */

import type { GameSettings } from '../game/profile';
import { defaultSettings } from '../game/profile';
import { TIER_ORDER } from '../core/quality';

export interface Bound {
  min: number;
  max: number;
  step: number;
  /** Rendered next to the slider. */
  format: (v: number) => string;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

export const BOUNDS: Record<string, Bound> = {
  masterVolume: { min: 0, max: 1, step: 0.01, format: pct },
  musicVolume: { min: 0, max: 1, step: 0.01, format: pct },
  sfxVolume: { min: 0, max: 1, step: 0.01, format: pct },
  targetFps: { min: 30, max: 240, step: 5, format: (v) => `${Math.round(v)} fps` },
  cameraShake: { min: 0, max: 1.5, step: 0.05, format: pct },
  fieldOfView: { min: 60, max: 110, step: 1, format: (v) => `${Math.round(v)}°` },
  steerDeadzone: { min: 0, max: 0.4, step: 0.01, format: pct },
  aiDifficulty: { min: 0, max: 1, step: 0.01, format: pct },
  hudScale: { min: 0.7, max: 1.4, step: 0.05, format: (v) => `${v.toFixed(2)}×` },
};

export const QUALITY_OPTIONS: readonly GameSettings['qualityTier'][] = ['auto', ...TIER_ORDER];

export function clampTo(bound: Bound, value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const clamped = Math.min(bound.max, Math.max(bound.min, value));
  // Snap to the slider's own step so the readout and the stored value agree.
  const snapped = Math.round(clamped / bound.step) * bound.step;
  return Math.round(snapped * 1e6) / 1e6;
}

/** Difficulty presets the AI slider snaps to, for players who do not want a number. */
export const AI_PRESETS: readonly { label: string; value: number }[] = [
  { label: 'Novice', value: 0.3 },
  { label: 'Racer', value: 0.5 },
  { label: 'Veteran', value: 0.68 },
  { label: 'Elite', value: 0.85 },
  { label: 'Nightmare', value: 1 },
];

export function aiDifficultyLabel(value: number): string {
  let best = AI_PRESETS[0];
  let bestDist = Infinity;
  for (const preset of AI_PRESETS) {
    const d = Math.abs(preset.value - value);
    if (d < bestDist) {
      bestDist = d;
      best = preset;
    }
  }
  return best.label;
}

/**
 * Returns a settings object guaranteed safe to hand to the renderer and audio
 * engine: every number in range, every enum a real member, bindings present.
 */
export function sanitizeSettings(input: Partial<GameSettings> | null | undefined): GameSettings {
  const base = defaultSettings();
  if (!input) return base;
  const out: GameSettings = { ...base, ...input };

  for (const [key, bound] of Object.entries(BOUNDS)) {
    const k = key as keyof GameSettings;
    out[k] = clampTo(bound, out[k] as number, base[k] as number) as never;
  }

  if (!QUALITY_OPTIONS.includes(out.qualityTier)) out.qualityTier = base.qualityTier;
  out.adaptiveQuality = Boolean(out.adaptiveQuality);
  out.reducedMotion = Boolean(out.reducedMotion);
  out.forceWebGL = Boolean(out.forceWebGL);
  out.showGhost = Boolean(out.showGhost);
  out.invertPitch = Boolean(out.invertPitch);
  out.showSpeedLines = Boolean(out.showSpeedLines);

  const bindings = out.bindings && typeof out.bindings === 'object' ? out.bindings : base.bindings;
  const cleaned: GameSettings['bindings'] = {};
  for (const [action, keys] of Object.entries(bindings)) {
    cleaned[action] = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string' && k.length > 0).slice(0, 2) : [];
  }
  out.bindings = cleaned;

  return out;
}

/** Deep-ish copy used as the settings screen's working buffer. */
export function cloneSettings(settings: GameSettings): GameSettings {
  const bindings: GameSettings['bindings'] = {};
  for (const [action, keys] of Object.entries(settings.bindings ?? {})) bindings[action] = [...keys];
  return { ...settings, bindings };
}
