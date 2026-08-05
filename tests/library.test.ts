import { Vector3 } from 'three';
import { buildPath, solveClosure } from '../src/track/builder';
import { CHAMPIONSHIPS, TRACKS, TRACKS_BY_ID } from '../src/track/library';
import { Track } from '../src/track/runtime';
import { createFrame } from '../src/track/path';
import { check, describe, near, range, report } from './harness';

/** Every handcrafted track is built once and inspected in full. */
const built = new Map<string, Track>();
const buildMs = new Map<string, number>();

describe('every track builds', () => {
  for (const def of TRACKS) {
    const t0 = performance.now();
    let track: Track | null = null;
    let error = '';
    try {
      track = Track.build(def);
    } catch (e) {
      error = String(e);
    }
    check(`${def.id} builds`, track !== null, error);
    if (!track) continue;
    built.set(def.id, track);
    buildMs.set(def.id, performance.now() - t0);
  }
});

describe('recipes close cleanly', () => {
  for (const def of TRACKS) {
    const raw = buildPath(solveClosure(def.segments), {
      halfWidth: def.halfWidth,
      close: false,
    });
    // Anything left over is smeared across the lap by the compass-rule
    // adjustment, so what matters is that the residual is small enough to
    // vanish into a few thousand metres — and that no track needs the
    // cusp-prone Hermite bridge.
    check(
      `${def.id} solver closes the loop to within a lap's worth of slack`,
      raw.closureGap < 20,
      `residual gap ${raw.closureGap.toFixed(2)} m`,
    );
    // Turn angles are authored to sum to 360°, so the heading must come back
    // round; a mismatch means someone edited a corner without rebalancing.
    check(
      `${def.id} heading returns to start (${raw.closureAngle.toFixed(1)}°)`,
      raw.closureAngle < 12,
      `heading error ${raw.closureAngle.toFixed(2)}°`,
    );
  }
});

describe('geometry is sane', () => {
  for (const [id, track] of built) {
    const path = track.path;
    range(`${id} length is a plausible circuit`, path.length, 1500, 8000);
    check(`${id} has samples`, path.count > 400, `count=${path.count}`);

    const frame = createFrame();
    let maxOrtho = 0;
    let maxJump = 0;
    let minWidth = Infinity;
    const prev = new Vector3();
    for (let i = 0; i < path.count; i++) {
      path.frameAt(i * path.step, frame);
      maxOrtho = Math.max(
        maxOrtho,
        Math.abs(frame.tangent.dot(frame.up)),
        Math.abs(frame.up.dot(frame.right)),
        Math.abs(frame.tangent.length() - 1),
      );
      if (i > 0) maxJump = Math.max(maxJump, frame.up.angleTo(prev));
      prev.copy(frame.up);
      minWidth = Math.min(minWidth, frame.halfWidth);
    }
    near(`${id} basis stays orthonormal`, maxOrtho, 0, 1e-4);
    check(
      `${id} frame never tears`,
      maxJump < 0.25,
      `largest inter-sample rotation ${((maxJump * 180) / Math.PI).toFixed(1)}°`,
    );
    check(`${id} never narrows past a ship width`, minWidth > 8, `min half-width ${minWidth.toFixed(1)} m`);
  }
});

describe('racing line stays on the track', () => {
  for (const [id, track] of built) {
    let worst = -Infinity;
    let worstAt = 0;
    for (let i = 0; i < track.path.count; i++) {
      const limit = track.path.rawHalfWidth(i);
      const over = Math.abs(track.racingLine[i]) - limit;
      if (over > worst) {
        worst = over;
        worstAt = i * track.path.step;
      }
    }
    check(
      `${id} racing line is inside the barriers`,
      worst < 0,
      `overshoots by ${worst.toFixed(2)} m at s=${worstAt.toFixed(0)}`,
    );

    // A line that never moves means the solver did nothing useful.
    let spread = 0;
    for (let i = 0; i < track.racingLine.length; i++) spread = Math.max(spread, Math.abs(track.racingLine[i]));
    check(`${id} racing line actually uses the width`, spread > 2, `max offset only ${spread.toFixed(2)} m`);
  }
});

describe('speed profile is physical', () => {
  for (const [id, track] of built) {
    let min = Infinity;
    let max = 0;
    let maxAccel = 0;
    for (let i = 0; i < track.speedProfile.length; i++) {
      const v = track.speedProfile[i];
      check(`${id} speed is finite`, Number.isFinite(v) && v > 0);
      min = Math.min(min, v);
      max = Math.max(max, v);
      const nextV = track.speedProfile[(i + 1) % track.speedProfile.length];
      // Longitudinal acceleration implied between adjacent samples.
      const accel = Math.abs(nextV * nextV - v * v) / (2 * track.path.step);
      maxAccel = Math.max(maxAccel, accel);
    }
    range(`${id} slowest corner is a real corner`, min, 25, 130);
    range(`${id} fastest section is fast`, max, 90, 245);
    check(
      `${id} profile respects the braking limit`,
      maxAccel < 60,
      `implied ${maxAccel.toFixed(1)} m/s² exceeds the 55 m/s² budget`,
    );
  }
});

