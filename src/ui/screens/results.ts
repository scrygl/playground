/**
 * Results.
 *
 * The order here is the order a player actually wants it: where did I finish,
 * how long did it take, which lap was the good one, and only then the rewards.
 * The medal only animates when it beats what you had — a reveal that fires
 * every single race stops meaning anything by the third one.
 */

import { MEDAL_ORDER, type MedalTier } from '../../game/profile';
import type { RaceResult } from '../../game/types';
import { TRACKS_BY_ID } from '../../track/library';
import type { Screen, UiContext } from '../context';
import { MEDAL_LABEL, formatCredits, formatGap, formatTime, ordinal } from '../format';
import { icon } from '../icons';
import { button, dataPair, el, hintBar, medalBadge, screenFrame } from '../widgets';

const PLACE_WORD: Record<number, string> = {
  1: 'Circuit record holder',
  2: 'Beaten by one',
  3: 'On the podium',
};

export interface ResultsScreen extends Screen {
  present(result: RaceResult): void;
}

export function createResultsScreen(ctx: UiContext): ResultsScreen {
  const frame = screenFrame({ title: 'Race complete', kicker: 'Results' });
  const root = el('div', 'vh-screen');
  root.appendChild(frame.root);

  const layout = el('div', 'vh-results');

  // --- left: the verdict --------------------------------------------------
  const verdict = el('div', 'vh-verdict vh-cut');
  const place = el('div', 'vh-verdict__place');
  const placeNum = el('span', 'vh-verdict__num', '1');
  const placeOf = el('span', 'vh-verdict__of', 'of 8');
  place.appendChild(placeNum);
  place.appendChild(placeOf);
  const word = el('p', 'vh-verdict__word', '');
  const timeRow = el('div', 'vh-verdict__time');
  const totalTime = dataPair('Total time', '—');
  const bestLap = dataPair('Best lap', '—');
  const points = dataPair('Points', '—');
  timeRow.appendChild(totalTime);
  timeRow.appendChild(bestLap);
  timeRow.appendChild(points);

  const medalPanel = el('div', 'vh-medalreveal');
  const medalArt = el('div');
  const medalText = el('div', 'vh-medalreveal__text');
  const medalTier = el('span', 'vh-medalreveal__tier', '');
  const medalNote = el('span', 'vh-medalreveal__note', '');
  medalText.appendChild(medalTier);
  medalText.appendChild(medalNote);
  medalPanel.appendChild(medalArt);
  medalPanel.appendChild(medalText);

  const callouts = el('div', 'vh-callouts');

  verdict.appendChild(place);
  verdict.appendChild(word);
  verdict.appendChild(timeRow);
  verdict.appendChild(medalPanel);
  verdict.appendChild(callouts);

  // --- right: lap splits --------------------------------------------------
  const rightCol = el('div', 'vh-results__col');
  const laps = el('div', 'vh-laps vh-cut');
  laps.appendChild(el('h2', 'vh-laps__title', 'Lap splits'));
  const lapTable = el('div', 'vh-laptable');
  laps.appendChild(lapTable);
  rightCol.appendChild(laps);

  const orderPanel = el('div', 'vh-laps vh-cut');
  orderPanel.appendChild(el('h2', 'vh-laps__title', 'Finishing order'));
  const orderTable = el('table', 'vh-table');
  const orderBody = el('tbody');
  orderTable.appendChild(orderBody);
  orderPanel.appendChild(orderTable);
  rightCol.appendChild(orderPanel);

  layout.appendChild(verdict);
  layout.appendChild(rightCol);
  frame.body.appendChild(layout);

  // --- actions ------------------------------------------------------------
  const retry = button({
    label: 'Retry',
    kind: 'default',
    iconName: 'restart',
    onClick: () => {
      ctx.sound('uiSelect');
      ctx.host.restartRace();
    },
  });
  const next = button({
    label: 'Next round',
    kind: 'primary',
    iconName: 'chevronRight',
    autofocus: true,
    onClick: () => {
      ctx.sound('uiSelect');
      ctx.host.advanceChampionship();
    },
  });
  const menu = button({
    label: 'Back to menu',
    kind: 'quiet',
    iconName: 'home',
    onClick: () => {
      ctx.sound('uiBack');
      ctx.host.abandonRace();
      ctx.go('title');
    },
  });
  const actions = el('div', 'vh-hints');
  actions.appendChild(retry);
  actions.appendChild(next);
  actions.appendChild(menu);
  frame.footer.appendChild(
    hintBar([
      { keys: ['Enter'], label: 'Confirm' },
      { keys: ['R'], label: 'Retry' },
    ]),
  );
  frame.footer.appendChild(actions);

  const present = (result: RaceResult): void => {
    const track = TRACKS_BY_ID.get(ctx.state.trackId);
    frame.kicker.textContent = track ? `Results · ${track.name}` : 'Results';
    frame.title.textContent = result.finished ? 'Race complete' : 'Did not finish';

    placeNum.textContent = result.finished ? String(result.position) : '—';
    placeOf.textContent = `of ${result.entrants}`;
    word.textContent = result.finished
      ? (PLACE_WORD[result.position] ?? `${ordinal(result.position)} across the line`)
      : 'Your shield gave out';

    (totalTime.lastElementChild as HTMLElement).textContent = formatTime(result.totalTime);
    (bestLap.lastElementChild as HTMLElement).textContent = formatTime(result.bestLap);
    (points.lastElementChild as HTMLElement).textContent =
      result.points === undefined ? String(result.score) : `${result.points}`;
    (points.firstElementChild as HTMLElement).textContent = result.points === undefined ? 'Score' : 'Championship points';

    // --- medal ----------------------------------------------------------
    const improved = MEDAL_ORDER.indexOf(result.medal) > MEDAL_ORDER.indexOf(result.previousMedal);
    medalPanel.style.display = result.medal === 'none' && !improved ? 'none' : '';
    medalPanel.classList.toggle('is-new', improved && !ctx.options.reducedMotion);
    medalArt.replaceChildren(medalBadge(result.medal, 46));
    medalTier.textContent = `${MEDAL_LABEL[result.medal]} medal`;
    medalNote.textContent = improved
      ? result.previousMedal === 'none'
        ? 'First medal on this circuit'
        : `Up from ${MEDAL_LABEL[result.previousMedal].toLowerCase()}`
      : 'Matched your existing medal';
    medalPanel.style.setProperty('color', medalColour(result.medal));

    // --- callouts --------------------------------------------------------
    callouts.replaceChildren();
    if (result.newRecord) callouts.appendChild(callout('record', 'star', 'New personal best on this circuit'));
    if (result.creditsEarned > 0) {
      callouts.appendChild(callout('credits', 'credit', `${formatCredits(result.creditsEarned)} credits earned`));
    }
    for (const id of result.unlockedTracks) {
      const name = TRACKS_BY_ID.get(id)?.name ?? id;
      callouts.appendChild(callout('', 'route', `${name} unlocked`));
    }

    // --- laps ------------------------------------------------------------
    lapTable.replaceChildren();
    let slowest = 0;
    for (const lap of result.laps) if (Number.isFinite(lap.time) && lap.time > slowest) slowest = lap.time;
    for (const lap of result.laps) {
      const row = el('div', `vh-lap${lap.best ? ' is-best' : ''}`);
      row.appendChild(el('span', 'vh-lap__n', `L${lap.lap}`));
      const bar = el('div', 'vh-lap__bar');
      const fill = el('i');
      const t = slowest > 0 ? Math.max(0.08, lap.time / slowest) : 0;
      fill.style.transform = `scaleX(${t.toFixed(3)})`;
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el('span', 'vh-lap__t', formatTime(lap.time)));
      lapTable.appendChild(row);
    }
    if (result.laps.length === 0) {
      lapTable.appendChild(el('p', 'vh-group__note', 'No complete laps.'));
    }

    // --- finishing order -------------------------------------------------
    const order = [...result.standings].sort((a, b) => a.position - b.position);
    orderPanel.style.display = order.length > 1 ? '' : 'none';
    orderBody.replaceChildren();
    for (const racer of order) {
      const row = el('tr');
      if (racer.isPlayer) row.classList.add('is-player');
      row.appendChild(el('td', '', racer.eliminated ? '—' : String(racer.position)));
      row.appendChild(el('td', '', racer.name));
      const gapCell = el('td');
      gapCell.appendChild(
        el(
          'span',
          'vh-table__pts',
          racer.eliminated ? 'Out' : racer.position === 1 ? formatTime(racer.finishTime) : formatGap(racer.gap),
        ),
      );
      row.appendChild(gapCell);
      orderBody.appendChild(row);
    }

    // --- action visibility ----------------------------------------------
    const inSeries = ctx.state.championshipId !== null;
    next.style.display = inSeries ? '' : 'none';
    (next.querySelector('.vh-btn__label') as HTMLElement).textContent = 'Next round';
    if (!inSeries) retry.setAttribute('data-nav-default', '');
    else retry.removeAttribute('data-nav-default');
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.code === 'KeyR' && !event.repeat) {
      event.preventDefault();
      ctx.sound('uiSelect');
      ctx.host.restartRace();
    }
  };

  return {
    root,
    present,
    enter() {
      window.addEventListener('keydown', onKey);
    },
    leave() {
      window.removeEventListener('keydown', onKey);
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
    },
  };
}

function medalColour(tier: MedalTier): string {
  switch (tier) {
    case 'bronze':
      return 'var(--bronze)';
    case 'silver':
      return 'var(--silver)';
    case 'gold':
      return 'var(--gold)';
    case 'author':
      return 'var(--author)';
    default:
      return 'var(--ink-3)';
  }
}

function callout(kind: string, iconName: 'star' | 'credit' | 'route', text: string): HTMLElement {
  const node = el('div', `vh-callout${kind ? ` vh-callout--${kind}` : ''}`);
  node.appendChild(icon(iconName, 17));
  node.appendChild(el('span', '', text));
  return node;
}
