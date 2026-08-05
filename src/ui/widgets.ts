/**
 * The component vocabulary.
 *
 * Everything is built with `createElement` and `textContent` — never
 * `innerHTML` — because ship names, track names and rival names all end up in
 * these nodes and some of them will eventually come from a seed string a player
 * typed. Building nodes is also what lets a widget hand back live references
 * (`row.value`, `bar.fill`) so a screen can update in place instead of
 * re-rendering.
 */

import type { MedalTier } from '../game/profile';
import { icon, medalMark, type IconName } from './icons';
import { outlinePath, type Point } from './outline';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A 0xRRGGBB colour from the ship or track data as a CSS string. */
export function cssHex(value: number): string {
  return `#${(value >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function append<T extends Node>(parent: Node, ...children: T[]): void {
  for (const child of children) parent.appendChild(child);
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export interface ButtonOptions {
  label: string;
  kind?: 'primary' | 'default' | 'quiet' | 'danger';
  iconName?: IconName;
  onClick?: () => void;
  /** Marks the element the navigator lands on when a screen opens. */
  autofocus?: boolean;
  ariaLabel?: string;
}

export function button(opts: ButtonOptions): HTMLButtonElement {
  const b = el('button', `vh-btn vh-btn--${opts.kind ?? 'default'}`);
  b.type = 'button';
  b.setAttribute('data-nav', '');
  if (opts.autofocus) b.setAttribute('data-nav-default', '');
  if (opts.ariaLabel) b.setAttribute('aria-label', opts.ariaLabel);
  if (opts.iconName) b.appendChild(icon(opts.iconName, 17));
  b.appendChild(el('span', 'vh-btn__label', opts.label));
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}

/** The large chevron-marked rows that make up the title and mode menus. */
export interface MenuItemOptions {
  label: string;
  detail?: string;
  iconName?: IconName;
  onClick: () => void;
  autofocus?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export function menuItem(opts: MenuItemOptions): HTMLButtonElement {
  const b = el('button', 'vh-menu-item');
  b.type = 'button';
  if (opts.disabled) {
    b.setAttribute('aria-disabled', 'true');
    b.classList.add('is-disabled');
  } else {
    b.setAttribute('data-nav', '');
    if (opts.autofocus) b.setAttribute('data-nav-default', '');
  }

  if (opts.iconName) {
    const badge = el('span', 'vh-menu-item__icon');
    badge.appendChild(icon(opts.iconName, 20));
    b.appendChild(badge);
  }

  const text = el('span', 'vh-menu-item__text');
  text.appendChild(el('span', 'vh-menu-item__label', opts.label));
  const detail = opts.disabled ? (opts.disabledReason ?? opts.detail) : opts.detail;
  if (detail) text.appendChild(el('span', 'vh-menu-item__detail', detail));
  b.appendChild(text);

  const mark = el('span', 'vh-menu-item__mark');
  mark.appendChild(icon(opts.disabled ? 'lock' : 'chevronRight', 16));
  b.appendChild(mark);

  if (!opts.disabled) b.addEventListener('click', opts.onClick);
  return b;
}

// ---------------------------------------------------------------------------
// Settings controls
// ---------------------------------------------------------------------------

export interface SliderRow {
  root: HTMLElement;
  input: HTMLInputElement;
  value: HTMLElement;
  set(v: number): void;
}

export function sliderRow(opts: {
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
}): SliderRow {
  const root = el('div', 'vh-field vh-field--slider');
  const head = el('div', 'vh-field__head');
  const id = `vh-f-${Math.random().toString(36).slice(2, 9)}`;

  const label = el('label', 'vh-field__label', opts.label);
  label.htmlFor = id;
  head.appendChild(label);
  const value = el('span', 'vh-field__value', opts.format(opts.value));
  head.appendChild(value);
  root.appendChild(head);

  const track = el('div', 'vh-slider');
  const fill = el('div', 'vh-slider__fill');
  const input = el('input', 'vh-slider__input');
  input.type = 'range';
  input.id = id;
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);
  input.setAttribute('data-nav', '');

  const paint = (v: number): void => {
    const t = (v - opts.min) / Math.max(1e-6, opts.max - opts.min);
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, t))})`;
    value.textContent = opts.format(v);
    input.setAttribute('aria-valuetext', opts.format(v));
  };
  paint(opts.value);

  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    opts.onInput(v);
  });

  track.appendChild(fill);
  track.appendChild(input);
  root.appendChild(track);
  if (opts.hint) root.appendChild(el('p', 'vh-field__hint', opts.hint));

  return {
    root,
    input,
    value,
    set(v: number) {
      input.value = String(v);
      paint(v);
    },
  };
}

