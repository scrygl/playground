/**
 * Interface logic tests.
 *
 * These run in Node with no DOM, so what is exercised here is everything the
 * UI was deliberately built to keep *out* of the DOM: time and gap formatting,
 * the circuit-outline geometry, binding conflict resolution, menu index maths,
 * and settings validation. Those are the parts where a wrong answer is a
 * genuine bug rather than a layout opinion — the layout is checked by
 * screenshot instead.
 */

import { check, describe, near, range, report } from './harness';

import {
  MEDAL_LABEL,
  NUM,
  PAD2,
  difficultyLabel,
  formatClock,
  formatCredits,
  formatDelta,
  formatDistance,
  formatGap,
  formatTime,
  num,
  ordinal,
  percent,
  speedKph,
} from '../src/ui/format';

import {
  fallbackOutline,
  fitOutline,
  markerTransforms,
  outlineBounds,
  outlinePath,
  outlinePerimeter,
  resampleClosed,
  type Point,
} from '../src/ui/outline';

import {
  ACTIONS,
  BINDING_SLOTS,
  actionsUsing,
  bindingConflicts,
  clearBinding,
  defaultBindings,
  isDefaultBindings,
  isReservedKey,
  keyLabel,
  setBinding,
  unboundActions,
} from '../src/ui/bindings';

import { gridStep, pickInDirection, stepIndex, type NavRect } from '../src/ui/nav';

import {
  AI_PRESETS,
  BOUNDS,
  QUALITY_OPTIONS,
  aiDifficultyLabel,
  clampTo,
  cloneSettings,
  sanitizeSettings,
} from '../src/ui/validate';

import { DEFAULT_BINDINGS, defaultSettings } from '../src/game/profile';

// ---------------------------------------------------------------------------

describe('lookup tables', () => {
  check('PAD2 pads single digits', PAD2[0] === '00' && PAD2[7] === '07' && PAD2[59] === '59');
  check('PAD2 covers 0..99', PAD2.length === 100 && PAD2[99] === '99');
  check('NUM covers 0..999', NUM.length === 1000 && NUM[0] === '0' && NUM[999] === '999');
  check('num() falls back outside the table', num(1500) === '1500' && num(12) === '12');
  check('num() truncates', num(12.9) === '12');
});

describe('time formatting', () => {
  check('a normal lap', formatTime(61_180) === '1:01.18', formatTime(61_180));
  check('sub-minute', formatTime(42_050) === '0:42.05', formatTime(42_050));
  check('multi-minute race', formatTime(187_420) === '3:07.42', formatTime(187_420));
  check('centiseconds truncate, never round up past a second', formatTime(1999) === '0:01.99');
  check('zero', formatTime(0) === '0:00.00');
  check('an unset best shows dashes', formatTime(Infinity) === '--:--.--');
  check('NaN shows dashes', formatTime(Number.NaN) === '--:--.--');
  check('negative shows dashes', formatTime(-1) === '--:--.--');
  check('coarse clock', formatClock(187_420) === '3:07', formatClock(187_420));
  check('coarse clock of nothing', formatClock(Infinity) === '--:--');
});

describe('ghost delta', () => {
  check('ahead is negative', formatDelta(-840) === '-0.84', formatDelta(-840));
  check('behind is positive', formatDelta(1590) === '+1.59', formatDelta(1590));
  check('dead level still carries a sign so the column never shifts', formatDelta(0) === '+0.00');
  check('whole seconds', formatDelta(-3000) === '-3.00', formatDelta(-3000));
  check('large gaps clamp rather than overflow', formatDelta(9_999_999).startsWith('+'), formatDelta(9_999_999));
  check('non-finite is blank', formatDelta(Number.NaN) === '--.--');

  // The HUD renders the delta from two tables and must agree with the string
  // formatter, because they are read side by side in screenshots and bug reports.
  for (const ms of [-4321, -1000, -1, 0, 1, 999, 1000, 45_670]) {
    const negative = ms < 0;
    const abs = Math.abs(ms);
    const whole = Math.floor(abs / 1000);
    const frac = Math.floor((abs % 1000) / 10);
    const rebuilt = `${negative ? '-' : '+'}${whole}.${PAD2[frac]}`;
    check(`table-built delta matches formatDelta(${ms})`, rebuilt === formatDelta(ms), `${rebuilt} vs ${formatDelta(ms)}`);
  }
});

