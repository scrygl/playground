/**
 * Control-binding logic, kept free of the DOM so it can be tested directly.
 *
 * The rules are the ones players expect from a racing game: two slots per
 * action, a key can only mean one thing, and rebinding a key that is already
 * used steals it from wherever it was rather than silently creating a conflict
 * the player only discovers mid-race.
 */

import { DEFAULT_BINDINGS, type ControlBindings } from '../game/profile';

export interface ActionInfo {
  id: string;
  label: string;
  group: string;
  /** Human-readable gamepad equivalent, documented next to the keys. */
  pad: string;
}

/** Presentation order and grouping for the controls screen. */
export const ACTIONS: readonly ActionInfo[] = [
  { id: 'throttle', label: 'Throttle', group: 'Driving', pad: 'Right trigger' },
  { id: 'brake', label: 'Brake', group: 'Driving', pad: 'Left trigger' },
  { id: 'steerLeft', label: 'Steer left', group: 'Driving', pad: 'Left stick ←' },
  { id: 'steerRight', label: 'Steer right', group: 'Driving', pad: 'Left stick →' },
  { id: 'airbrakeLeft', label: 'Airbrake left', group: 'Driving', pad: 'Left bumper' },
  { id: 'airbrakeRight', label: 'Airbrake right', group: 'Driving', pad: 'Right bumper' },
  { id: 'boost', label: 'Boost', group: 'Driving', pad: 'A / Cross' },
  { id: 'useItem', label: 'Use item', group: 'Driving', pad: 'X / Square' },
  { id: 'pitchUp', label: 'Pitch up', group: 'In the air', pad: 'Left stick ↑' },
  { id: 'pitchDown', label: 'Pitch down', group: 'In the air', pad: 'Left stick ↓' },
  { id: 'lookBack', label: 'Look back', group: 'Camera', pad: 'Right stick click' },
  { id: 'restart', label: 'Restart', group: 'Race', pad: 'Back / Share' },
  { id: 'pause', label: 'Pause', group: 'Race', pad: 'Start / Options' },
];

/** Gamepad reference shown alongside the key list. */
export const GAMEPAD_REFERENCE: readonly { button: string; action: string }[] = [
  { button: 'Right trigger', action: 'Throttle (analogue)' },
  { button: 'Left trigger', action: 'Brake (analogue)' },
  { button: 'Left stick', action: 'Steer, and pitch while airborne' },
  { button: 'Bumpers', action: 'Airbrakes — hold both to slow hard' },
  { button: 'A / Cross', action: 'Boost, and confirm in menus' },
  { button: 'B / Circle', action: 'Back in menus' },
  { button: 'X / Square', action: 'Use item' },
  { button: 'Y / Triangle', action: 'Cycle camera' },
  { button: 'D-pad', action: 'Navigate menus' },
  { button: 'Start / Options', action: 'Pause' },
  { button: 'Back / Share', action: 'Restart the race' },
];

/** Slots per action shown in the UI. */
export const BINDING_SLOTS = 2;

const NAMED_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Tab: 'Tab',
  CapsLock: 'Caps',
  ShiftLeft: 'L Shift',
  ShiftRight: 'R Shift',
  ControlLeft: 'L Ctrl',
  ControlRight: 'R Ctrl',
  AltLeft: 'L Alt',
  AltRight: 'R Alt',
  MetaLeft: 'L Meta',
  MetaRight: 'R Meta',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Insert: 'Ins',
  Delete: 'Del',
  Home: 'Home',
  End: 'End',
  PageUp: 'Pg Up',
  PageDown: 'Pg Dn',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
};

/** A `KeyboardEvent.code` rendered the way a keycap reads. */
export function keyLabel(code: string): string {
  if (!code) return '—';
  const named = NAMED_KEYS[code];
  if (named) return named;
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return code;
}

/** Keys the UI refuses to hand over to the game. */
const RESERVED = new Set(['Tab', 'F5', 'F11', 'F12', 'MetaLeft', 'MetaRight']);

