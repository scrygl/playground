/**
 * Menu navigation for keyboard, gamepad, and mouse at the same time.
 *
 * Rather than every screen wiring up its own arrow-key handling, screens just
 * mark focusable things with `data-nav` and this controller works out what is
 * geometrically next in a given direction. That is what lets a track grid, a
 * settings list, and a keycap table all behave correctly without any of them
 * knowing their own shape — and it means adding a control to a screen never
 * means remembering to add it to a navigation array.
 */

export type Dir = 'up' | 'down' | 'left' | 'right';

export interface NavRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Moves an index by `delta`, wrapping or clamping. Pure; used by carousels. */
export function stepIndex(current: number, count: number, delta: number, wrap = true): number {
  if (count <= 0) return -1;
  const next = current + delta;
  if (wrap) return ((next % count) + count) % count;
  return Math.max(0, Math.min(count - 1, next));
}

/** Row/column movement inside a grid laid out in reading order. */
export function gridStep(current: number, count: number, columns: number, dir: Dir): number {
  if (count <= 0) return -1;
  const cols = Math.max(1, columns);
  switch (dir) {
    case 'left':
      return current % cols === 0 ? current : current - 1;
    case 'right':
      return current % cols === cols - 1 || current + 1 >= count ? current : current + 1;
    case 'up':
      return current - cols < 0 ? current : current - cols;
    case 'down': {
      const down = current + cols;
      return down >= count ? current : down;
    }
  }
}

