/**
 * Championship standings between rounds.
 *
 * The round strip along the top is the point of the screen: a points table on
 * its own does not tell you how much of the series is left, and in a
 * three-round cup that is most of the tension.
 */

import { CHAMPIONSHIPS, TRACKS_BY_ID } from '../../track/library';
import type { ChampionshipState } from '../../game/types';
import type { Screen, UiContext } from '../context';
import { icon } from '../icons';
import { button, el, hintBar, screenFrame } from '../widgets';

export interface StandingsScreen extends Screen {
  present(state: ChampionshipState): void;
}

export function createStandingsScreen(ctx: UiContext): StandingsScreen {
  const frame = screenFrame({ title: 'Standings', kicker: 'Championship' });
  const root = el('div', 'vh-screen');
  root.appendChild(frame.root);

  const wrap = el('div', 'vh-standings');
  const rounds = el('div', 'vh-rounds');
  const panel = el('div', 'vh-laps vh-cut');
  const table = el('table', 'vh-table');
  const head = el('thead');
  const headRow = el('tr');
  for (const label of ['', 'Racer', 'Points']) headRow.appendChild(el('th', '', label));
  head.appendChild(headRow);
  const bodyRows = el('tbody');
  table.appendChild(head);
  table.appendChild(bodyRows);
  panel.appendChild(table);
  wrap.appendChild(rounds);
  wrap.appendChild(panel);
  frame.body.appendChild(wrap);

  const nextButton = button({
    label: 'Next round',
    kind: 'primary',
    iconName: 'chevronRight',
    autofocus: true,
    onClick: () => {
      ctx.sound('uiSelect');
      ctx.host.advanceChampionship();
    },
  });
  const menuButton = button({
    label: 'Leave series',
    kind: 'quiet',
    iconName: 'home',
    onClick: () => {
      ctx.sound('uiBack');
      ctx.state.championshipId = null;
      ctx.go('title');
    },
  });
  const actions = el('div', 'vh-hints');
  actions.appendChild(menuButton);
  actions.appendChild(nextButton);
  frame.footer.appendChild(hintBar([{ keys: ['Enter'], label: 'Continue' }]));
  frame.footer.appendChild(actions);

  const present = (state: ChampionshipState): void => {
    const cup = CHAMPIONSHIPS.find((c) => c.id === state.id);
    frame.kicker.textContent = cup ? `Championship · ${cup.name}` : 'Championship';
    frame.title.textContent = state.finished ? 'Final standings' : `After round ${state.round}`;

    rounds.replaceChildren();
    state.tracks.forEach((trackId, index) => {
      const done = index < state.round;
      const current = index === state.round && !state.finished;
      const chip = el('span', `vh-round${done ? ' is-done' : ''}${current ? ' is-current' : ''}`);
      chip.appendChild(el('span', 'vh-round__n', `R${index + 1}`));
      chip.appendChild(el('span', '', TRACKS_BY_ID.get(trackId)?.name ?? trackId));
      if (done) chip.appendChild(icon('check', 15));
      rounds.appendChild(chip);
    });

    bodyRows.replaceChildren();
    const sorted = [...state.standings].sort((a, b) => b.points - a.points);
    sorted.forEach((entry, index) => {
      const row = el('tr');
      if (entry.isPlayer) row.classList.add('is-player');
      row.appendChild(el('td', '', String(index + 1)));
      row.appendChild(el('td', '', entry.name));
      const pts = el('td');
      pts.appendChild(el('span', 'vh-table__pts', String(entry.points)));
      row.appendChild(pts);
      bodyRows.appendChild(row);
    });

    (nextButton.querySelector('.vh-btn__label') as HTMLElement).textContent = state.finished
      ? 'Finish series'
      : `Round ${state.round + 1}`;
  };

  return { root, present };
}
