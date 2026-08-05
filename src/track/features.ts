import { Rng } from '../core/rng';
import type { TrackPath } from './path';
import type { MusicProfile, TrackFeature } from './types';

/**
 * Places pickups, boost pads and rhythm gates along a finished path.
 *
 * Placement is driven by the geometry rather than sprinkled at random: pads go
 * where a player has just worked for exit speed, pickups sit off the fast line
 * so taking one costs time, and beat gates are spaced by how far the ship
 * travels in one musical beat — which is what makes them hittable in rhythm
 * instead of being decoration that happens to glow.
 */

export interface FeaturePlacementOptions {
  music: MusicProfile;
  /** Expected pace in m/s — beat-gate spacing is derived from this. */
  paceSpeed: number;
  seed: string;
  laps: number;
}

/** Curvature below this counts as "straight enough to be going fast". */
const STRAIGHT_CURVATURE = 0.0035;

interface Section {
  start: number;
  end: number;
  length: number;
  meanCurvature: number;
}

/** Split the lap into runs of straight and runs of corner. */
function findSections(path: TrackPath, straight: boolean): Section[] {
  const sections: Section[] = [];
  const n = path.count;
  let runStart = -1;
  let sum = 0;
  let count = 0;

  for (let i = 0; i <= n; i++) {
    const k = i % n;
    const isStraight = Math.abs(path.rawCurvature(k)) < STRAIGHT_CURVATURE;
    const matches = isStraight === straight && !path.rawGap(k);
    if (matches && runStart < 0) {
      runStart = k;
      sum = 0;
      count = 0;
    }
    if (matches) {
      sum += path.rawCurvature(k);
      count++;
    }
    if ((!matches || i === n) && runStart >= 0) {
      const start = runStart * path.step;
      const end = k * path.step;
      const length = end > start ? end - start : path.length - start + end;
      if (length > 40) {
        sections.push({ start, end, length, meanCurvature: count ? sum / count : 0 });
      }
      runStart = -1;
    }
  }
  return sections;
}

export function placeFeatures(
  path: TrackPath,
  options: FeaturePlacementOptions,
): TrackFeature[] {
  const rng = new Rng(`${options.seed}:features`);
  const features: TrackFeature[] = [];
  const straights = findSections(path, true).sort((a, b) => b.length - a.length);

  // --- Checkpoints ------------------------------------------------------
  // Four per lap. These drive split times and, more importantly, respawn
  // points — so they must never land inside a gap.
  const checkpointCount = 4;
  for (let i = 0; i < checkpointCount; i++) {
    let s = (i / checkpointCount) * path.length;
    let guard = 0;
    while (path.isGapAt(s) && guard++ < 200) s = path.wrap(s + path.step);
    features.push({ kind: 'checkpoint', s, lateral: 0, size: 1 });
  }

  // --- Boost pads -------------------------------------------------------
  // Placed just after a corner exit, where committing early pays off, and
  // partway down long straights to keep top speed climbing.
  const corners = findSections(path, false);
  for (const corner of corners) {
    if (corner.length < 60) continue;
    const s = path.wrap(corner.end + rng.range(25, 70));
    if (path.isGapAt(s)) continue;
    // Offset toward the inside of the corner just taken, rewarding a tight exit.
    const inside = -Math.sign(corner.meanCurvature) * rng.range(0.15, 0.45);
    features.push({ kind: 'boost', s, lateral: inside, size: 0.3 });
  }
  for (const straight of straights) {
    if (straight.length < 260) continue;
    const pads = Math.min(2, Math.floor(straight.length / 260));
    for (let i = 0; i < pads; i++) {
      const s = path.wrap(straight.start + straight.length * ((i + 1) / (pads + 1)));
      if (path.isGapAt(s)) continue;
      features.push({ kind: 'boost', s, lateral: rng.range(-0.35, 0.35), size: 0.3 });
    }
  }

  // --- Beat gates -------------------------------------------------------
  // A gate every beat at the expected pace. Runs of 6–10 gates sit on the
  // longest straights so the rhythm is readable rather than fighting a corner.
  const beatSeconds = 60 / options.music.bpm;
  const gateSpacing = Math.max(45, options.paceSpeed * beatSeconds);
  const runCount = Math.min(3, straights.length);
  for (let r = 0; r < runCount; r++) {
    const straight = straights[r];
    if (straight.length < gateSpacing * 3) continue;
    const gates = Math.min(10, Math.floor((straight.length - gateSpacing) / gateSpacing));
    if (gates < 3) continue;
    // Centre the run in the straight so the first gate isn't right on the exit.
    const runLength = gates * gateSpacing;
    const offset = straight.start + (straight.length - runLength) * 0.5;
    for (let i = 0; i < gates; i++) {
      const s = path.wrap(offset + i * gateSpacing);
      if (path.isGapAt(s)) continue;
      features.push({
        kind: 'beatgate',
        s,
        // A gentle slalom keeps the player working rather than holding a line.
        lateral: Math.sin(i * 0.9 + r) * 0.45,
        size: 0.55,
        beat: i % 4,
      });
    }
  }

  // --- Shield pickups ---------------------------------------------------
  // Deliberately off the racing line: taking one should cost a tenth.
  const shieldCount = 3;
  for (let i = 0; i < shieldCount; i++) {
    const s = path.wrap((i / shieldCount) * path.length + rng.range(-60, 60));
    if (path.isGapAt(s)) continue;
    const curvature = path.curvatureAt(s);
    // Sit on the outside of whatever the track is doing here.
    const outside = curvature === 0 ? (rng.bool() ? 1 : -1) : Math.sign(curvature);
    features.push({ kind: 'shield', s, lateral: outside * rng.range(0.5, 0.78), size: 0.22 });
  }

  // --- Weapon pads ------------------------------------------------------
  // In rows across the track so trailing racers can pick their lane.
  const weaponRows = 3;
  for (let i = 0; i < weaponRows; i++) {
    const s = path.wrap(((i + 0.5) / weaponRows) * path.length + rng.range(-40, 40));
    if (path.isGapAt(s)) continue;
    for (const lateral of [-0.5, 0, 0.5]) {
      features.push({ kind: 'weapon', s, lateral, size: 0.2 });
    }
  }

  features.sort((a, b) => a.s - b.s);
  return features;
}
