/**
 * The icon set, authored here as path data.
 *
 * There is no icon font and no sprite sheet — every mark is drawn on a 24-unit
 * grid and built as real SVG nodes, so it inherits `currentColor`, scales with
 * the HUD, and costs nothing to load. The drawing style is deliberately
 * consistent: 1.7-unit strokes, round joins, and flat silhouettes only where a
 * shape reads better solid (the craft, the boost bolt, the play triangle).
 */

const SVGNS = 'http://www.w3.org/2000/svg';

interface IconSpec {
  /** Stroked outlines. */
  stroke?: string[];
  /** Solid shapes. */
  fill?: string[];
}

export type IconName = keyof typeof ICONS;

export const ICONS = {
  chevronRight: { stroke: ['M9.5 5.5 16 12l-6.5 6.5'] },
  chevronLeft: { stroke: ['M14.5 5.5 8 12l6.5 6.5'] },
  chevronDown: { stroke: ['M5.5 9.5 12 16l6.5-6.5'] },
  chevronUp: { stroke: ['M5.5 14.5 12 8l6.5 6.5'] },
  check: { stroke: ['M4.5 12.5 9.5 17.5 19.5 6.5'] },
  close: { stroke: ['M6 6l12 12', 'M18 6 6 18'] },
  lock: {
    stroke: ['M8 10.5V7.5a4 4 0 0 1 8 0v3', 'M5.5 10.5h13v9.5h-13z'],
    fill: ['M11.1 14h1.8v3.2h-1.8z'],
  },
  // A wedge-shaped craft seen from above: nose, swept wings, twin engines.
  craft: {
    fill: ['M12 2.6 15.4 11l4.6 4.1-.9 2.6-5.1-1.6-.5 5.1h-3l-.5-5.1-5.1 1.6-.9-2.6L8.6 11z'],
  },
  flag: {
    stroke: ['M5.5 3.5v17'],
    fill: ['M7 4.4h5.4v3.6H18V4.4h1.4v7.2H14V8H8.4v3.6H7z', 'M8.4 8H14v3.6H8.4z'],
  },
  trophy: {
    stroke: [
      'M7.5 3.8h9v5.4a4.5 4.5 0 0 1-9 0z',
      'M7.5 5.2H4.8v1.4a3 3 0 0 0 2.7 3',
      'M16.5 5.2h2.7v1.4a3 3 0 0 1-2.7 3',
      'M12 13.7v3.1',
      'M8.6 20.2h6.8l-.9-3.4H9.5z',
    ],
  },
  gauge: {
    stroke: ['M4 17.5a8.6 8.6 0 1 1 16 0', 'M12 17 15.6 9.8'],
    fill: ['M10.8 17a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 0 0-2.4 0z'],
  },
  cog: {
    stroke: [
      'M12 15.1a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2z',
      'M12 2.8l1.1 2.5 2.7-.5.6 2.7 2.5 1.1-1.4 2.4 1.4 2.4-2.5 1.1-.6 2.7-2.7-.5L12 21.2l-1.1-2.5-2.7.5-.6-2.7-2.5-1.1L6.5 13l-1.4-2.4 2.5-1.1.6-2.7 2.7.5z',
    ],
  },
  keyboard: {
    stroke: ['M3.2 6.4h17.6v11.2H3.2z', 'M8 14.6h8'],
    fill: [
      'M5.8 9h1.8v1.8H5.8zM8.8 9h1.8v1.8H8.8zM11.8 9h1.8v1.8h-1.8zM14.8 9h1.8v1.8h-1.8zM17.8 9h.8v1.8h-.8z',
      'M5.8 11.8h1.8v1.8H5.8zM8.8 11.8h1.8v1.8H8.8zM11.8 11.8h1.8v1.8h-1.8zM14.8 11.8h1.8v1.8h-1.8zM17.8 11.8h.8v1.8h-.8z',
    ],
  },
  gamepad: {
    stroke: [
      'M8.4 7.4h7.2a5.4 5.4 0 0 1 5.2 6.8l-.5 1.9a2.3 2.3 0 0 1-4.2.6L14.7 14H9.3l-1.4 2.7a2.3 2.3 0 0 1-4.2-.6l-.5-1.9a5.4 5.4 0 0 1 5.2-6.8z',
      'M7 10.2v2.4M5.8 11.4h2.4',
    ],
    fill: ['M15.4 10.4a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM17.6 12.2a1 1 0 1 0 0 2 1 1 0 0 0 0-2z'],
  },
  speaker: {
    stroke: ['M4 9.4h3.4L12 5.4v13.2l-4.6-4H4z', 'M15.4 9.6a3.6 3.6 0 0 1 0 4.8', 'M17.9 7.2a7 7 0 0 1 0 9.6'],
  },
  credit: {
    stroke: ['M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6z'],
    fill: ['M12 7.6 16 9.8v4.4L12 16.4 8 14.2V9.8z'],
  },
  bolt: { fill: ['M13.6 2.4 6 13.2h4.6L9.8 21.6 18 10.4h-4.9z'] },
  shield: {
    stroke: ['M12 2.9 19.4 6v6.1c0 4.1-3 7.4-7.4 9-4.4-1.6-7.4-4.9-7.4-9V6z'],
  },
  clock: { stroke: ['M12 3.6a8.4 8.4 0 1 1 0 16.8 8.4 8.4 0 0 1 0-16.8z', 'M12 7.4V12l3.2 2'] },
  route: {
    stroke: [
      'M6.4 20.2c-2 0-3.4-1.3-3.4-3s1.4-3 3.4-3h11.2c2 0 3.4-1.3 3.4-3s-1.4-3-3.4-3H8',
    ],
    fill: ['M6.4 18.4a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z', 'M17.6 2a1.8 1.8 0 1 0 0 3.6A1.8 1.8 0 0 0 17.6 2z'],
  },
  restart: {
    stroke: ['M20 12a8 8 0 1 1-2.6-5.9'],
    fill: ['M20.8 3.2v5.4h-5.4z'],
  },
  play: { fill: ['M7.4 4.6 19 12 7.4 19.4z'] },
  pause: { fill: ['M8 5h2.8v14H8zM13.2 5H16v14h-2.8z'] },
  home: { stroke: ['M3.6 11.2 12 4l8.4 7.2', 'M5.8 10v10h12.4V10'] },
  warning: {
    stroke: ['M12 4.2 21 19.6H3z'],
    fill: ['M11.1 9.6h1.8v5h-1.8zM11.1 16h1.8v1.8h-1.8z'],
  },
  info: { stroke: ['M12 3.6a8.4 8.4 0 1 1 0 16.8 8.4 8.4 0 0 1 0-16.8z', 'M12 11v5.4'], fill: ['M11.1 7.2h1.8V9h-1.8z'] },
  pilot: {
    stroke: ['M12 4.2a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2z', 'M4.8 20.2c0-3.6 3.2-5.8 7.2-5.8s7.2 2.2 7.2 5.8'],
  },
  star: { fill: ['m12 3 2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 16.8 6.4 20.1l1.4-6.3L3 9.5l6.4-.6z'] },
  eye: { stroke: ['M2.6 12S6.4 5.8 12 5.8 21.4 12 21.4 12 17.6 18.2 12 18.2 2.6 12 2.6 12z', 'M12 9.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z'] },
  ghost: {
    stroke: ['M5.4 20.2V10a6.6 6.6 0 0 1 13.2 0v10.2l-2.2-1.6-2.2 1.6-2.2-1.6-2.2 1.6-2.2-1.6z'],
    fill: ['M9.4 9.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zM14.6 9.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2z'],
  },
} satisfies Record<string, IconSpec>;

