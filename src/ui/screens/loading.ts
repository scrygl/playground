/**
 * Loading.
 *
 * A loading screen is dead time, so it does two jobs: it names the circuit you
 * are about to drive, at a size that makes the wait feel like an announcement,
 * and it teaches something. The tips are real advice about this game's physics
 * rather than filler.
 */

import { TRACKS_BY_ID } from '../../track/library';
import { MODES_BY_ID } from '../../game/types';
import type { Screen, UiContext } from '../context';
import { difficultyLabel, formatDistance } from '../format';
import { el, trackPreview } from '../widgets';

const TIPS: readonly { head: string; body: string }[] = [
  { head: 'Airbrakes rotate, they do not slow you', body: 'Hold one to pivot the nose into a corner while the thrust keeps working. Hold both to scrub real speed.' },
  { head: 'The bank is the corner', body: 'Get onto the banked surface early and most turns can be taken without lifting at all.' },
  { head: 'Shield is your boost tank', body: 'Every second of manual boost is shield you will not have when a wall arrives.' },
  { head: 'Chain the gates', body: 'Consecutive rhythm gates build the Groove multiplier. Missing one costs the whole chain.' },
  { head: 'Land flat', body: 'Pitch the nose down to meet the track after a jump; a nose-high landing scrubs an enormous amount of speed.' },
  { head: 'Watch the ghost delta', body: 'Green means you are ahead of your best lap at this exact point on the circuit, not overall.' },
  { head: 'Heavy craft win contact', body: 'Mass decides side-to-side collisions. The Anvil can simply drive through a Wisp.' },
  { head: 'Restart is instant', body: 'In time trial there is no penalty for abandoning a bad lap. Press restart the moment you know.' },
];

export interface LoadingScreen extends Screen {
  setProgress(progress: number, label: string): void;
}

export function createLoadingScreen(ctx: UiContext): LoadingScreen {
  const root = el('div', 'vh-screen vh-loading');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');

  const art = el('div', 'vh-loading__art');
  art.style.position = 'absolute';
  art.style.inset = '0';
  art.style.opacity = '0.16';
  art.style.pointerEvents = 'none';
  root.appendChild(art);

  const top = el('div', 'vh-loading__top');
  const kicker = el('p', 'vh-loading__kicker', 'Loading circuit');
  const track = el('h1', 'vh-loading__track', '—');
  const meta = el('p', 'vh-loading__meta', '');
  top.appendChild(kicker);
  top.appendChild(track);
  top.appendChild(meta);
  root.appendChild(top);

  const barWrap = el('div', 'vh-loading__barwrap');
  const row = el('div', 'vh-loading__row');
  const stage = el('span', '', 'Preparing');
  const pct = el('span', 'vh-loading__pct', '0%');
  row.appendChild(stage);
  row.appendChild(pct);
  const bar = el('div', 'vh-loading__bar');
  const fill = el('div', 'vh-loading__fill');
  bar.appendChild(fill);
  barWrap.appendChild(row);
  barWrap.appendChild(bar);
  root.appendChild(barWrap);

  const tip = el('div', 'vh-loading__tip');
  const tipHead = el('b');
  const tipBody = el('span');
  tip.appendChild(tipHead);
  tip.appendChild(el('span', '', ' — '));
  tip.appendChild(tipBody);
  root.appendChild(tip);

  const setProgress = (progress: number, label: string): void => {
    const p = Math.max(0, Math.min(1, progress));
    fill.style.transform = `scaleX(${p.toFixed(3)})`;
    pct.textContent = `${Math.round(p * 100)}%`;
    stage.textContent = label;
  };

  const build = (): void => {
    const definition = TRACKS_BY_ID.get(ctx.state.trackId);
    const mode = MODES_BY_ID.get(ctx.state.mode);
    track.textContent = definition?.name ?? 'Unknown circuit';
    kicker.textContent = ctx.state.championshipId
      ? `${mode?.name ?? 'Race'} · Round ${ctx.state.round + 1}`
      : (mode?.name ?? 'Race');

    try {
      const summary = ctx.host.getTrackSummary(ctx.state.trackId);
      meta.textContent = `${summary.tagline} · ${formatDistance(summary.length)} · ${summary.laps} laps · ${difficultyLabel(summary.difficulty)}`;
      art.replaceChildren(trackPreview(summary.outline, 900, 500));
      art.style.setProperty('--accent', `#${summary.palette.primary.toString(16).padStart(6, '0')}`);
    } catch {
      meta.textContent = definition?.tagline ?? '';
    }

    const pick = TIPS[Math.floor(Math.random() * TIPS.length)];
    tipHead.textContent = pick.head;
    tipBody.textContent = pick.body;
    setProgress(0, 'Preparing');
  };

  return { root, enter: build, setProgress };
}
