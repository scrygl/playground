import { Vector3 } from 'three';
import { buildPath } from '../src/track/builder';
import { TrackPath, createFrame } from '../src/track/path';
import type { TrackSegment } from '../src/track/types';
import { check, describe, near, range, report } from './harness';

const HALF_WIDTH = 22;

function make(segments: TrackSegment[], step = 2.5): TrackPath {
  const built = buildPath(segments, { halfWidth: HALF_WIDTH, close: true });
  return new TrackPath(built.points, step);
}

describe('closed oval', () => {
  // Four 90° turns and four straights: should close on itself almost exactly.
  const segments: TrackSegment[] = [];
  for (let i = 0; i < 4; i++) {
    segments.push({ kind: 'straight', length: 300 });
    segments.push({ kind: 'turn', angle: 90, radius: 150, bank: 25 });
  }
  const built = buildPath(segments, { halfWidth: HALF_WIDTH, close: true });
  near('authored path closes on itself', built.closureGap, 0, 1);

  const path = new TrackPath(built.points, 2.5);
  // Perimeter = 4 straights + 4 quarter-circles.
  const expected = 4 * 300 + 2 * Math.PI * 150;
  near('arc length matches the analytic perimeter', path.length, expected, expected * 0.02);
  near('sample spacing is uniform', path.step * path.count, path.length, 1e-3);

  const frame = createFrame();
  let maxOrtho = 0;
  let maxSpacing = 0;
  let minSpacing = Infinity;
  const prev = new Vector3();
  const cur = new Vector3();
  for (let i = 0; i < path.count; i++) {
    path.frameAt(i * path.step, frame);
    maxOrtho = Math.max(
      maxOrtho,
      Math.abs(frame.tangent.dot(frame.up)),
      Math.abs(frame.tangent.dot(frame.right)),
      Math.abs(frame.up.dot(frame.right)),
      Math.abs(frame.tangent.length() - 1),
      Math.abs(frame.up.length() - 1),
      Math.abs(frame.right.length() - 1),
    );
    cur.copy(frame.position);
    if (i > 0) {
      const d = cur.distanceTo(prev);
      maxSpacing = Math.max(maxSpacing, d);
      minSpacing = Math.min(minSpacing, d);
    }
    prev.copy(cur);
  }
  near('basis stays orthonormal everywhere', maxOrtho, 0, 1e-5);
  // Chord length is slightly under arc length on curves; both should hug `step`.
  range('sample spacing stays even', maxSpacing / minSpacing, 1, 1.02);
});

describe('track space round trip', () => {
  const path = make([
    { kind: 'straight', length: 200 },
    { kind: 'turn', angle: 120, radius: 120, bank: 30 },
    { kind: 'straight', length: 150, rise: 40 },
    { kind: 'turn', angle: -70, radius: 90 },
    { kind: 'helix', angle: 180, radius: 140, rise: 60, bank: 35 },
    { kind: 'straight', length: 220 },
  ]);

  let maxErr = 0;
  const world = new Vector3();
  for (let i = 0; i < 400; i++) {
    const s = (i / 400) * path.length;
    const lateral = Math.sin(i * 0.7) * HALF_WIDTH * 0.8;
    const height = 2 + Math.cos(i * 0.3) * 1.5;
    path.toWorld(s, lateral, height, world);
    const back = path.toTrack(world, s);
    const ds = Math.abs(((back.s - s + path.length * 1.5) % path.length) - path.length * 0.5);
    maxErr = Math.max(
      maxErr,
      ds,
      Math.abs(back.lateral - lateral),
      Math.abs(back.height - height),
    );
  }
  near('world→track→world is stable with a hint', maxErr, 0, 0.35);

  // Without a hint we fall back to the spatial hash; must still land close.
  let maxErrNoHint = 0;
  for (let i = 0; i < 120; i++) {
    const s = (i / 120) * path.length;
    path.toWorld(s, 4, 2, world);
    const back = path.toTrack(world);
    const ds = Math.abs(((back.s - s + path.length * 1.5) % path.length) - path.length * 0.5);
    maxErrNoHint = Math.max(maxErrNoHint, ds, Math.abs(back.lateral - 4), Math.abs(back.height - 2));
  }
  near('world→track works without a hint', maxErrNoHint, 0, 0.5);
});

