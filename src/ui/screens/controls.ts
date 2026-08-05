/**
 * Key rebinding.
 *
 * The capture flow is the whole screen: click a keycap, the interface stops
 * listening as a menu and starts listening as a recorder, and the next key you
 * press becomes that binding. A key that already meant something else is taken
 * from it and the theft is announced, because the alternative — refusing the
 * bind, or allowing a silent duplicate — both end with a player discovering the
 * problem at 180 m/s.
 */

import type { ControlBindings, GameSettings } from '../../game/profile';
import type { Screen, UiContext } from '../context';
import {
  ACTIONS,
  BINDING_SLOTS,
  GAMEPAD_REFERENCE,
  actionLabel,
  bindingConflicts,
  defaultBindings,
  isDefaultBindings,
  isReservedKey,
  keyLabel,
  setBinding,
  unboundActions,
} from '../bindings';
import { icon } from '../icons';
import { cloneSettings } from '../validate';
import { button, el, hintBar, keycap, screenFrame } from '../widgets';

export function createControlsScreen(ctx: UiContext): Screen {
  const frame = screenFrame({ title: 'Controls', kicker: 'Keyboard and gamepad' });
  const root = el('div', 'vh-screen');
  root.appendChild(frame.root);

  const columns = el('div', 'vh-settings');
  const left = el('div');
  const right = el('div');
  columns.appendChild(left);
  columns.appendChild(right);
  frame.body.appendChild(columns);

  const warning = el('div', 'vh-warn');
  warning.appendChild(icon('warning', 17));
  const warningText = el('span');
  warning.appendChild(warningText);
  warning.style.display = 'none';
  left.appendChild(warning);

  const list = el('div', 'vh-bindings');
  left.appendChild(list);

  const padGroup = el('section', 'vh-group');
  padGroup.appendChild(el('h2', 'vh-group__title', 'Gamepad'));
  padGroup.appendChild(
    el('p', 'vh-group__note', 'Standard mapping, detected automatically. Nothing here needs configuring.'),
  );
  const padRef = el('div', 'vh-padref');
  for (const entry of GAMEPAD_REFERENCE) {
    padRef.appendChild(el('span', 'vh-padref__btn', entry.button));
    padRef.appendChild(el('span', 'vh-padref__act', entry.action));
  }
  padGroup.appendChild(padRef);
  right.appendChild(padGroup);

  const menuGroup = el('section', 'vh-group');
  menuGroup.appendChild(el('h2', 'vh-group__title', 'Menus'));
  const menuRef = el('div', 'vh-padref');
  const menuRows: [string, string][] = [
    ['Arrows / WASD', 'Move between controls'],
    ['Enter / Space', 'Choose'],
    ['Esc / Backspace', 'Go back'],
    ['C', 'Pin a craft for comparison in the garage'],
  ];
  for (const [k, v] of menuRows) {
    menuRef.appendChild(el('span', 'vh-padref__btn', k));
    menuRef.appendChild(el('span', 'vh-padref__act', v));
  }
  menuGroup.appendChild(menuRef);
  right.appendChild(menuGroup);

  const resetButton = button({
    label: 'Reset to defaults',
    kind: 'default',
    iconName: 'restart',
    onClick: async () => {
      const ok = await ctx.confirm('Reset every binding?', 'All keys go back to the factory layout.');
      if (!ok) return;
      working.bindings = defaultBindings();
      persist();
      ctx.toast('Bindings reset');
      render();
    },
  });
  frame.aside.appendChild(resetButton);

  frame.footer.appendChild(
    hintBar([
      { keys: ['↑', '↓'], label: 'Move' },
      { keys: ['Enter'], label: 'Rebind' },
      { keys: ['Esc'], label: 'Back' },
    ]),
  );

  let working: GameSettings = cloneSettings(ctx.host.getProfile().settings);
  let listening: { action: string; slot: number; el: HTMLElement } | null = null;

  const persist = (): void => {
    ctx.host.applySettings(working);
  };

  const stopListening = (): void => {
    if (!listening) return;
    listening.el.classList.remove('is-listening');
    listening.el.removeAttribute('data-nav-capture');
    listening = null;
    window.removeEventListener('keydown', onCapture, true);
  };

  function onCapture(event: KeyboardEvent): void {
    if (!listening) return;
    event.preventDefault();
    event.stopPropagation();
    const code = event.code;

    if (code === 'Escape') {
      ctx.sound('uiBack');
      stopListening();
      render();
      return;
    }
    if (isReservedKey(code)) {
      ctx.sound('uiError');
      ctx.toast(`${keyLabel(code)} is reserved by the browser`, 'bad');
      return;
    }

    const change: { bindings: ControlBindings; stolenFrom: string[] } = setBinding(
      working.bindings,
      listening.action,
      listening.slot,
      code,
    );
    working.bindings = change.bindings;
    persist();
    ctx.sound('uiSelect');
    if (change.stolenFrom.length > 0) {
      ctx.toast(`${keyLabel(code)} taken from ${change.stolenFrom.map(actionLabel).join(', ')}`, 'info');
    }
    stopListening();
    render();
  }

  const startListening = (action: string, slot: number, target: HTMLElement): void => {
    stopListening();
    listening = { action, slot, el: target };
    target.classList.add('is-listening');
    target.setAttribute('data-nav-capture', '');
    ctx.sound('uiMove');
    window.addEventListener('keydown', onCapture, true);
  };

  function render(): void {
    const conflicts = bindingConflicts(working.bindings);
    const unbound = unboundActions(working.bindings);

    if (conflicts.size > 0) {
      warning.style.display = '';
      const parts: string[] = [];
      for (const [code, actions] of conflicts) {
        parts.push(`${keyLabel(code)} is bound to ${actions.map(actionLabel).join(' and ')}`);
      }
      warningText.textContent = `${parts.join('; ')}.`;
    } else if (unbound.length > 0) {
      warning.style.display = '';
      warningText.textContent = `No key bound for ${unbound.map(actionLabel).join(', ')}.`;
    } else {
      warning.style.display = 'none';
    }

    resetButton.setAttribute('aria-disabled', isDefaultBindings(working.bindings) ? 'true' : 'false');

    list.replaceChildren();
    let currentGroup = '';
    ACTIONS.forEach((action, index) => {
      if (action.group !== currentGroup) {
        currentGroup = action.group;
        const heading = el('h2', 'vh-group__title', currentGroup);
        heading.style.marginTop = index === 0 ? '0' : '22px';
        list.appendChild(heading);
      }

      const keys = (working.bindings[action.id] ?? []).filter(Boolean);
      const row = el('div', 'vh-binding');
      const conflicted = keys.some((k) => conflicts.has(k));
      if (conflicted) row.classList.add('has-conflict');
      row.appendChild(el('span', 'vh-binding__label', action.label));

      const keyWrap = el('div', 'vh-binding__keys');
      for (let slot = 0; slot < BINDING_SLOTS; slot++) {
        const code = keys[slot] ?? '';
        const b = el('button', 'vh-keybtn');
        b.type = 'button';
        b.setAttribute('data-nav', '');
        b.setAttribute(
          'aria-label',
          code ? `${action.label}, key ${slot + 1}: ${keyLabel(code)}. Press to rebind.` : `${action.label}, add key ${slot + 1}`,
        );
        const cap = keycap(code ? keyLabel(code) : '+');
        if (!code) cap.classList.add('is-empty');
        if (code && conflicts.has(code)) cap.classList.add('is-conflict');
        b.appendChild(cap);
        b.addEventListener('click', () => startListening(action.id, slot, b));
        keyWrap.appendChild(b);
      }
      row.appendChild(keyWrap);
      row.appendChild(el('span', 'vh-binding__pad', action.pad));
      list.appendChild(row);
    });
  }

  return {
    root,
    enter() {
      working = cloneSettings(ctx.host.getProfile().settings);
      render();
    },
    leave: stopListening,
    refresh() {
      working = cloneSettings(ctx.host.getProfile().settings);
      render();
    },
    dispose: stopListening,
  };
}