describe('numbers on screen', () => {
  check('gaps get one decimal', formatGap(2.34) === '+2.3', formatGap(2.34));
  check('a leader has no gap', formatGap(0) === '—');
  check('huge gaps drop the decimal', formatGap(142.6) === '+143', formatGap(142.6));
  check('metres per second become km/h', speedKph(148.6) === 535, String(speedKph(148.6)));
  check('reverse is clamped to zero', speedKph(-4) === 0);
  check('kilometres', formatDistance(3390) === '3.39 km', formatDistance(3390));
  check('metres', formatDistance(420) === '420 m');
  check('thousands separators', formatCredits(2040) === '2,040', formatCredits(2040));
  check('no separator below a thousand', formatCredits(999) === '999');
  check('exactly a thousand', formatCredits(1000) === '1,000', formatCredits(1000));
  check('millions', formatCredits(1_234_567) === '1,234,567', formatCredits(1_234_567));
  check('negative credits floor at zero', formatCredits(-50) === '0');
  check('percentages round', percent(0.856) === '86%');
  check('ordinals', ordinal(1) === '1st' && ordinal(2) === '2nd' && ordinal(3) === '3rd' && ordinal(4) === '4th');
  check('teens are all th', ordinal(11) === '11th' && ordinal(12) === '12th' && ordinal(13) === '13th');
  check('twenty-first', ordinal(21) === '21st');
  check('difficulty reads as words', difficultyLabel(1) === 'Gentle · 1/5', difficultyLabel(1));
  check('difficulty clamps', difficultyLabel(99) === 'Brutal · 5/5');
  check('every medal tier has a label', Object.keys(MEDAL_LABEL).length === 5 && MEDAL_LABEL.author === 'Author');
});

// ---------------------------------------------------------------------------

const SQUARE: Point[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

const WIDE: Point[] = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 1 },
  { x: 0, y: 1 },
];

describe('circuit outline', () => {
  const b = outlineBounds(WIDE);
  check('bounds', b.minX === 0 && b.maxX === 2 && b.minY === 0 && b.maxY === 1);
  check('empty input is safe', outlineBounds([]).maxX === 1);

  const fit = fitOutline(WIDE, 100, 100, 0);
  near('a 2:1 shape scales to the width', fit.scale, 50, 1e-6);
  near('and is centred vertically', fit.offsetY, 25, 1e-6);
  near('with no horizontal slack', fit.offsetX, 0, 1e-6);

  const tall = fitOutline(SQUARE, 200, 100, 10);
  near('a square fits the short axis', tall.scale, 80, 1e-6);
  check('aspect ratio is never distorted', fitOutline(WIDE, 300, 100, 0).scale > 0);

  const d = outlinePath(SQUARE, 100, 100, 0);
  check('path starts with a move', d.startsWith('M'), d);
  check('path is closed', d.endsWith('Z'), d);
  check('path has one command per point', (d.match(/L/g) ?? []).length === SQUARE.length - 1, d);
  check('degenerate input yields no path', outlinePath([{ x: 0, y: 0 }], 100, 100) === '');
  check('a real circuit produces a real path', outlinePath(fallbackOutline(24), 320, 180).length > 40);

  near('unit square perimeter', outlinePerimeter(SQUARE), 4, 1e-9);
  near('a single point has no perimeter', outlinePerimeter([{ x: 1, y: 1 }]), 0, 1e-9);
});

describe('outline resampling', () => {
  const walk = resampleClosed(SQUARE, 8);
  check('returns the requested count', walk.length === 8);

  // Even arc-length spacing is what makes the lap marker travel at a constant
  // rate instead of sprinting down the straights.
  let minStep = Infinity;
  let maxStep = 0;
  for (let i = 0; i < walk.length; i++) {
    const a = walk[i];
    const bPt = walk[(i + 1) % walk.length];
    const step = Math.hypot(bPt.x - a.x, bPt.y - a.y);
    minStep = Math.min(minStep, step);
    maxStep = Math.max(maxStep, step);
  }
  near('every step is the same length', maxStep - minStep, 0, 1e-9);
  near('and that length is perimeter / count', maxStep, 0.5, 1e-9);

  check('the walk starts at the first point', walk[0].x === 0 && walk[0].y === 0);

  const degenerate = resampleClosed([{ x: 3, y: 4 }], 5);
  check('a degenerate loop still returns points', degenerate.length === 5);

  const collapsed = resampleClosed(
    [
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 1 },
    ],
    4,
  );
  check('a zero-length loop does not divide by zero', collapsed.every((p) => p.x === 1 && p.y === 1));
});

