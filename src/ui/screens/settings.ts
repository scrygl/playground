/**
 * Settings.
 *
 * Two decisions worth stating. First, changes apply immediately — there is no
 * Apply button, because the only way to judge a field-of-view or a shake
 * multiplier is to see it. Second, the live telemetry panel sits at the top
 * rather than hidden behind a toggle: the quality tier is mostly automatic, and
 * a player who does not know what the game decided cannot make a sensible
 * decision to override it.
 */

import type { GameSettings } from '../../game/profile';
import { defaultSettings } from '../../game/profile';
import type { Screen, UiContext } from '../context';
import { percent } from '../format';
import { icon } from '../icons';
import { BOUNDS, QUALITY_OPTIONS, aiDifficultyLabel, cloneSettings, sanitizeSettings } from '../validate';
import {
  button,
  dataPair,
  el,
  hintBar,
  screenFrame,
  segmentedRow,
  sliderRow,
  toggleRow,
  type SliderRow,
  type ToggleRow,
} from '../widgets';

const TIER_LABEL: Record<GameSettings['qualityTier'], string> = {
  auto: 'Auto',
  potato: 'Potato',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  ultra: 'Ultra',
};

export function createSettingsScreen(ctx: UiContext): Screen {
  const frame = screenFrame({ title: 'Settings', kicker: 'Changes apply as you make them' });
  const root = el('div', 'vh-screen');
  root.appendChild(frame.root);

  let working: GameSettings = cloneSettings(ctx.host.getProfile().settings);

  const commit = (): void => {
    working = sanitizeSettings(working);
    ctx.host.applySettings(working);
  };

  // --- telemetry ---------------------------------------------------------
  const telemetry = el('div', 'vh-telemetry vh-cut');
  const fps = dataPair('Frame rate', '—');
  const tier = dataPair('Active tier', '—');
  const scale = dataPair('Resolution', '—');
  const backend = dataPair('Backend', '—');
  telemetry.appendChild(fps);
  telemetry.appendChild(tier);
  telemetry.appendChild(scale);
  telemetry.appendChild(backend);
  const device = el('p', 'vh-telemetry__device');
  telemetry.appendChild(device);

  const describeDevice = (): void => {
    const d = ctx.host.getDevice();
    device.replaceChildren();
    device.appendChild(el('b', '', d.adapter || 'Unknown adapter'));
    device.appendChild(
      el(
        'span',
        '',
        ` — ${d.klass} class, ${d.cores} cores, ~${d.memoryGb} GB, ${d.webgpu ? 'WebGPU available' : 'WebGL2 only'}. Suggested tier: ${TIER_LABEL[d.suggested]}.`,
      ),
    );
  };

  let poll = 0;
  const readPerformance = (): void => {
    const p = ctx.host.getPerformance();
    (fps.lastElementChild as HTMLElement).textContent = String(Math.round(p.fps));
    (tier.lastElementChild as HTMLElement).textContent = TIER_LABEL[p.tier] ?? p.tier;
    (scale.lastElementChild as HTMLElement).textContent = percent(p.resolutionScale);
    (backend.lastElementChild as HTMLElement).textContent = p.backend;
  };

  // --- columns -----------------------------------------------------------
  const columns = el('div', 'vh-settings');
  const left = el('div');
  const right = el('div');
  columns.appendChild(left);
  columns.appendChild(right);

  const group = (parent: HTMLElement, title: string, note?: string): HTMLElement => {
    const g = el('section', 'vh-group');
    g.appendChild(el('h2', 'vh-group__title', title));
    if (note) g.appendChild(el('p', 'vh-group__note', note));
    parent.appendChild(g);
    return g;
  };

  const audio = group(left, 'Audio');
  const sliders: { key: keyof GameSettings; row: SliderRow }[] = [];
  const toggles: { key: keyof GameSettings; row: ToggleRow }[] = [];

  const makeSlider = (
    parent: HTMLElement,
    key: keyof GameSettings,
    label: string,
    hint: string | undefined,
    format?: (v: number) => string,
  ): SliderRow => {
    const bound = BOUNDS[key as string];
    const row = sliderRow({
      label,
      hint,
      min: bound.min,
      max: bound.max,
      step: bound.step,
      value: working[key] as number,
      format: format ?? bound.format,
      onInput: (v) => {
        (working[key] as number) = v;
        commit();
      },
    });
    parent.appendChild(row.root);
    sliders.push({ key, row });
    return row;
  };

  const makeToggle = (
    parent: HTMLElement,
    key: keyof GameSettings,
    label: string,
    hint?: string,
  ): ToggleRow => {
    const row = toggleRow({
      label,
      hint,
      value: working[key] as boolean,
      onChange: (v) => {
        (working[key] as boolean) = v;
        commit();
      },
    });
    parent.appendChild(row.root);
    toggles.push({ key, row });
    return row;
  };

  makeSlider(audio, 'masterVolume', 'Master volume', undefined);
  makeSlider(audio, 'musicVolume', 'Music', undefined);
  makeSlider(audio, 'sfxVolume', 'Effects', undefined);

  const graphics = group(right, 'Graphics');
  const tierRow = segmentedRow<GameSettings['qualityTier']>({
    label: 'Quality tier',
    hint: 'Auto lets the adaptive scaler pick, and keep picking, as the frame rate moves.',
    options: QUALITY_OPTIONS.map((v) => ({ value: v, label: TIER_LABEL[v] })),
    value: working.qualityTier,
    onChange: (v) => {
      working.qualityTier = v;
      commit();
    },
  });
  graphics.appendChild(tierRow.root);
  makeToggle(
    graphics,
    'adaptiveQuality',
    'Adaptive quality',
    'Trades resolution, then effects, to hold the target frame rate.',
  );
  makeSlider(graphics, 'targetFps', 'Target frame rate', undefined);
  makeToggle(graphics, 'forceWebGL', 'Force WebGL2', 'Use the fallback renderer even where WebGPU works. Takes effect on the next race.');
  makeToggle(graphics, 'showSpeedLines', 'Speed lines');

  const camera = group(left, 'Camera and feel');
  makeSlider(camera, 'fieldOfView', 'Field of view', undefined);
  makeSlider(camera, 'cameraShake', 'Camera shake', undefined);
  makeToggle(camera, 'reducedMotion', 'Reduced motion', 'Suppresses shake, flashing, and menu movement.');
  makeToggle(camera, 'invertPitch', 'Invert pitch');
  makeSlider(camera, 'steerDeadzone', 'Stick deadzone', undefined);

  const race = group(right, 'Race');
  makeSlider(race, 'aiDifficulty', 'Rival skill', undefined, (v) => `${aiDifficultyLabel(v)} · ${percent(v)}`);
  makeToggle(race, 'showGhost', 'Show ghost', 'Replays your best lap alongside you in time trials.');
  makeSlider(race, 'hudScale', 'HUD scale', undefined);

  const danger = group(left, 'Profile', 'Records, credits and unlocks live in this browser only.');
  const dangerActions = el('div', 'vh-garage__actions');
  dangerActions.style.borderTop = '0';
  dangerActions.style.paddingTop = '10px';
  dangerActions.appendChild(
    button({
      label: 'Restore defaults',
      kind: 'default',
      iconName: 'restart',
      onClick: () => {
        const preserved = working.bindings;
        working = sanitizeSettings({ ...defaultSettings(), bindings: preserved });
        ctx.host.applySettings(working);
        ctx.sound('uiSelect');
        ctx.toast('Settings restored to defaults');
        syncControls();
      },
    }),
  );
  dangerActions.appendChild(
    button({
      label: 'Erase profile',
      kind: 'danger',
      iconName: 'warning',
      onClick: async () => {
        const ok = await ctx.confirm(
          'Erase your profile?',
          'Every lap record, medal, credit and unlocked craft is deleted. This cannot be undone.',
        );
        if (!ok) return;
        ctx.host.resetProfile();
        ctx.toast('Profile erased', 'bad');
        ctx.profileChanged();
      },
    }),
  );
  danger.appendChild(dangerActions);

  frame.body.appendChild(telemetry);
  frame.body.appendChild(columns);
  frame.footer.appendChild(
    hintBar([
      { keys: ['↑', '↓'], label: 'Move' },
      { keys: ['←', '→'], label: 'Adjust' },
      { keys: ['Esc'], label: 'Back' },
    ]),
  );

  const hudNote = el('div', 'vh-wallet');
  hudNote.appendChild(icon('info', 15));
  hudNote.appendChild(el('span', 'vh-wallet__label', 'Applied immediately'));
  frame.footer.appendChild(hudNote);

  function syncControls(): void {
    for (const entry of sliders) entry.row.set(working[entry.key] as number);
    for (const entry of toggles) entry.row.set(working[entry.key] as boolean);
    tierRow.set(working.qualityTier);
  }

  return {
    root,
    enter() {
      working = cloneSettings(ctx.host.getProfile().settings);
      syncControls();
      describeDevice();
      readPerformance();
      poll = window.setInterval(readPerformance, 500);
    },
    leave() {
      window.clearInterval(poll);
    },
    refresh() {
      working = cloneSettings(ctx.host.getProfile().settings);
      syncControls();
    },
    dispose() {
      window.clearInterval(poll);
    },
  };
}