/**
 * Builds one icon. Size is in px; the stroke width is scaled with it so a
 * 14px icon does not end up looking like a hairline next to 20px body text.
 */
export function icon(name: IconName, size = 20): SVGSVGElement {
  const spec = ICONS[name] as IconSpec;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('vh-icon');

  for (const d of spec.stroke ?? []) {
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  }
  for (const d of spec.fill ?? []) {
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
  }
  return svg;
}

/**
 * The wordmark's monogram: a forward-raked double chevron inside a chamfered
 * hex. Drawn rather than set in type because the letterforms available in a
 * system font stack cannot carry a logo on their own.
 */
export function monogram(size = 64): SVGSVGElement {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('vh-monogram');

  const hex = document.createElementNS(SVGNS, 'path');
  hex.setAttribute('d', 'M32 2 58 15.5v33L32 62 6 48.5v-33z');
  hex.setAttribute('fill', 'none');
  hex.setAttribute('stroke', 'currentColor');
  hex.setAttribute('stroke-width', '2');
  hex.setAttribute('stroke-linejoin', 'round');
  hex.setAttribute('opacity', '0.55');
  svg.appendChild(hex);

  const chevronA = document.createElementNS(SVGNS, 'path');
  chevronA.setAttribute('d', 'M17 20h9.5L38 32 26.5 44H17l11.5-12z');
  chevronA.setAttribute('fill', 'currentColor');
  svg.appendChild(chevronA);

  const chevronB = document.createElementNS(SVGNS, 'path');
  chevronB.setAttribute('d', 'M33 20h9.5L54 32 42.5 44H33l11.5-12z');
  chevronB.setAttribute('fill', 'currentColor');
  chevronB.setAttribute('opacity', '0.45');
  svg.appendChild(chevronB);

  return svg;
}

