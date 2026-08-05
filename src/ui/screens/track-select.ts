/**
 * Circuit select.
 *
 * Every card carries a real preview: `TrackSummary.outline` drawn as an SVG
 * path, scaled to fit but never distorted, so the long sweeping circuits and
 * the tight technical ones are visibly different shapes before you drive them.
 * Locked cards say exactly what opens them — a lock with no explanation is
 * just a dead end.
 */

import { TRACKS, TRACKS_BY_ID } from '../../track/library';
import { MEDAL_ORDER } from '../../game/profile';
import { MODES_BY_ID } from '../../game/types';
import type { Screen, UiContext } from '../context';
import type { TrackSummary } from '../types';
import { difficultyBlocks, formatDistance, formatTime, MEDAL_LABEL } from '../format';
import { icon } from '../icons';
import { getShipSafe } from './ship-utils';
import { button, el, hintBar, medalBadge, screenFrame, trackPreview } from '../widgets';

function trackCard(ctx: UiContext, summary: TrackSummary, index: number, onPick: () => void): HTMLElement {
  const locked = !summary.unlocked;
  const card = el('button', `vh-card vh-track${locked ? ' is-locked' : ''}`);
  card.type = 'button';
  card.style.setProperty('--i', String(index));
  card.style.setProperty('--accent', `#${summary.palette.primary.toString(16).padStart(6, '0')}`);

  if (locked) {
    card.setAttribute('aria-disabled', 'true');
  } else {
    card.setAttribute('data-nav', '');
    if (summary.id === ctx.state.trackId) card.setAttribute('data-nav-default', '');
    card.addEventListener('click', onPick);
  }

  const art = el('div', 'vh-track__art');
  art.appendChild(trackPreview(summary.outline, 320, 180));
  if (summary.medal !== 'none') {
    const badge = el('div', 'vh-track__medal');
    badge.appendChild(medalBadge(summary.medal, 26));
    art.appendChild(badge);
  }
  const diff = el('div', 'vh-track__diff', difficultyBlocks(summary.difficulty));
  diff.setAttribute('aria-label', `Difficulty ${summary.difficulty} of 5`);
  art.appendChild(diff);
  card.appendChild(art);

  const info = el('div', 'vh-track__info');
  info.appendChild(el('h3', 'vh-track__name', summary.name));
  info.appendChild(el('p', 'vh-track__tag', summary.tagline));

  const facts = el('div', 'vh-track__facts');
  const addFact = (label: string, value: string): void => {
    const pair = el('div', 'vh-pair');
    pair.appendChild(el('span', 'vh-pair__label', label));
    pair.appendChild(el('span', 'vh-pair__value', value));
    facts.appendChild(pair);
  };
  addFact('Length', formatDistance(summary.length));
  addFact('Laps', String(summary.laps));
  addFact('Your best', Number.isFinite(summary.bestLap) ? formatTime(summary.bestLap) : '—');
  info.appendChild(facts);
  card.appendChild(info);

  if (locked) {
    const names = summary.requires
      .map((id) => TRACKS_BY_ID.get(id)?.name ?? id)
      .filter(Boolean);
    const lock = el('div', 'vh-track__lock');
    lock.appendChild(icon('lock', 16));
    lock.appendChild(
      el(
        'span',
        '',
        names.length === 0
          ? 'Locked.'
          : names.length === 1
            ? `Finish ${names[0]} to unlock.`
            : `Finish ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} to unlock.`,
      ),
    );
    card.appendChild(lock);
  } else if (summary.medal !== 'none') {
    const earned = el('div', 'vh-track__lock');
    earned.appendChild(medalBadge(summary.medal, 16));
    const target =
      MEDAL_ORDER[Math.min(MEDAL_ORDER.length - 1, MEDAL_ORDER.indexOf(summary.medal) + 1)];
    const nextTime =
      target === 'author'
        ? summary.medals.author
        : target === 'gold'
          ? summary.medals.gold
          : target === 'silver'
            ? summary.medals.silver
            : summary.medals.bronze;
    earned.appendChild(
      el(
        'span',
        '',
        summary.medal === 'author'
          ? `${MEDAL_LABEL.author} medal — nothing left to take here.`
          : `${MEDAL_LABEL[summary.medal]}. ${formatTime(nextTime)} takes ${MEDAL_LABEL[target].toLowerCase()}.`,
      ),
    );
    card.appendChild(earned);
  } else {
    const target = el('div', 'vh-track__lock');
    target.appendChild(icon('clock', 16));
    target.appendChild(el('span', '', `${formatTime(summary.medals.bronze)} takes bronze.`));
    card.appendChild(target);
  }

  return card;
}

export function createTrackSelectScreen(ctx: UiContext): Screen {
  const frame = screenFrame({ title: 'Select circuit', kicker: 'Race', wide: true });
  const root = el('div', 'vh-screen');
  root.appendChild(frame.root);

  const grid = el('div', 'vh-tracks vh-stagger');
  frame.body.appendChild(grid);

  const loadout = el('div', 'vh-loadout');
  const craftChip = el('div', 'vh-loadout__craft');
  craftChip.appendChild(icon('craft', 18));
  const craftText = el('div');
  const craftName = el('div', 'vh-loadout__name', '—');
  const craftSub = el('div', 'vh-loadout__sub', '');
  craftText.appendChild(craftName);
  craftText.appendChild(craftSub);
  craftChip.appendChild(craftText);
  loadout.appendChild(craftChip);
  loadout.appendChild(
    button({
      label: 'Change craft',
      kind: 'quiet',
      iconName: 'chevronRight',
      onClick: () => {
        ctx.state.returnTo = 'trackSelect';
        ctx.sound('uiSelect');
        ctx.go('garage');
      },
    }),
  );
  frame.aside.appendChild(loadout);

  frame.footer.appendChild(
    hintBar([
      { keys: ['←', '→', '↑', '↓'], label: 'Browse' },
      { keys: ['Enter'], label: 'Launch' },
      { keys: ['Esc'], label: 'Back' },
    ]),
  );

  const launch = (summary: TrackSummary): void => {
    ctx.state.trackId = summary.id;
    ctx.sound('uiSelect');
    const mode = MODES_BY_ID.get(ctx.state.mode);
    const profile = ctx.host.getProfile();
    ctx.host.startRace({
      mode: ctx.state.mode,
      trackId: summary.id,
      shipId: ctx.state.shipId,
      rivals: mode?.hasRivals ? 7 : 0,
      laps: summary.laps,
      difficulty: profile.settings.aiDifficulty,
      seed: `${summary.id}-${ctx.state.mode}`,
      useGhost: profile.settings.showGhost,
      ...(ctx.state.championshipId ? { championshipId: ctx.state.championshipId, round: ctx.state.round } : {}),
    });
  };

  const build = (): void => {
    grid.replaceChildren();
    const mode = MODES_BY_ID.get(ctx.state.mode);
    frame.kicker.textContent = mode ? `Race · ${mode.name}` : 'Race';
    frame.title.textContent = ctx.state.mode === 'timetrial' ? 'Set a time' : 'Select circuit';

    const ship = getShipSafe(ctx.state.shipId);
    craftName.textContent = ship.name;
    craftSub.textContent = ship.manufacturer;

    TRACKS.forEach((track, index) => {
      const summary = ctx.host.getTrackSummary(track.id);
      grid.appendChild(trackCard(ctx, summary, index, () => launch(summary)));
    });
  };

  return { root, enter: build, refresh: build };
}