export function isReservedKey(code: string): boolean {
  return RESERVED.has(code);
}

/**
 * Every key that currently means more than one thing, mapped to the actions
 * fighting over it. An empty map is a clean binding set.
 */
export function bindingConflicts(bindings: ControlBindings): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const [action, keys] of Object.entries(bindings)) {
    for (const key of keys ?? []) {
      if (!key) continue;
      const list = seen.get(key);
      if (list) {
        if (!list.includes(action)) list.push(action);
      } else {
        seen.set(key, [action]);
      }
    }
  }
  for (const [key, actions] of [...seen]) {
    if (actions.length < 2) seen.delete(key);
  }
  return seen;
}

/** Actions other than `exclude` that already claim `code`. */
export function actionsUsing(bindings: ControlBindings, code: string, exclude?: string): string[] {
  const out: string[] = [];
  for (const [action, keys] of Object.entries(bindings)) {
    if (action === exclude) continue;
    if ((keys ?? []).includes(code)) out.push(action);
  }
  return out;
}

export interface BindingChange {
  bindings: ControlBindings;
  /** Actions that lost the key because this one took it. */
  stolenFrom: string[];
}

/**
 * Assigns `code` to `action`'s slot, taking it away from anything else that had
 * it. Returns a fresh bindings object; the input is never mutated so the
 * settings screen can diff against what is saved.
 */
export function setBinding(
  bindings: ControlBindings,
  action: string,
  slot: number,
  code: string,
): BindingChange {
  const next: ControlBindings = {};
  const stolenFrom: string[] = [];
  for (const [id, keys] of Object.entries(bindings)) {
    next[id] = [...(keys ?? [])];
  }
  if (!next[action]) next[action] = [];

  for (const [id, keys] of Object.entries(next)) {
    if (id === action) continue;
    const idx = keys.indexOf(code);
    if (idx >= 0) {
      keys.splice(idx, 1);
      stolenFrom.push(id);
    }
  }

  // Work in a fixed-width slot array so "second key" stays the second key,
  // then compact: an action with a hole in slot 0 would render a blank keycap.
  const slots: string[] = [];
  for (let i = 0; i < BINDING_SLOTS; i++) slots.push(next[action][i] ?? '');
  for (let i = 0; i < BINDING_SLOTS; i++) if (i !== slot && slots[i] === code) slots[i] = '';
  slots[Math.max(0, Math.min(BINDING_SLOTS - 1, slot))] = code;
  next[action] = slots.filter((k) => k !== '');

  return { bindings: next, stolenFrom };
}

/** Removes one slot's key, leaving the action possibly unbound. */
export function clearBinding(bindings: ControlBindings, action: string, slot: number): ControlBindings {
  const next: ControlBindings = {};
  for (const [id, keys] of Object.entries(bindings)) next[id] = [...(keys ?? [])];
  const slots = next[action] ?? [];
  if (slot < slots.length) slots.splice(slot, 1);
  next[action] = slots;
  return next;
}

/** Actions with nothing bound at all — surfaced as a warning, not an error. */
export function unboundActions(bindings: ControlBindings): string[] {
  return ACTIONS.filter((a) => (bindings[a.id] ?? []).filter(Boolean).length === 0).map((a) => a.id);
}

export function isDefaultBindings(bindings: ControlBindings): boolean {
  const ids = new Set([...Object.keys(DEFAULT_BINDINGS), ...Object.keys(bindings)]);
  for (const id of ids) {
    const a = (DEFAULT_BINDINGS[id] ?? []).filter(Boolean);
    const b = (bindings[id] ?? []).filter(Boolean);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  }
  return true;
}

export function defaultBindings(): ControlBindings {
  const out: ControlBindings = {};
  for (const [id, keys] of Object.entries(DEFAULT_BINDINGS)) out[id] = [...keys];
  return out;
}

export function actionLabel(id: string): string {
  return ACTIONS.find((a) => a.id === id)?.label ?? id;
}