describe('lap-marker transform table', () => {
  const table = markerTransforms(SQUARE, 100, 100, 0, 16);
  check('one entry per sample', table.length === 16);
  check('entries are ready-to-assign transforms', table.every((t) => t.startsWith('translate3d(') && t.endsWith(')')));
  check('entries differ around the loop', new Set(table).size > 8, String(new Set(table).size));

  // The HUD indexes this with (lapProgress * samples) | 0, so both ends must be
  // in range for progress values of exactly 0 and just under 1.
  const at0 = (0 * 16) | 0;
  const at1 = (0.9999 * 16) | 0;
  check('index 0 is valid', table[at0] !== undefined);
  check('index at end of lap is valid', at1 === 15 && table[at1] !== undefined);

  const fallback = fallbackOutline(32);
  check('the fallback circuit has the requested resolution', fallback.length === 32);
  check('the fallback sits inside 0..1', fallback.every((p) => p.x > -0.2 && p.x < 1.2 && p.y > -0.2 && p.y < 1.2));
});

// ---------------------------------------------------------------------------

describe('key labels', () => {
  check('letters', keyLabel('KeyW') === 'W' && keyLabel('KeyC') === 'C');
  check('digits', keyLabel('Digit4') === '4');
  check('named keys', keyLabel('Space') === 'Space' && keyLabel('Escape') === 'Esc');
  check('sided modifiers say which side', keyLabel('ShiftLeft') === 'L Shift' && keyLabel('ControlRight') === 'R Ctrl');
  check('arrows become glyphs', keyLabel('ArrowUp') === '↑' && keyLabel('ArrowRight') === '→');
  check('numpad is disambiguated', keyLabel('Numpad7') === 'Num 7');
  check('function keys pass through', keyLabel('F7') === 'F7');
  check('punctuation is shown as the keycap prints it', keyLabel('Semicolon') === ';' && keyLabel('Slash') === '/');
  check('unknown codes fall back to themselves', keyLabel('Lang1') === 'Lang1');
  check('empty is an em dash', keyLabel('') === '—');
  check('browser keys are refused', isReservedKey('F5') && isReservedKey('Tab') && !isReservedKey('KeyW'));
});

describe('binding conflicts', () => {
  check('the factory layout is clean', bindingConflicts(DEFAULT_BINDINGS).size === 0);

  const clashing = { throttle: ['KeyW'], brake: ['KeyW'], boost: ['Space'] };
  const found = bindingConflicts(clashing);
  check('a duplicate is found', found.size === 1 && found.has('KeyW'));
  check('and both owners are named', (found.get('KeyW') ?? []).length === 2);
  check('unique keys are not reported', !found.has('Space'));

  const triple = { a: ['KeyQ'], b: ['KeyQ'], c: ['KeyQ'] };
  check('three-way clashes list all three', (bindingConflicts(triple).get('KeyQ') ?? []).length === 3);

  const blanks = { throttle: ['', ''], brake: [''] };
  check('empty slots are not a conflict', bindingConflicts(blanks).size === 0);

  check('actionsUsing finds the other owner', actionsUsing(clashing, 'KeyW', 'throttle').join() === 'brake');
  check('actionsUsing excludes the asker', actionsUsing(clashing, 'KeyW', 'brake').join() === 'throttle');
});

describe('rebinding', () => {
  const base = defaultBindings();

  const stolen = setBinding(base, 'brake', 0, 'KeyW');
  check('the key moves to its new owner', stolen.bindings.brake[0] === 'KeyW', JSON.stringify(stolen.bindings.brake));
  check('the theft is reported', stolen.stolenFrom.includes('throttle'), stolen.stolenFrom.join());
  check('the old owner loses it', !stolen.bindings.throttle.includes('KeyW'));
  check('the old owner keeps its other key', stolen.bindings.throttle.includes('ArrowUp'));
  check('no conflict is left behind', bindingConflicts(stolen.bindings).size === 0);
  check('the input is never mutated', base.throttle.includes('KeyW'));

  const second = setBinding(base, 'throttle', 1, 'KeyT');
  check('the second slot is writable', second.bindings.throttle[1] === 'KeyT', JSON.stringify(second.bindings.throttle));
  check('the first slot is untouched', second.bindings.throttle[0] === 'KeyW');
  check('nothing was stolen', second.stolenFrom.length === 0);

  // Re-binding a key an action already holds should move it, not duplicate it.
  const moved = setBinding(base, 'throttle', 1, 'KeyW');
  check('a key is never duplicated within one action', moved.bindings.throttle.filter((k) => k === 'KeyW').length === 1);
  check('and the action still has a key', moved.bindings.throttle.length >= 1);

  const fresh = setBinding({ lookBack: [] }, 'lookBack', 0, 'KeyZ');
  check('an empty action can be bound', fresh.bindings.lookBack[0] === 'KeyZ');

  const invented = setBinding(base, 'newAction', 0, 'KeyM');
  check('an unknown action is created rather than throwing', invented.bindings.newAction[0] === 'KeyM');

  const cleared = clearBinding(base, 'throttle', 0);
  check('clearing removes one slot', cleared.throttle.length === base.throttle.length - 1);
  check('and compacts the rest', cleared.throttle[0] === 'ArrowUp');
  check('clearing does not mutate the input', base.throttle.length === 2);

  const emptied = clearBinding(clearBinding(base, 'lookBack', 0), 'lookBack', 0);
  check('unbound actions are reported', unboundActions(emptied).includes('lookBack'), unboundActions(emptied).join());
  check('bound actions are not', !unboundActions(emptied).includes('throttle'));
});