export interface ToggleRow {
  root: HTMLElement;
  button: HTMLButtonElement;
  set(v: boolean): void;
}

export function toggleRow(opts: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}): ToggleRow {
  const root = el('div', 'vh-field vh-field--toggle');
  const text = el('div', 'vh-field__text');
  text.appendChild(el('span', 'vh-field__label', opts.label));
  if (opts.hint) text.appendChild(el('p', 'vh-field__hint', opts.hint));

  const b = el('button', 'vh-switch');
  b.type = 'button';
  b.setAttribute('role', 'switch');
  b.setAttribute('data-nav', '');
  b.setAttribute('aria-label', opts.label);
  const knob = el('span', 'vh-switch__knob');
  const state = el('span', 'vh-switch__state');
  b.appendChild(state);
  b.appendChild(knob);

  let current = opts.value;
  const paint = (): void => {
    b.setAttribute('aria-checked', current ? 'true' : 'false');
    b.classList.toggle('is-on', current);
    state.textContent = current ? 'On' : 'Off';
  };
  paint();

  b.addEventListener('click', () => {
    current = !current;
    paint();
    opts.onChange(current);
  });

  root.appendChild(text);
  root.appendChild(b);
  return {
    root,
    button: b,
    set(v: boolean) {
      current = v;
      paint();
    },
  };
}

export interface SegmentedRow<T extends string> {
  root: HTMLElement;
  set(v: T): void;
}

export function segmentedRow<T extends string>(opts: {
  label: string;
  hint?: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}): SegmentedRow<T> {
  const root = el('div', 'vh-field vh-field--segmented');
  const head = el('div', 'vh-field__head');
  head.appendChild(el('span', 'vh-field__label', opts.label));
  root.appendChild(head);

  const group = el('div', 'vh-segmented');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', opts.label);

  const buttons: HTMLButtonElement[] = [];
  let current = opts.value;
  const paint = (): void => {
    opts.options.forEach((option, i) => {
      const on = option.value === current;
      buttons[i].setAttribute('aria-checked', on ? 'true' : 'false');
      buttons[i].classList.toggle('is-on', on);
    });
  };

  opts.options.forEach((option) => {
    const b = el('button', 'vh-segmented__item');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('data-nav', '');
    b.appendChild(el('span', '', option.label));
    b.addEventListener('click', () => {
      current = option.value;
      paint();
      opts.onChange(option.value);
    });
    buttons.push(b);
    group.appendChild(b);
  });
  paint();

  root.appendChild(group);
  if (opts.hint) root.appendChild(el('p', 'vh-field__hint', opts.hint));
  return {
    root,
    set(v: T) {
      current = v;
      paint();
    },
  };
}

// ---------------------------------------------------------------------------
// Display pieces
// ---------------------------------------------------------------------------

export interface StatBar {
  root: HTMLElement;
  fill: HTMLElement;
  compare: HTMLElement;
  set(value: number, compareTo?: number): void;
}

/** One garage stat: label, bar, and an optional ghost bar for the comparison craft. */
export function statBar(label: string, value: number): StatBar {
  const root = el('div', 'vh-stat');
  const head = el('div', 'vh-stat__head');
  head.appendChild(el('span', 'vh-stat__label', label));
  const readout = el('span', 'vh-stat__value', String(Math.round(value * 100)));
  head.appendChild(readout);
  root.appendChild(head);

  const track = el('div', 'vh-stat__track');
  const compare = el('div', 'vh-stat__compare');
  const fill = el('div', 'vh-stat__fill');
  // Ten notches: the bar reads as a gauge rather than a progress meter.
  track.appendChild(el('div', 'vh-stat__notches'));
  track.appendChild(compare);
  track.appendChild(fill);
  root.appendChild(track);

  const set = (v: number, compareTo?: number): void => {
    const clamped = Math.max(0, Math.min(1, v));
    fill.style.transform = `scaleX(${clamped})`;
    readout.textContent = String(Math.round(clamped * 100));
    if (compareTo === undefined) {
      compare.style.opacity = '0';
      root.classList.remove('is-better', 'is-worse');
    } else {
      const c = Math.max(0, Math.min(1, compareTo));
      compare.style.opacity = '1';
      compare.style.transform = `scaleX(${c})`;
      root.classList.toggle('is-better', clamped > c + 0.02);
      root.classList.toggle('is-worse', clamped < c - 0.02);
    }
  };
  set(value);

  return { root, fill, compare, set };
}