function centreOf(r: NavRect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function overlaps(a: NavRect, b: NavRect, axis: 'x' | 'y'): boolean {
  if (axis === 'x') return a.x < b.x + b.w && b.x < a.x + a.w;
  return a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Index of the best candidate in `dir`, or -1.
 *
 * Anything that overlaps the source on the cross axis is strongly preferred —
 * that is what makes moving down a column of settings feel like a column rather
 * than a scatter of nearest neighbours.
 */
export function pickInDirection(from: NavRect, candidates: readonly NavRect[], dir: Dir): number {
  const fc = centreOf(from);
  let best = -1;
  let bestScore = Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const cc = centreOf(c);
    let primary: number;
    let cross: number;
    let aligned: boolean;

    switch (dir) {
      case 'right':
        primary = c.x - (from.x + from.w * 0.5);
        cross = Math.abs(cc.y - fc.y);
        aligned = overlaps(from, c, 'y');
        break;
      case 'left':
        primary = from.x + from.w * 0.5 - (c.x + c.w);
        cross = Math.abs(cc.y - fc.y);
        aligned = overlaps(from, c, 'y');
        break;
      case 'down':
        primary = c.y - (from.y + from.h * 0.5);
        cross = Math.abs(cc.x - fc.x);
        aligned = overlaps(from, c, 'x');
        break;
      case 'up':
        primary = from.y + from.h * 0.5 - (c.y + c.h);
        cross = Math.abs(cc.x - fc.x);
        aligned = overlaps(from, c, 'x');
        break;
    }

    if (primary < 1) continue;
    const score = primary + cross * (aligned ? 0.25 : 3);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

const DIR_KEYS: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
};

export interface NavCallbacks {
  onMove(): void;
  onSelect(): void;
  onBack(): void;
  onError(): void;
}

/** Gamepad button indexes in the Standard Gamepad mapping. */
const PAD_A = 0;
const PAD_B = 1;
const PAD_UP = 12;
const PAD_DOWN = 13;
const PAD_LEFT = 14;
const PAD_RIGHT = 15;

export class NavController {
  private scope: HTMLElement | null = null;
  private enabled = false;
  private readonly rects: NavRect[] = [];
  private readonly items: HTMLElement[] = [];
  private padRaf = 0;
  private padHeld = new Map<number, number>();
  private padDirTime = 0;
  private lastPadDir: Dir | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: NavCallbacks,
  ) {
    this.onKeyDown = this.onKeyDown.bind(this);
    this.pollPads = this.pollPads.bind(this);
  }

  attach(): void {
    this.root.ownerDocument.addEventListener('keydown', this.onKeyDown, true);
    this.padRaf = requestAnimationFrame(this.pollPads);
  }

  detach(): void {
    this.root.ownerDocument.removeEventListener('keydown', this.onKeyDown, true);
    cancelAnimationFrame(this.padRaf);
  }

  /** Restrict navigation to a subtree — the focus trap for dialogs. */
  setScope(scope: HTMLElement | null, enabled = true): void {
    this.scope = scope;
    this.enabled = enabled && scope !== null;
  }

  get active(): HTMLElement | null {
    const el = this.root.ownerDocument.activeElement;
    return el instanceof HTMLElement && this.scope?.contains(el) ? el : null;
  }

  /** Visible, enabled, navigable elements inside the current scope. */
  collect(): HTMLElement[] {
    this.items.length = 0;
    const scope = this.scope;
    if (!scope) return this.items;
    const found = scope.querySelectorAll<HTMLElement>('[data-nav]');
    for (const el of found) {
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      this.items.push(el);
    }
    return this.items;
  }

  focusFirst(): boolean {
    const items = this.collect();
    const preferred = items.find((el) => el.hasAttribute('data-nav-default')) ?? items[0];
    if (!preferred) return false;
    preferred.focus({ preventScroll: false });
    return true;
  }

  move(dir: Dir): boolean {
    const items = this.collect();
    if (items.length === 0) return false;
    const current = this.active;
    if (!current || !items.includes(current)) {
      items[0].focus();
      this.cb.onMove();
      return true;
    }
    this.rects.length = 0;
    for (const el of items) {
      const r = el.getBoundingClientRect();
      this.rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    const fromIndex = items.indexOf(current);
    const from = this.rects[fromIndex];
    const candidates = this.rects.map((r, i) => (i === fromIndex ? { x: -1e9, y: -1e9, w: 0, h: 0 } : r));
    const pick = pickInDirection(from, candidates, dir);
    if (pick < 0) return false;
    items[pick].focus();
    items[pick].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.cb.onMove();
    return true;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.enabled) return;
    if (event.defaultPrevented) return;
    const target = event.target;

    // Capture screens (rebinding) and text fields own the keyboard entirely.
    if (this.root.querySelector('[data-nav-capture]')) return;

    const isRange = target instanceof HTMLInputElement && target.type === 'range';
    const isText = target instanceof HTMLInputElement && target.type === 'text';
    if (isText) return;

    const dir = DIR_KEYS[event.code];
    if (dir) {
      // Sliders answer their own left/right; stealing them would make the
      // keyboard unable to change a volume.
      if (isRange && (dir === 'left' || dir === 'right')) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (!this.move(dir)) this.cb.onError();
      return;
    }

    if (event.code === 'Enter' || event.code === 'NumpadEnter' || event.code === 'Space') {
      const el = this.active;
      if (el && !isRange) {
        event.preventDefault();
        this.cb.onSelect();
        el.click();
      }
      return;
    }

    if (event.code === 'Escape' || event.code === 'Backspace') {
      event.preventDefault();
      this.cb.onBack();
    }
  }

  private pollPads(): void {
    this.padRaf = requestAnimationFrame(this.pollPads);
    if (!this.enabled) return;
    const nav = navigator as Navigator & { getGamepads?: () => (Gamepad | null)[] };
    if (!nav.getGamepads) return;
    const pads = nav.getGamepads();
    const now = performance.now();

    let dir: Dir | null = null;
    let select = false;
    let back = false;

    for (const pad of pads) {
      if (!pad) continue;
      const b = pad.buttons;
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (b[PAD_UP]?.pressed || ay < -0.55) dir = 'up';
      else if (b[PAD_DOWN]?.pressed || ay > 0.55) dir = 'down';
      else if (b[PAD_LEFT]?.pressed || ax < -0.55) dir = 'left';
      else if (b[PAD_RIGHT]?.pressed || ax > 0.55) dir = 'right';
      if (this.edge(PAD_A, b[PAD_A]?.pressed ?? false)) select = true;
      if (this.edge(PAD_B, b[PAD_B]?.pressed ?? false)) back = true;
    }

    // Press once immediately, then auto-repeat — the feel of a held arrow key.
    if (dir) {
      if (this.lastPadDir !== dir) {
        this.move(dir);
        this.padDirTime = now + 340;
      } else if (now >= this.padDirTime) {
        this.move(dir);
        this.padDirTime = now + 140;
      }
      this.lastPadDir = dir;
    } else {
      this.lastPadDir = null;
      this.padDirTime = 0;
    }

    if (select) {
      const el = this.active;
      if (el) {
        this.cb.onSelect();
        el.click();
      }
    }
    if (back) this.cb.onBack();
  }

  /** Rising-edge detector so a held button fires once. */
  private edge(index: number, pressed: boolean): boolean {
    const was = this.padHeld.get(index) === 1;
    this.padHeld.set(index, pressed ? 1 : 0);
    return pressed && !was;
  }
}
