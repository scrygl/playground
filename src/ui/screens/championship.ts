/**
 * Cup select.
 *
 * Each cup shows its three rounds in running order with a preview of every
 * circuit, so the player is choosing a route rather than a name. The best
 * finishing position is the only progress state that matters here, so it is
 * shown as a real placing ("Won" / "3rd of 8") rather than a badge.
 */

import { CHAMPIONSHIPS, TRACKS_BY_ID, type ChampionshipDefinition } from '../../track/library';
import type { Screen, UiContext } from '../context';
import { ordinal } from '../format';
import { icon } from '../icons';
import { getShipSafe } from './ship-utils';
import { button, el, hintBar, screenFrame, trackPreview } from '../widgets';

export function createChampionshipScreen(ctx: UiContext): Screen {
  const frame = screenFrame({ title: 'Championship', kicker: 'Race · Series' });
  const root = el('div', 'vh-screen');
  root.appendChild(frame.root);

  const grid = el('div', 'vh-tracks vh-stagger');
  frame.body.appendChild(grid);

  // Same loadout strip as circuit select: the cup card starts the series, and
  // changing craft is an explicit side-trip. Sending the card itself to the
  // garage instead would strand the player — the garage returns here, and here
  // would send them straight back.
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
        ctx.state.returnTo = 'championship';
        ctx.sound('uiSelect');
        ctx.go('garage');
      },
    }),
  );
  frame.aside.appendChild(loadout);

  frame.footer.appendChild(
    hintBar([
      { keys: ['←', '→'], label: 'Browse cups' },
      { keys: ['Enter'], label: 'Start series' },
      { keys: ['Esc'], label: 'Back' },
    ]),
  );

  /** Puts the player on the grid for round one. Later rounds come from standings. */
  const startSeries = (cup: ChampionshipDefinition): void => {
    const summary = ctx.host.getTrackSummary(cup.tracks[0]);
    const profile = ctx.host.getProfile();
    ctx.state.mode = 'championship';
    ctx.state.championshipId = cup.id;
    ctx.state.round = 0;
    ctx.state.trackId = summary.id;
    ctx.sound('uiSelect');
    ctx.host.startRace({
      mode: 'championship',
      trackId: summary.id,
      shipId: ctx.state.shipId,
      rivals: 7,
      laps: summary.laps,
      difficulty: profile.settings.aiDifficulty,
      seed: `${summary.id}-championship`,
      useGhost: profile.settings.showGhost,
      championshipId: cup.id,
      round: 0,
    });
  };

  const build = (): void => {
    grid.replaceChildren();
    const profile = ctx.host.getProfile();

    const ship = getShipSafe(ctx.state.shipId);
    craftName.textContent = ship.name;
    craftSub.textContent = ship.manufacturer;

    CHAMPIONSHIPS.forEach((cup, index) => {
      const first = ctx.host.getTrackSummary(cup.tracks[0]);
      const locked = !first.unlocked;

      const card = el('button', `vh-card vh-track${locked ? ' is-locked' : ''}`);
      card.type = 'button';
      card.style.setProperty('--i', String(index));
      if (!locked) {
        card.setAttribute('data-nav', '');
        if (index === 0) card.setAttribute('data-nav-default', '');
      } else {
        card.setAttribute('aria-disabled', 'true');
      }

      const art = el('div', 'vh-track__art');
      art.appendChild(trackPreview(first.outline, 320, 180));
      art.style.setProperty('--accent', `#${first.palette.primary.toString(16).padStart(6, '0')}`);
      card.appendChild(art);

      const info = el('div', 'vh-track__info');
      info.appendChild(el('h3', 'vh-track__name', cup.name));
      info.appendChild(el('p', 'vh-track__tag', cup.tagline));

      const rounds = el('div', 'vh-rounds');
      cup.tracks.forEach((trackId, roundIndex) => {
        const track = TRACKS_BY_ID.get(trackId);
        const round = el('span', 'vh-round');
        round.appendChild(el('span', 'vh-round__n', `R${roundIndex + 1}`));
        round.appendChild(el('span', '', track?.name ?? trackId));
        rounds.appendChild(round);
      });
      info.appendChild(rounds);

      const best = profile.championships[cup.id];
      const result = el('div', 'vh-track__facts');
      const label = el('span', 'vh-pair__label', 'Best result');
      const value = el('span', 'vh-pair__value');
      if (best === undefined) value.textContent = 'Not attempted';
      else if (best === 1) value.textContent = 'Won';
      else value.textContent = ordinal(best);
      const pair = el('div', 'vh-pair');
      pair.appendChild(label);
      pair.appendChild(value);
      result.appendChild(pair);
      if (best === 1) {
        const won = el('div', 'vh-pair');
        won.appendChild(el('span', 'vh-pair__label', 'Trophy'));
        const trophy = el('span', 'vh-pair__value');
        trophy.appendChild(icon('trophy', 18));
        won.appendChild(trophy);
        won.style.color = 'var(--gold)';
        result.appendChild(won);
      }
      info.appendChild(result);
      card.appendChild(info);

      if (locked) {
        const lock = el('div', 'vh-track__lock');
        lock.appendChild(icon('lock', 16));
        lock.appendChild(el('span', '', `Finish ${TRACKS_BY_ID.get(cup.tracks[0])?.name ?? 'the opening circuit'} to open this cup.`));
        card.appendChild(lock);
      } else {
        card.addEventListener('click', () => startSeries(cup));
      }

      grid.appendChild(card);
    });
  };

  return { root, enter: build, refresh: build };
}