export function medalBadge(tier: MedalTier, size = 30): HTMLElement {
  const wrap = el('span', `vh-medal vh-medal--${tier}`);
  wrap.appendChild(medalMark(size));
  wrap.setAttribute('aria-hidden', 'true');
  return wrap;
}

export function keycap(text: string): HTMLElement {
  return el('kbd', 'vh-keycap', text);
}

/** The prompt strip at the bottom of every menu screen. */
export function hintBar(items: readonly { keys: string[]; label: string }[]): HTMLElement {
  const bar = el('div', 'vh-hints');
  for (const item of items) {
    const group = el('span', 'vh-hints__item');
    for (const k of item.keys) group.appendChild(keycap(k));
    group.appendChild(el('span', 'vh-hints__label', item.label));
    bar.appendChild(group);
  }
  return bar;
}

const SVGNS = 'http://www.w3.org/2000/svg';

/**
 * The circuit preview.
 *
 * Two strokes on the same path: a wide, faint one that reads as track surface
 * and a thin bright one that reads as the racing line. A tick marks the start
 * line so the shape has an orientation instead of being an abstract squiggle.
 */
export function trackPreview(points: readonly Point[], width: number, height: number): SVGSVGElement {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'vh-preview');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const d = outlinePath(points, width, height, 14);
  if (!d) return svg;

  const surface = document.createElementNS(SVGNS, 'path');
  surface.setAttribute('d', d);
  surface.setAttribute('class', 'vh-preview__surface');
  svg.appendChild(surface);

  const line = document.createElementNS(SVGNS, 'path');
  line.setAttribute('d', d);
  line.setAttribute('class', 'vh-preview__line');
  svg.appendChild(line);

  if (points.length > 1) {
    const t = d.slice(1).split('L')[0].split(' ');
    const start = document.createElementNS(SVGNS, 'circle');
    start.setAttribute('cx', t[0]);
    start.setAttribute('cy', t[1]);
    start.setAttribute('r', '3.4');
    start.setAttribute('class', 'vh-preview__start');
    svg.appendChild(start);
  }
  return svg;
}

/** A labelled value pair, used across results, garage and settings. */
export function dataPair(label: string, value: string, className = ''): HTMLElement {
  const root = el('div', `vh-pair ${className}`.trim());
  root.appendChild(el('span', 'vh-pair__label', label));
  root.appendChild(el('span', 'vh-pair__value', value));
  return root;
}

export interface ScreenFrame {
  root: HTMLElement;
  body: HTMLElement;
  title: HTMLElement;
  kicker: HTMLElement;
  aside: HTMLElement;
  footer: HTMLElement;
}

/** Shared chrome: kicker, title, an aside slot, a scrolling body, a hint bar. */
export function screenFrame(opts: { title: string; kicker: string; wide?: boolean }): ScreenFrame {
  const root = el('section', `vh-frame${opts.wide ? ' vh-frame--wide' : ''}`);
  const header = el('header', 'vh-frame__head');

  const heading = el('div', 'vh-frame__heading');
  const kicker = el('p', 'vh-frame__kicker', opts.kicker);
  const title = el('h1', 'vh-frame__title', opts.title);
  heading.appendChild(kicker);
  heading.appendChild(title);
  header.appendChild(heading);

  const aside = el('div', 'vh-frame__aside');
  header.appendChild(aside);

  const body = el('div', 'vh-frame__body');
  const footer = el('footer', 'vh-frame__foot');

  root.appendChild(header);
  root.appendChild(body);
  root.appendChild(footer);
  return { root, body, title, kicker, aside, footer };
}