/**
 * The garage's craft portrait: a top-down racer drawn from the ship's own
 * hull, trim and engine colours.
 *
 * The roster already carries three colours per craft for the procedural 3D
 * model, so the menu uses the same three rather than inventing a palette. It
 * makes the Vyper unmistakably red and the Zenith unmistakably black without a
 * single image file.
 */
export function shipSilhouette(colors: { hull: number; trim: number; engine: number }, height = 250): SVGSVGElement {
  const hex = (v: number): string => `#${(v >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 168');
  svg.setAttribute('height', String(height));
  svg.setAttribute('width', String(Math.round((height * 120) / 168)));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('vh-craft');

  const add = (d: string, fill: string, cls?: string, opacity?: string): SVGPathElement => {
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', fill);
    if (cls) path.setAttribute('class', cls);
    if (opacity) path.setAttribute('opacity', opacity);
    svg.appendChild(path);
    return path;
  };

  // Shadow plate under the craft — the light source is above and behind.
  const plate = document.createElementNS(SVGNS, 'ellipse');
  plate.setAttribute('cx', '60');
  plate.setAttribute('cy', '150');
  plate.setAttribute('rx', '46');
  plate.setAttribute('ry', '9');
  plate.setAttribute('fill', hex(colors.engine));
  plate.setAttribute('opacity', '0.1');
  svg.appendChild(plate);

  // Hull: a dart with swept wings and a squared tail. The rim stroke in the
  // trim colour is what keeps a near-black hull (the Zenith) legible against
  // a near-black panel.
  const hull = add(
    'M60 5 65 19 71 55 100 112 103 138 76 130 71 148 49 148 44 130 17 138 20 112 49 55 55 19Z',
    hex(colors.hull),
    'vh-craft__hull',
  );
  hull.setAttribute('stroke', hex(colors.trim));
  hull.setAttribute('stroke-width', '1.6');
  hull.setAttribute('stroke-opacity', '0.55');
  hull.setAttribute('stroke-linejoin', 'round');
  // Upper surface highlight, offset toward the nose.
  add('M60 12 63 22 67 55 60 92 53 55 57 22Z', '#ffffff', undefined, '0.1');
  // Trim: canopy and wing tips.
  add('M60 26 66 56 60 80 54 56Z', hex(colors.trim), 'vh-craft__canopy');
  add('M100 112 103 138 84 133 88 108Z', hex(colors.trim), undefined, '0.85');
  add('M20 112 17 138 36 133 32 108Z', hex(colors.trim), undefined, '0.85');
  // Engines.
  add('M46 118h12v22H46z', hex(colors.engine), 'vh-craft__engine');
  add('M62 118h12v22H62z', hex(colors.engine), 'vh-craft__engine');
  // Thrust wash.
  add('M48 140h24l-5 26h-14z', hex(colors.engine), 'vh-craft__wash', '0.42');

  return svg;
}

/**
 * A medal as a chamfered hex plaque. Tier colouring is handled in CSS so the
 * same node can be recoloured during the results reveal.
 */
export function medalMark(size = 34): SVGSVGElement {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');

  const plate = document.createElementNS(SVGNS, 'path');
  plate.setAttribute('d', 'M16 1.5 28.6 8.8v14.4L16 30.5 3.4 23.2V8.8z');
  plate.setAttribute('fill', 'currentColor');
  plate.setAttribute('opacity', '0.18');
  svg.appendChild(plate);

  const edge = document.createElementNS(SVGNS, 'path');
  edge.setAttribute('d', 'M16 1.5 28.6 8.8v14.4L16 30.5 3.4 23.2V8.8z');
  edge.setAttribute('fill', 'none');
  edge.setAttribute('stroke', 'currentColor');
  edge.setAttribute('stroke-width', '1.6');
  edge.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(edge);

  const chevron = document.createElementNS(SVGNS, 'path');
  chevron.setAttribute('d', 'M11 10.5h4.6L21 16l-5.4 5.5H11l5.4-5.5z');
  chevron.setAttribute('fill', 'currentColor');
  svg.appendChild(chevron);

  return svg;
}