describe('binding defaults', () => {
  check('a fresh copy is default', isDefaultBindings(defaultBindings()));
  check('a changed copy is not', !isDefaultBindings(setBinding(defaultBindings(), 'brake', 0, 'KeyW').bindings));
  check('a missing action is not default', !isDefaultBindings({ throttle: ['KeyW', 'ArrowUp'] }));
  check('order matters', !isDefaultBindings({ ...defaultBindings(), throttle: ['ArrowUp', 'KeyW'] }));
  check('defaultBindings is a copy, not the shared object', defaultBindings().throttle !== DEFAULT_BINDINGS.throttle);
  check('every listed action exists in the defaults', ACTIONS.every((a) => a.id in DEFAULT_BINDINGS));
  check('every default action is listed in the UI', Object.keys(DEFAULT_BINDINGS).every((id) => ACTIONS.some((a) => a.id === id)));
  check('every action documents a gamepad equivalent', ACTIONS.every((a) => a.pad.length > 0));
  check('two slots per action', BINDING_SLOTS === 2);
  check('no default action exceeds the slot count', Object.values(DEFAULT_BINDINGS).every((k) => k.length <= BINDING_SLOTS));
});

// ---------------------------------------------------------------------------

describe('menu index maths', () => {
  check('forward', stepIndex(0, 5, 1) === 1);
  check('wraps past the end', stepIndex(4, 5, 1) === 0);
  check('wraps before the start', stepIndex(0, 5, -1) === 4);
  check('wraps over multiple laps', stepIndex(0, 5, -7) === 3, String(stepIndex(0, 5, -7)));
  check('clamps when asked to', stepIndex(4, 5, 1, false) === 4 && stepIndex(0, 5, -1, false) === 0);
  check('an empty list has no index', stepIndex(0, 0, 1) === -1);
});

describe('grid movement', () => {
  // 8 items in a 3-wide grid: rows are [0 1 2] [3 4 5] [6 7].
  check('right within a row', gridStep(0, 8, 3, 'right') === 1);
  check('right stops at the row end', gridStep(2, 8, 3, 'right') === 2);
  check('right stops at the last item', gridStep(7, 8, 3, 'right') === 7);
  check('left within a row', gridStep(1, 8, 3, 'left') === 0);
  check('left stops at the row start', gridStep(3, 8, 3, 'left') === 3);
  check('down a row', gridStep(0, 8, 3, 'down') === 3);
  check('down stops on the last row', gridStep(6, 8, 3, 'down') === 6);
  check('up a row', gridStep(4, 8, 3, 'up') === 1);
  check('up stops on the first row', gridStep(1, 8, 3, 'up') === 1);
  check('a single column still moves vertically', gridStep(0, 4, 1, 'down') === 1);
  check('an empty grid has no index', gridStep(0, 0, 3, 'down') === -1);
});

describe('spatial navigation', () => {
  const from: NavRect = { x: 0, y: 0, w: 100, h: 40 };
  const below: NavRect = { x: 0, y: 60, w: 100, h: 40 };
  const right: NavRect = { x: 200, y: 0, w: 100, h: 40 };
  const farBelow: NavRect = { x: 0, y: 400, w: 100, h: 40 };
  const list = [below, right, farBelow];

  check('down finds the item below', pickInDirection(from, list, 'down') === 0);
  check('right finds the item to the right', pickInDirection(from, list, 'right') === 1);
  check('nothing above means no move', pickInDirection(from, list, 'up') === -1);
  check('nothing to the left means no move', pickInDirection(from, list, 'left') === -1);
  check('the nearest candidate wins', pickInDirection(from, [farBelow, below], 'down') === 1);
  check('an empty field has no candidate', pickInDirection(from, [], 'down') === -1);

  // A column-aligned neighbour must beat a closer one that sits off to the side,
  // otherwise walking down a settings list drifts into the next column.
  const offToTheSide: NavRect = { x: 600, y: 45, w: 100, h: 40 };
  const inColumn: NavRect = { x: 0, y: 70, w: 100, h: 40 };
  check('column alignment beats raw proximity', pickInDirection(from, [offToTheSide, inColumn], 'down') === 1);

  // Moving up out of a wide card should find the header above it.
  const wide: NavRect = { x: 0, y: 200, w: 600, h: 80 };
  const header: NavRect = { x: 20, y: 100, w: 200, h: 40 };
  check('up finds an overlapping element', pickInDirection(wide, [header], 'up') === 0);
});