describe('inversions', () => {
  // A full vertical loop must actually point the surface at the world floor
  // halfway round, and must not tear the frame anywhere.
  const path = make([
    { kind: 'straight', length: 160 },
    { kind: 'loop', radius: 85 },
    { kind: 'straight', length: 160 },
    { kind: 'turn', angle: 170, radius: 130 },
    { kind: 'straight', length: 200 },
    { kind: 'turn', angle: 170, radius: 130 },
  ]);

  const frame = createFrame();
  let minUpY = Infinity;
  let maxFrameJump = 0;
  const prevUp = new Vector3();
  for (let i = 0; i < path.count; i++) {
    path.frameAt(i * path.step, frame);
    minUpY = Math.min(minUpY, frame.up.y);
    if (i > 0) maxFrameJump = Math.max(maxFrameJump, frame.up.angleTo(prevUp));
    prevUp.copy(frame.up);
  }
  check('loop genuinely inverts the surface normal', minUpY < -0.9, `min up.y = ${minUpY.toFixed(3)}`);
  check(
    'frame rotates continuously through the inversion',
    maxFrameJump < 0.2,
    `largest step between samples = ${((maxFrameJump * 180) / Math.PI).toFixed(2)}°`,
  );
});

describe('corkscrew', () => {
  const path = make([
    { kind: 'straight', length: 120 },
    { kind: 'corkscrew', length: 260, turns: 1 },
    { kind: 'straight', length: 120 },
    { kind: 'turn', angle: 180, radius: 110 },
    { kind: 'straight', length: 260 },
    { kind: 'turn', angle: 180, radius: 110 },
  ]);
  const frame = createFrame();
  let minUpY = Infinity;
  let maxJump = 0;
  const prevUp = new Vector3();
  for (let i = 0; i < path.count; i++) {
    path.frameAt(i * path.step, frame);
    minUpY = Math.min(minUpY, frame.up.y);
    if (i > 0) maxJump = Math.max(maxJump, frame.up.angleTo(prevUp));
    prevUp.copy(frame.up);
  }
  check('corkscrew rolls fully upside down', minUpY < -0.85, `min up.y = ${minUpY.toFixed(3)}`);
  check(
    'no hemisphere flip artefact mid-roll',
    maxJump < 0.2,
    `largest step between samples = ${((maxJump * 180) / Math.PI).toFixed(2)}°`,
  );
});

describe('curvature sign', () => {
  const path = make([
    { kind: 'straight', length: 400 },
    { kind: 'turn', angle: 90, radius: 120 },
    { kind: 'straight', length: 400 },
    { kind: 'turn', angle: 90, radius: 120 },
    { kind: 'straight', length: 400 },
    { kind: 'turn', angle: 90, radius: 120 },
    { kind: 'straight', length: 400 },
    { kind: 'turn', angle: 90, radius: 120 },
  ]);

  // Sample the middle of the first right-hand turn.
  const sInTurn = 400 + (Math.PI * 120) / 4;
  const k = path.curvatureAt(sInTurn);
  check('right turn yields positive curvature', k > 0, `curvature = ${k.toFixed(5)}`);
  near('curvature magnitude matches 1/radius', Math.abs(k), 1 / 120, 0.0025);
  near('straight sections are flat', path.curvatureAt(200), 0, 0.002);
});

describe('gaps and variable width', () => {
  const built = buildPath(
    [
      { kind: 'straight', length: 200 },
      { kind: 'gap', length: 60 },
      { kind: 'straight', length: 200 },
      { kind: 'turn', angle: 180, radius: 120 },
      { kind: 'straight', length: 460 },
      { kind: 'turn', angle: 180, radius: 120 },
    ],
    { halfWidth: HALF_WIDTH, close: true },
  );
  const path = new TrackPath(built.points, 2.5);
  check('gap is present in the sampled path', path.isGapAt(230), 'expected a gap around s=230');
  check('surface either side of the gap is solid', !path.isGapAt(150) && !path.isGapAt(300));
  near('half width is carried through', path.halfWidthAt(100), HALF_WIDTH, 0.01);
});

describe('degenerate input', () => {
  let threw = false;
  try {
    new TrackPath(
      [
        { position: new Vector3(), up: new Vector3(0, 1, 0), halfWidth: 10, wall: 1, gap: false },
        { position: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0), halfWidth: 10, wall: 1, gap: false },
      ],
      2,
    );
  } catch {
    threw = true;
  }
  check('rejects paths with too few control points', threw);
});

report('track system');
