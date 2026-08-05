/**
 * Turning a circuit's normalised 2D outline into something drawable.
 *
 * `TrackSummary.outline` is a closed polyline in 0..1 space with whatever
 * spacing the track builder happened to produce, and with whatever aspect ratio
 * the circuit happens to have. The preview and the in-race lap map both need it
 * fitted into a fixed box without distortion, and the map additionally needs
 * points spaced by arc length so the position marker travels at a constant rate
 * instead of sprinting through the straights.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function outlineBounds(points: readonly Point[]): Box {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export interface FitTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Uniform scale + centring that puts `points` inside a `width × height` box
 * with `pad` px of breathing room, preserving the circuit's real proportions.
 */
export function fitOutline(points: readonly Point[], width: number, height: number, pad: number): FitTransform {
  const b = outlineBounds(points);
  const spanX = Math.max(1e-6, b.maxX - b.minX);
  const spanY = Math.max(1e-6, b.maxY - b.minY);
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  const scale = Math.min(innerW / spanX, innerH / spanY);
  return {
    scale,
    offsetX: (width - spanX * scale) / 2 - b.minX * scale,
    offsetY: (height - spanY * scale) / 2 - b.minY * scale,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * An SVG `d` string for the circuit, closed. Returns an empty string for
 * degenerate input so callers can simply not render rather than branch.
 */
export function outlinePath(points: readonly Point[], width: number, height: number, pad = 8): string {
  if (points.length < 2) return '';
  const t = fitOutline(points, width, height, pad);
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const x = round2(p.x * t.scale + t.offsetX);
    const y = round2(p.y * t.scale + t.offsetY);
    d += i === 0 ? `M${x} ${y}` : `L${x} ${y}`;
  }
  return `${d}Z`;
}

/** Total closed-loop perimeter, in input units. */
export function outlinePerimeter(points: readonly Point[]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/**
 * Resamples the closed loop into `count` points spaced evenly by arc length.
 *
 * This is what makes the lap marker honest: `lapProgress` is a fraction of
 * distance travelled, so the marker has to be indexed by distance too.
 */
export function resampleClosed(points: readonly Point[], count: number): Point[] {
  const n = Math.max(2, Math.floor(count));
  if (points.length < 2) {
    const out: Point[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { x: 0, y: 0 };
    return out;
  }

  const segCount = points.length;
  const cumulative: number[] = new Array(segCount + 1);
  cumulative[0] = 0;
  for (let i = 0; i < segCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % segCount];
    cumulative[i + 1] = cumulative[i] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  const total = cumulative[segCount];
  const out: Point[] = new Array(n);
  if (total <= 1e-9) {
    for (let i = 0; i < n; i++) out[i] = { x: points[0].x, y: points[0].y };
    return out;
  }

  let seg = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / n) * total;
    while (seg < segCount - 1 && cumulative[seg + 1] < target) seg++;
    const segLen = cumulative[seg + 1] - cumulative[seg];
    const t = segLen > 1e-9 ? (target - cumulative[seg]) / segLen : 0;
    const a = points[seg];
    const b = points[(seg + 1) % segCount];
    out[i] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  return out;
}

/**
 * Pre-baked `translate3d(...)` strings for every sampled position on the map.
 *
 * The HUD indexes straight into this from `lapProgress`, so moving the marker
 * costs one array read and one style write — no maths, no string building, no
 * garbage, once per frame.
 */
export function markerTransforms(
  points: readonly Point[],
  width: number,
  height: number,
  pad: number,
  samples: number,
): string[] {
  const n = Math.max(2, Math.floor(samples));
  const t = fitOutline(points, width, height, pad);
  const walk = resampleClosed(points, n);
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = round2(walk[i].x * t.scale + t.offsetX);
    const y = round2(walk[i].y * t.scale + t.offsetY);
    out[i] = `translate3d(${x}px, ${y}px, 0)`;
  }
  return out;
}

/** A plausible circuit shape for when no real outline is available. */
export function fallbackOutline(segments = 48): Point[] {
  const out: Point[] = new Array(segments);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    // A squashed, kinked oval — reads as a circuit rather than a perfect circle.
    const r = 0.42 + Math.sin(a * 2) * 0.06 + Math.sin(a * 3) * 0.03;
    out[i] = { x: 0.5 + Math.cos(a) * r * 1.25, y: 0.5 + Math.sin(a) * r * 0.78 };
  }
  return out;
}
