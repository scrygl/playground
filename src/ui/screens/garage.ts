/**
 * The garage.
 *
 * The hard part of a ship-select screen is comparison, not display: six craft
 * with fifteen stats each is unreadable as a table and misleading as prose. So
 * the roster is a list, the selected craft gets the bars, and any second craft
 * can be pinned with a single key — its values appear as a pale overlay on the
 * same bars and each stat is coloured by whether the selection beats it. One
 * glance answers "is this faster than what I have".
 */

import { SHIPS, statBars, type ShipDefinition } from '../../game/ships';
import type { Screen, UiContext } from '../context';
import { formatCredits } from '../format';
import { icon, shipSilhouette } from '../icons';
import { getShipSafe } from './ship-utils';
import { button, cssHex, dataPair, el, hintBar, screenFrame, statBar, type StatBar } from '../widgets';

export function createGarageScreen(ctx: UiContext): Screen {
  const frame = screenFrame({ title: 'Garage', kicker: 'Hangar bay 04' });
  const root = el('div', 'vh-screen');
  root.appendChild(frame.root);

  const wallet = el('div', 'vh-wallet');
  wallet.appendChild(icon('credit', 16));
  wallet.appendChild(el('span', 'vh-wallet__label', 'Credits'));
  const walletValue = el('span', '', '0');
  wallet.appendChild(walletValue);
  frame.aside.appendChild(wallet);

  const layout = el('div', 'vh-garage');
  const list = el('div', 'vh-garage__list vh-stagger');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Craft roster');

  const detail = el('div', 'vh-garage__detail vh-cut');
  const ident = el('div', 'vh-garage__ident');
  const maker = el('p', 'vh-garage__maker');
  const name = el('h2', 'vh-garage__name');
  const blurb = el('p', 'vh-garage__blurb');
  const specs = el('div', 'vh-garage__specs');
  const specTop = dataPair('Top speed', '—');
  const specMass = dataPair('Mass', '—');
  const specShield = dataPair('Shield', '—');
  const specGroove = dataPair('Groove bonus', '—');
  specs.appendChild(specTop);
  specs.appendChild(specMass);
  specs.appendChild(specShield);
  specs.appendChild(specGroove);
  const silhouette = el('div', 'vh-garage__silhouette');
  ident.appendChild(maker);
  ident.appendChild(name);
  ident.appendChild(blurb);
  ident.appendChild(specs);
  ident.appendChild(silhouette);

  const statsCol = el('div', 'vh-garage__stats');
  const compareHead = el('div', 'vh-garage__compare');
  statsCol.appendChild(compareHead);
  const bars = new Map<string, StatBar>();
  for (const bar of statBars(SHIPS[0].stats)) {
    const widget = statBar(bar.label, bar.value);
    bars.set(bar.key, widget);
    statsCol.appendChild(widget.root);
  }

  const actions = el('div', 'vh-garage__actions');
  const price = el('div', 'vh-garage__price');
  const buyButton = button({ label: 'Purchase', kind: 'primary', iconName: 'credit', onClick: () => purchase() });
  const selectButton = button({ label: 'Select craft', kind: 'primary', iconName: 'check', onClick: () => choose() });
  const compareButton = button({ label: 'Compare', kind: 'default', iconName: 'eye', onClick: () => toggleCompare() });
  actions.appendChild(price);
  actions.appendChild(compareButton);
  actions.appendChild(buyButton);
  actions.appendChild(selectButton);

  detail.appendChild(ident);
  detail.appendChild(statsCol);
  detail.appendChild(actions);
  layout.appendChild(list);
  layout.appendChild(detail);
  frame.body.appendChild(layout);

  frame.footer.appendChild(
    hintBar([
      { keys: ['↑', '↓'], label: 'Browse roster' },
      { keys: ['Enter'], label: 'View craft' },
      { keys: ['S'], label: 'Select and return' },
      { keys: ['C'], label: 'Pin for comparison' },
      { keys: ['Esc'], label: 'Back' },
    ]),
  );

  let viewing = SHIPS[0].id;

  const owned = (id: string): boolean => ctx.host.getProfile().unlockedShips.includes(id);

  const purchase = (): void => {
    const ship = getShipSafe(viewing);
    const ok = ctx.host.purchaseShip(ship.id);
    if (ok) {
      ctx.sound('uiSelect');
      ctx.toast(`${ship.name} added to your hangar`, 'good');
      ctx.state.shipId = ship.id;
      ctx.profileChanged();
    } else {
      ctx.sound('uiError');
      const short = ship.cost - ctx.host.getProfile().credits;
      ctx.toast(`${formatCredits(Math.max(0, short))} credits short of the ${ship.name}`, 'bad');
    }
  };

  const choose = (): void => {
    if (!owned(viewing)) {
      ctx.sound('uiError');
      ctx.toast('That craft is not in your hangar yet', 'bad');
      return;
    }
    ctx.state.shipId = viewing;
    ctx.sound('uiSelect');
    ctx.back(ctx.state.returnTo);
  };

  const toggleCompare = (): void => {
    ctx.state.compareShipId = ctx.state.compareShipId === viewing ? null : viewing;
    ctx.sound('uiMove');
    render();
  };

  const setViewing = (id: string): void => {
    viewing = id;
    render();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    if (event.code === 'KeyC') {
      event.preventDefault();
      toggleCompare();
      return;
    }
    // Keyboard and gamepad players need a way to commit without hunting for
    // the button, since Enter on a roster row only previews.
    if (event.code === 'KeyS') {
      event.preventDefault();
      choose();
    }
  };

  function render(): void {
    const profile = ctx.host.getProfile();
    walletValue.textContent = formatCredits(profile.credits);

    const ship = getShipSafe(viewing);
    const compareShip: ShipDefinition | null = ctx.state.compareShipId
      ? getShipSafe(ctx.state.compareShipId)
      : null;

    // --- roster ---------------------------------------------------------
    list.replaceChildren();
    SHIPS.forEach((entry, index) => {
      const isOwned = profile.unlockedShips.includes(entry.id);
      const row = el('button', 'vh-ship-row');
      row.type = 'button';
      row.style.setProperty('--i', String(index));
      row.setAttribute('data-nav', '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', entry.id === viewing ? 'true' : 'false');
      if (entry.id === viewing) {
        row.classList.add('is-selected');
        row.setAttribute('data-nav-default', '');
      }
      if (entry.id === ctx.state.compareShipId) row.classList.add('is-compare');

      const chip = el('span', 'vh-ship-row__chip');
      chip.style.background = `linear-gradient(150deg, ${cssHex(entry.colors.trim)}, ${cssHex(entry.colors.hull)})`;
      chip.style.color = cssHex(entry.colors.engine);
      chip.appendChild(icon('craft', 18));
      row.appendChild(chip);

      const text = el('span', 'vh-ship-row__text');
      text.appendChild(el('span', 'vh-ship-row__name', entry.name));
      text.appendChild(el('span', 'vh-ship-row__maker', entry.manufacturer));
      row.appendChild(text);

      const tag = el('span', 'vh-ship-row__price');
      if (isOwned) {
        tag.classList.add('is-owned');
        tag.textContent = entry.id === ctx.state.shipId ? 'Active' : 'Owned';
        if (entry.id === ctx.state.shipId) tag.style.color = 'var(--cyan)';
      } else {
        tag.textContent = formatCredits(entry.cost);
        if (entry.cost > profile.credits) tag.classList.add('is-unaffordable');
      }
      row.appendChild(tag);

      row.addEventListener('click', (event) => {
        // Clicking the craft you are already looking at confirms it — but only
        // from a real pointer. Keyboard and gamepad focus already previews the
        // craft, so treating their Enter as that same second click would make
        // the first press leave the garage before you had seen anything.
        // A click synthesised from a key press reports `detail === 0`.
        const fromPointer = event.detail > 0;
        if (entry.id === viewing && fromPointer) choose();
        else setViewing(entry.id);
      });
      row.addEventListener('focus', () => {
        if (entry.id !== viewing) setViewing(entry.id);
      });
      list.appendChild(row);
    });

    // --- detail ---------------------------------------------------------
    maker.textContent = ship.manufacturer;
    name.textContent = ship.name;
    blurb.textContent = ship.blurb;

    silhouette.replaceChildren(shipSilhouette(ship.colors, 236));
    silhouette.style.setProperty('--engine', cssHex(ship.colors.engine));
    (specTop.lastElementChild as HTMLElement).textContent = `${Math.round(ship.stats.topSpeed * 3.6)} km/h`;
    (specMass.lastElementChild as HTMLElement).textContent = `${ship.stats.mass.toFixed(2)} t`;
    (specShield.lastElementChild as HTMLElement).textContent = String(ship.stats.shield);
    (specGroove.lastElementChild as HTMLElement).textContent = `×${ship.stats.grooveBonus.toFixed(1)}`;

    compareHead.replaceChildren();
    if (compareShip && compareShip.id !== ship.id) {
      compareHead.appendChild(el('span', '', 'Bars compared against'));
      const b = el('b', '', compareShip.name);
      compareHead.appendChild(b);
    } else {
      compareHead.appendChild(el('span', '', 'Performance'));
      compareHead.appendChild(el('span', '', 'Pin a rival with C to compare'));
    }

    const own = statBars(ship.stats);
    const other = compareShip && compareShip.id !== ship.id ? statBars(compareShip.stats) : null;
    own.forEach((entry, i) => {
      bars.get(entry.key)?.set(entry.value, other ? other[i].value : undefined);
    });

    // --- actions --------------------------------------------------------
    const isOwned = profile.unlockedShips.includes(ship.id);
    const affordable = profile.credits >= ship.cost;
    price.classList.toggle('is-locked', !isOwned && !affordable);
    if (isOwned) {
      price.textContent = ship.id === ctx.state.shipId ? 'Currently selected' : 'In your hangar';
    } else {
      price.textContent = `${formatCredits(ship.cost)} credits · you have ${formatCredits(profile.credits)}`;
    }
    buyButton.style.display = isOwned ? 'none' : '';
    buyButton.setAttribute('aria-disabled', affordable ? 'false' : 'true');
    selectButton.style.display = isOwned ? '' : 'none';
    compareButton.querySelector('.vh-btn__label')!.textContent =
      ctx.state.compareShipId === ship.id ? 'Unpin' : 'Compare';
  }

  return {
    root,
    enter() {
      viewing = ctx.state.shipId || SHIPS[0].id;
      render();
      window.addEventListener('keydown', onKey);
    },
    leave() {
      window.removeEventListener('keydown', onKey);
    },
    refresh: render,
    dispose() {
      window.removeEventListener('keydown', onKey);
    },
  };
}