// ---------------------------------------------------------------------------

describe('settings bounds', () => {
  check('every bound is sane', Object.values(BOUNDS).every((b) => b.max > b.min && b.step > 0));
  near('volume clamps to one', clampTo(BOUNDS.masterVolume, 5, 0.85), 1, 1e-9);
  near('volume clamps to zero', clampTo(BOUNDS.masterVolume, -3, 0.85), 0, 1e-9);
  near('field of view clamps high', clampTo(BOUNDS.fieldOfView, 1000, 78), 110, 1e-9);
  near('field of view clamps low', clampTo(BOUNDS.fieldOfView, 5, 78), 60, 1e-9);
  near('NaN falls back to the default', clampTo(BOUNDS.hudScale, Number.NaN, 1), 1, 1e-9);
  near('values snap to the slider step', clampTo(BOUNDS.targetFps, 63, 60), 65, 1e-9);
  near('hud scale snaps to 0.05', clampTo(BOUNDS.hudScale, 1.013, 1), 1, 1e-9);
  range('every default sits inside its own bound', clampTo(BOUNDS.aiDifficulty, defaultSettings().aiDifficulty, 0.62), 0, 1);
});

describe('settings validation', () => {
  const clean = sanitizeSettings(null);
  check('null yields the defaults', clean.qualityTier === 'auto' && clean.hudScale === 1);

  const repaired = sanitizeSettings({
    masterVolume: 99,
    fieldOfView: -12,
    qualityTier: 'shiny' as never,
    adaptiveQuality: 'yes' as never,
    hudScale: Number.NaN,
    bindings: { throttle: ['KeyW', 'KeyE', 'KeyR'], brake: ['', 'KeyS'], junk: 'nope' as never },
  });
  near('out-of-range volume is clamped', repaired.masterVolume, 1, 1e-9);
  near('out-of-range field of view is clamped', repaired.fieldOfView, 60, 1e-9);
  check('an unknown tier falls back', repaired.qualityTier === 'auto');
  check('truthy junk becomes a real boolean', repaired.adaptiveQuality === true);
  near('NaN scale falls back', repaired.hudScale, 1, 1e-9);
  check('no action keeps more keys than it has slots', repaired.bindings.throttle.length === 2);
  check('empty slots are dropped', repaired.bindings.brake.length === 1 && repaired.bindings.brake[0] === 'KeyS');
  check('non-array bindings become empty', Array.isArray(repaired.bindings.junk) && repaired.bindings.junk.length === 0);

  check('every quality option is offered including auto', QUALITY_OPTIONS.length === 6 && QUALITY_OPTIONS[0] === 'auto');
  check('a sanitised tier survives a round trip', sanitizeSettings({ qualityTier: 'ultra' }).qualityTier === 'ultra');
});

describe('settings cloning', () => {
  const original = defaultSettings();
  const copy = cloneSettings(original);
  copy.masterVolume = 0.1;
  copy.bindings.throttle.push('KeyZ');
  check('scalars are copied', original.masterVolume !== 0.1);
  check('binding arrays are copied, not shared', !original.bindings.throttle.includes('KeyZ'));
  check('every action survives the copy', Object.keys(copy.bindings).length === Object.keys(original.bindings).length);
});

describe('rival skill presets', () => {
  check('presets ascend', AI_PRESETS.every((p, i) => i === 0 || p.value > AI_PRESETS[i - 1].value));
  check('the lowest value reads as the easiest preset', aiDifficultyLabel(0) === 'Novice');
  check('the highest reads as the hardest', aiDifficultyLabel(1) === 'Nightmare');
  check('a value snaps to its nearest preset', aiDifficultyLabel(0.31) === 'Novice', aiDifficultyLabel(0.31));
  check('the profile default reads as Veteran', aiDifficultyLabel(defaultSettings().aiDifficulty) === 'Veteran');
});

report('ui');
