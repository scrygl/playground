/**
 * The race screen: the HUD, plus on-screen controls when there is no keyboard.
 *
 * This screen owns no logic of its own. It holds the {@link Hud} — which is
 * updated straight from the render loop and never through here — and, on touch
 * devices, a control pad that translates presses into the same
 * `KeyboardEvent`s the game already listens for. Synthesising keys rather than
 * inventing a second input path means touch and keyboard cannot drift apart,
 * and rebinding a key rebinds the touch button with it.
 */

import type { Screen, UiContext } from '../context';
import { Hud } from '../hud';
import { icon } from '../icons';
import { el } from '../widgets';

interface TouchDef {
  action: string;
  label: string;
  wide?: boolean;
  className?: string;
}

// Two thumbs: steering under the left, everything that changes speed under the
// right, with the two airbrakes on the outside edges where the index fingers
// naturally sit when the device is held in landscape.
const LEFT_ROWS: TouchDef[][] = [
  [{ action: 'airbrakeLeft', label: 'AB-L' }],
  [
    { action: 'steerLeft', label: '‹' },
    { action: 'steerRight', label: '›' },
  ],
];
const RIGHT_ROWS: TouchDef[][] = [
  [
    { action: 'boost', label: 'Boost', className: 'vh-touch__btn--boost' },
    { action: 'airbrakeRight', label: 'AB-R' },
  ],
  [
    { action: 'brake', label: 'Brake' },
    { action: 'throttle', label: 'Thrust', wide: true },
  ],
];

export function createRaceScreen(ctx: UiContext, hud: Hud): Screen {
  const root = el('div', 'vh-screen vh-screen--race');
  root.appendChild(hud.root);

  if (ctx.options.touch) {
    root.appendChild(buildTouch(ctx));
    // The HUD's bottom clusters lift clear of the pads; see styles.css.
    hud.root.classList.add('has-touch');
  }

  return {
    root,
    enter() {
      try {
        hud.setTrack(ctx.host.getTrackSummary(ctx.state.trackId));
      } catch {
        hud.setTrack(null);
      }
      hud.setScale(ctx.options.hudScale);
    },
  };
}

function buildTouch(ctx: UiContext): HTMLElement {
  const wrap = el('div', 'vh-touch');
  const left = el('div', 'vh-touch__pad vh-touch__pad--left');
  const right = el('div', 'vh-touch__pad vh-touch__pad--right');

  const codesFor = (action: string): string[] => {
    const bindings = ctx.host.getProfile().settings.bindings;
    const keys = (bindings[action] ?? []).filter(Boolean);
    return keys.length > 0 ? keys : [];
  };

  const make = (def: TouchDef): HTMLElement => {
    const b = el('div', `vh-touch__btn${def.wide ? ' vh-touch__btn--wide' : ''}${def.className ? ` ${def.className}` : ''}`);
    b.setAttribute('role', 'button');
    b.setAttribute('aria-label', def.label);
    b.textContent = def.label;

    let held: string[] = [];
    const down = (event: PointerEvent): void => {
      event.preventDefault();
      if (held.length > 0) return;
      held = codesFor(def.action);
      b.classList.add('is-down');
      b.setPointerCapture(event.pointerId);
      for (const code of held) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
      }
    };
    const up = (): void => {
      if (held.length === 0) return;
      b.classList.remove('is-down');
      for (const code of held) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
      }
      held = [];
    };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('pointerleave', up);
    return b;
  };

  for (const row of LEFT_ROWS) {
    const line = el('div', 'vh-touch__row');
    for (const def of row) line.appendChild(make(def));
    left.appendChild(line);
  }
  for (const row of RIGHT_ROWS) {
    const line = el('div', 'vh-touch__row');
    for (const def of row) line.appendChild(make(def));
    right.appendChild(line);
  }

  const pause = el('div', 'vh-touch__btn vh-touch__pause');
  pause.setAttribute('role', 'button');
  pause.setAttribute('aria-label', 'Pause');
  pause.appendChild(icon('pause', 18));
  pause.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', key: 'Escape', bubbles: true }));
  });

  wrap.appendChild(left);
  wrap.appendChild(right);
  wrap.appendChild(pause);
  return wrap;
}
