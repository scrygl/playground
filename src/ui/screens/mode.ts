/**
 * Mode select.
 *
 * A list on the left, a single detail panel on the right that follows focus.
 * The description is the mode's own copy from `game/types.ts` — the menu does
 * not paraphrase the rules, because a mode whose rules change should not need
 * its explanation changed in two places.
 */

import { MODES, type ModeInfo } from '../../game/types';
import type { Screen, UiContext } from '../context';
import { icon } from '../icons';
import { append, dataPair, el, hintBar, menuItem, screenFrame } from '../widgets';

const MODE_ICONS: Record<string, 'trophy' | 'flag' | 'clock' | 'shield' | 'bolt' | 'gauge' | 'route'> = {
  championship: 'trophy',
  quick: 'flag',
  timetrial: 'clock',
  elimination: 'shield',
  pursuit: 'bolt',
  zone: 'gauge',
  endless: 'route',
};

export function createModeScreen(ctx: UiContext): Screen {
  const frame = screenFrame({ title: 'Choose a discipline', kicker: 'Race' });
  const root = el('div', 'vh-screen');
  root.appendChild(frame.root);

  const layout = el('div', 'vh-modes');
  const list = el('nav', 'vh-modes__list vh-stagger');
  list.setAttribute('aria-label', 'Race modes');

  const detail = el('div', 'vh-modes__detail vh-cut');
  const name = el('h2', 'vh-modes__name');
  const tag = el('p', 'vh-modes__tag');
  const body = el('p', 'vh-modes__body');
  const facts = el('div', 'vh-modes__facts');
  const rivals = dataPair('Grid', '—');
  const scored = dataPair('Progression', '—');
  const rounds = dataPair('Length', '—');
  append(facts, rivals, scored, rounds);
  // A watermark of the mode's own mark fills the panel without inventing copy
  // that would only repeat the description.
  const watermark = el('div', 'vh-modes__mark');
  append(detail, tag, name, body, watermark, facts);

  const setDetail = (mode: ModeInfo): void => {
    watermark.replaceChildren(icon(MODE_ICONS[mode.id] ?? 'flag', 300));
    name.textContent = mode.name;
    tag.textContent = mode.tagline;
    body.textContent = mode.description;
    (rivals.lastElementChild as HTMLElement).textContent = mode.hasRivals ? 'Full grid of rivals' : 'You, alone';
    (scored.lastElementChild as HTMLElement).textContent = mode.scored ? 'Earns credits and unlocks' : 'Practice only';
    (rounds.lastElementChild as HTMLElement).textContent =
      mode.id === 'championship' ? 'Three rounds' : mode.id === 'endless' || mode.id === 'zone' ? 'Until you fail' : 'Single race';
  };

  const commit = (mode: ModeInfo): void => {
    ctx.state.mode = mode.id;
    ctx.sound('uiSelect');
    if (mode.id === 'championship') {
      ctx.go('championship');
      return;
    }
    ctx.state.championshipId = null;
    ctx.state.round = 0;
    ctx.go('trackSelect');
  };

  MODES.forEach((mode, i) => {
    const item = menuItem({
      label: mode.name,
      detail: mode.tagline,
      iconName: MODE_ICONS[mode.id] ?? 'flag',
      autofocus: i === 0,
      onClick: () => commit(mode),
    });
    item.style.setProperty('--i', String(i));
    item.addEventListener('focus', () => setDetail(mode));
    item.addEventListener('pointerenter', () => setDetail(mode));
    list.appendChild(item);
  });
  setDetail(MODES[0]);

  layout.appendChild(list);
  layout.appendChild(detail);
  frame.body.appendChild(layout);

  frame.footer.appendChild(
    hintBar([
      { keys: ['↑', '↓'], label: 'Browse' },
      { keys: ['Enter'], label: 'Choose' },
      { keys: ['Esc'], label: 'Back' },
    ]),
  );

  return { root };
}
