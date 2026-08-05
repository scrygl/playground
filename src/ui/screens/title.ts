/**
 * Boot and title.
 *
 * Boot exists for one reason: browsers will not let audio start without a real
 * user gesture, so the game needs a gate before anything makes a sound. Rather
 * than apologising for that with a modal, it is the "press any key" screen —
 * the oldest idiom in the medium, and the one place the wordmark gets the whole
 * frame to itself.
 */

import { MEDAL_ORDER, type Profile } from '../../game/profile';
import { TRACKS } from '../../track/library';
import type { Screen, UiContext } from '../context';
import { monogram } from '../icons';
import { formatCredits, formatDistance } from '../format';
import { append, dataPair, el, hintBar, menuItem } from '../widgets';

function wordmark(size: 'hero' | 'compact'): HTMLElement {
  const wrap = el('div', 'vh-title__mark');
  wrap.appendChild(monogram(size === 'hero' ? 88 : 54));
  const word = el('div', 'vh-title__word');
  word.appendChild(el('div', 'vh-title__line1', 'Velocity'));
  word.appendChild(el('div', 'vh-title__line2', 'Horizon'));
  wrap.appendChild(word);
  return wrap;
}

export function createBootScreen(ctx: UiContext): Screen {
  const root = el('div', 'vh-screen vh-title');
  root.setAttribute('aria-label', 'Velocity Horizon');

  root.appendChild(wordmark('hero'));
  root.appendChild(el('div', 'vh-title__rule'));
  root.appendChild(el('p', 'vh-title__tag', 'Anti-gravity racing at the edge of the belt'));

  const gate = el('div', 'vh-gate');
  const gateButton = el('button', 'vh-gate__button', 'Press any key');
  gateButton.type = 'button';
  gateButton.setAttribute('data-nav', '');
  gateButton.setAttribute('data-nav-default', '');
  gate.appendChild(gateButton);
  gate.appendChild(
    el(
      'p',
      'vh-gate__note',
      'Sound needs a keypress before it can start — this one wakes the audio engine as well as the menus.',
    ),
  );
  root.appendChild(gate);
  root.appendChild(el('div', 'vh-title__version', 'build 1.0.0 · webgpu'));

  let armed = false;
  const enter = (): void => {
    if (!armed) return;
    armed = false;
    ctx.host.unlockAudio();
    ctx.sound('uiSelect');
    ctx.go('title');
  };

  gateButton.addEventListener('click', enter);
  const onKey = (event: KeyboardEvent): void => {
    if (event.repeat || !armed) return;
    // Modifier-only presses are not an answer to "press any key".
    if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return;
    event.preventDefault();
    enter();
  };
  const onPointer = (): void => enter();

  return {
    root,
    enter() {
      armed = true;
      window.addEventListener('keydown', onKey);
      root.addEventListener('pointerdown', onPointer);
    },
    leave() {
      armed = false;
      window.removeEventListener('keydown', onKey);
      root.removeEventListener('pointerdown', onPointer);
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
    },
  };
}

function medalTally(profile: Profile): string {
  let best = 0;
  let counted = 0;
  for (const record of Object.values(profile.records)) {
    const rank = MEDAL_ORDER.indexOf(record.medal);
    if (rank > 0) {
      counted++;
      best += rank;
    }
  }
  const max = TRACKS.length * 4;
  return `${best} / ${max}${counted === 0 ? '' : ''}`;
}

export function createTitleScreen(ctx: UiContext): Screen {
  const root = el('div', 'vh-screen vh-title');

  root.appendChild(wordmark('compact'));
  root.appendChild(el('div', 'vh-title__rule'));

  const menu = el('nav', 'vh-title__menu vh-stagger');
  menu.setAttribute('aria-label', 'Main menu');
  append(
    menu,
    menuItem({
      label: 'Race',
      detail: 'Championships, time trials, and five more ways to lose',
      iconName: 'flag',
      autofocus: true,
      onClick: () => ctx.go('mode'),
    }),
    menuItem({
      label: 'Garage',
      detail: 'Compare, buy, and pick your craft',
      iconName: 'craft',
      onClick: () => {
        ctx.state.returnTo = 'title';
        ctx.go('garage');
      },
    }),
    menuItem({ label: 'Settings', detail: 'Audio, visuals, and performance', iconName: 'cog', onClick: () => ctx.go('settings') }),
    menuItem({ label: 'Controls', detail: 'Rebind keys and read the pad layout', iconName: 'keyboard', onClick: () => ctx.go('controls') }),
    menuItem({ label: 'Credits', detail: 'Who built the circuit', iconName: 'info', onClick: () => ctx.go('credits') }),
  );
  root.appendChild(menu);

  const stats = el('div', 'vh-title__stats');
  const credits = dataPair('Credits', '0');
  const races = dataPair('Races', '0');
  const medals = dataPair('Medals', '0');
  const distance = dataPair('Distance', '0 m');
  append(stats, credits, races, medals, distance);
  root.appendChild(stats);

  const hints = hintBar([
    { keys: ['↑', '↓'], label: 'Move' },
    { keys: ['Enter'], label: 'Select' },
    { keys: ['Esc'], label: 'Back' },
  ]);
  hints.classList.add('vh-title__hints');
  root.appendChild(hints);
  root.appendChild(el('div', 'vh-title__version', 'build 1.0.0'));

  const refresh = (): void => {
    const profile = ctx.host.getProfile();
    (credits.lastElementChild as HTMLElement).textContent = formatCredits(profile.credits);
    (races.lastElementChild as HTMLElement).textContent = String(profile.totalRaces);
    (medals.lastElementChild as HTMLElement).textContent = medalTally(profile);
    (distance.lastElementChild as HTMLElement).textContent = formatDistance(profile.totalDistance);
  };

  return { root, enter: refresh, refresh };
}