describe('features land somewhere sensible', () => {
  for (const [id, track] of built) {
    const kinds = new Map<string, number>();
    let offTrack = 0;
    let inGap = 0;
    for (const f of track.features) {
      kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
      const halfWidth = track.path.halfWidthAt(f.s);
      if (Math.abs(f.lateral) > 1.0001) offTrack++;
      if (Math.abs(f.lateral) * halfWidth > halfWidth) offTrack++;
      if (track.path.isGapAt(f.s)) inGap++;
    }
    check(`${id} has checkpoints`, (kinds.get('checkpoint') ?? 0) === 4, JSON.stringify([...kinds]));
    check(`${id} has boost pads`, (kinds.get('boost') ?? 0) >= 2, JSON.stringify([...kinds]));
    check(`${id} has beat gates`, (kinds.get('beatgate') ?? 0) >= 3, JSON.stringify([...kinds]));
    check(`${id} no feature sits outside the surface`, offTrack === 0, `${offTrack} off-track`);
    check(`${id} no feature floats over a gap`, inGap === 0, `${inGap} in gaps`);
    check(
      `${id} features are sorted by distance`,
      track.features.every((f, i, arr) => i === 0 || arr[i - 1].s <= f.s),
    );
  }
});

describe('medals are ordered and reachable', () => {
  for (const [id, track] of built) {
    const m = track.medals;
    check(
      `${id} medal thresholds descend`,
      m.author < m.gold && m.gold < m.silver && m.silver < m.bronze,
      JSON.stringify(m),
    );
    // Author pace must be under what the precomputed speed profile allows,
    // otherwise a gold is mathematically impossible on the ideal line.
    const idealRaceMs = track.idealLapMs * track.definition.laps;
    check(
      `${id} author time is beatable on the ideal line`,
      idealRaceMs < m.author * 0.97,
      `ideal ${(idealRaceMs / 1000).toFixed(1)}s vs author ${(m.author / 1000).toFixed(1)}s`,
    );
    check(
      `${id} author time is not trivially beatable`,
      idealRaceMs > m.author * 0.85,
      `ideal ${(idealRaceMs / 1000).toFixed(1)}s is far under author ${(m.author / 1000).toFixed(1)}s`,
    );
  }
});

describe('grid and respawn', () => {
  for (const [id, track] of built) {
    const slots = Array.from({ length: 8 }, (_, i) => track.gridSlot(i, 8));
    const unique = new Set(slots.map((s) => `${s.s.toFixed(1)}:${s.lateral.toFixed(1)}`));
    check(`${id} grid slots are distinct`, unique.size === 8);
    for (const slot of slots) {
      const halfWidth = track.path.halfWidthAt(slot.s);
      check(`${id} grid slot is on the surface`, Math.abs(slot.lateral) < halfWidth - 2);
    }
    // Respawn must never drop a player into a hole.
    for (let i = 0; i < 60; i++) {
      const s = (i / 60) * track.path.length;
      check(`${id} respawn avoids gaps`, !track.path.isGapAt(track.safeRespawn(s)));
    }
  }
});

describe('progression graph', () => {
  for (const def of TRACKS) {
    for (const req of def.requires ?? []) {
      check(`${def.id} requires a track that exists (${req})`, TRACKS_BY_ID.has(req));
    }
  }
  const unlockable = new Set(TRACKS.filter((t) => !t.requires?.length).map((t) => t.id));
  // Walk the dependency graph; everything must eventually become reachable.
  for (let pass = 0; pass < TRACKS.length; pass++) {
    for (const def of TRACKS) {
      if ((def.requires ?? []).every((r) => unlockable.has(r))) unlockable.add(def.id);
    }
  }
  check('every track is reachable from the start', unlockable.size === TRACKS.length, `${unlockable.size}/${TRACKS.length}`);
  for (const cup of CHAMPIONSHIPS) {
    for (const id of cup.tracks) {
      check(`${cup.id} references a real track (${id})`, TRACKS_BY_ID.has(id));
    }
  }
});

describe('load cost', () => {
  let total = 0;
  let slowest = '';
  let slowestMs = 0;
  for (const [id, ms] of buildMs) {
    total += ms;
    if (ms > slowestMs) {
      slowestMs = ms;
      slowest = id;
    }
  }
  console.log(
    `    build cost: ${total.toFixed(0)}ms for ${buildMs.size} tracks, slowest ${slowest} at ${slowestMs.toFixed(0)}ms`,
  );
  check('a single track builds fast enough to load on demand', slowestMs < 900, `${slowest} took ${slowestMs.toFixed(0)}ms`);
});

report('track library');
