/**
 * Pause.
 *
 * Deliberately a small panel over a blurred race rather than a full-screen
 * takeover: you are still in the race, and seeing the circuit sitting there
 * frozen behind the menu is what makes that obvious.
 */

import { TRACKS_BY_ID } from '../../track/library';
import { MODES_BY_ID } from '../../game/types';
import type { Screen, UiContext } from '../context';
import { append, el, hintBar, menuItem } from '../widgets';

export function createPausedScreen(ctx: UiContext): Screen {
  const root = el('div', 'vh-screen vh-paused');
  const panel = el('div', 'vh-paused__panel vh-cut');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Paused');

  const title = el('h1', 'vh-paused__title', 'Paused');
  const sub = el('p', 'vh-paused__sub', '');
  panel.appendChild(title);
  panel.appendChild(sub);

  const menu = el('nav', 'vh-paused__menu');
  append(
    menu,
    menuItem({
      label: 'Resume',
      detail: 'Back to the circuit',
      iconName: 'play',
      autofocus: true,
      onClick: () => {
        ctx.sound('uiSelect');
        ctx.host.resumeRace();
      },
    }),
    menuItem({
      label: 'Restart',
      detail: 'From the grid, same craft',
      iconName: 'restart',
      onClick: () => {
        ctx.sound('uiSelect');
        ctx.host.restartRace();
      },
    }),
    menuItem({
      label: 'Settings',
      detail: 'Audio, visuals, controls',
      iconName: 'cog',
      onClick: () => {
        ctx.state.returnTo = 'paused';
        ctx.go('settings');
      },
    }),
    menuItem({
      label: 'Quit to menu',
      detail: 'Abandon this race',
      iconName: 'home',
      onClick: async () => {
        const ok = await ctx.confirm('Abandon the race?', 'Your progress in this race will be lost.');
        if (!ok) return;
        ctx.host.abandonRace();
      },
    }),
  );
  panel.appendChild(menu);

  const hints = hintBar([
    { keys: ['Esc'], label: 'Resume' },
    { keys: ['Enter'], label: 'Select' },
  ]);
  hints.style.marginTop = '18px';
  hints.style.paddingTop = '14px';
  hints.style.borderTop = '1px solid var(--edge)';
  panel.appendChild(hints);

  root.appendChild(panel);

  return {
    root,
    enter() {
      const track = TRACKS_BY_ID.get(ctx.state.trackId);
      const mode = MODES_BY_ID.get(ctx.state.mode);
      sub.textContent = `${mode?.name ?? 'Race'} · ${track?.name ?? 'Unknown circuit'}`;
    },
  };
}
