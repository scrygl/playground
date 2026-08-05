import { Quaternion, Vector3 } from 'three';
import { TRACKS, getTrack } from '../src/track/library';
import type { TrackDefinition } from '../src/track/types';
import { Track } from '../src/track/runtime';
import { SHIPS, getShip } from '../src/game/ships';
import { Vehicle, neutralControls, SHIP_HALF_WIDTH } from '../src/game/vehicle';
import { Driver } from '../src/game/driver';
import { check, describe, near, range, report } from './harness';

const DT = 1 / 120;

/**
 * A proving-ground circuit: six-kilometre straights, enormous radii, and wide
 * enough that nothing can reach a barrier. Straight-line figures have to be
 * measured somewhere the craft is genuinely going straight — on a real circuit
 * a car at full throttle with no steering input simply drives into a wall,
 * which measures the wall, not the engine.
 */
const PROVING_GROUND: TrackDefinition = {
  id: 'proving-ground',
  name: 'Proving Ground',
  tagline: 'Test rig',
  seed: 'proving-ground',
  difficulty: 1,
  laps: 1,
  halfWidth: 400,
  environment: 'starfield',
  segments: [
    { kind: 'straight', length: 9000 },
    { kind: 'turn', angle: 180, radius: 700 },
    { kind: 'straight', length: 9000 },
    { kind: 'turn', angle: 180, radius: 700 },
  ],
  palette: { primary: 0xffffff, secondary: 0xffffff, deep: 0, glow: 0xffffff, sun: 0xffffff, haze: 0 },
  music: { bpm: 120, root: 45, scale: 'minor', intensity: 0.5 },
};

// Coarse sampling: the racing-line solver is O(samples) and this rig is 20 km.
const provingGround = Track.build(PROVING_GROUND, 12);

function makeVehicle(trackId: string, shipId = 'kestrel', s = 0): { track: Track; vehicle: Vehicle } {
  const track = Track.build(getTrack(trackId));
  const vehicle = new Vehicle({ track, stats: getShip(shipId).stats, s, lateral: 0 });
  return { track, vehicle };
}

/** A craft on the long straight of the proving ground, facing down it. */
function onStraight(shipId = 'kestrel'): Vehicle {
  return new Vehicle({ track: provingGround, stats: getShip(shipId).stats, s: 10, lateral: 0 });
}

/** Runs a vehicle for `seconds` under a fixed control input. */
function run(vehicle: Vehicle, seconds: number, controls = neutralControls()): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) vehicle.step(controls, DT);
}

describe('straight-line performance', () => {
  for (const ship of SHIPS) {
    const vehicle = onStraight(ship.id);
    const controls = neutralControls();
    controls.throttle = 1;
    // Long enough to be firmly at terminal velocity, short enough to stay on
    // the straight — measuring inside the banking would measure the banking.
    run(vehicle, 34, controls);
    check(`${ship.id} stayed on the straight while measuring`, vehicle.s < 9000, `s=${vehicle.s.toFixed(0)}`);
    near(`${ship.id} settles at its stated top speed`, vehicle.speed, ship.stats.topSpeed, ship.stats.topSpeed * 0.03);
    check(`${ship.id} state stays finite`, Number.isFinite(vehicle.s) && Number.isFinite(vehicle.speed));
  }

  // Acceleration should be brisk but not instant.
  const vehicle = onStraight('kestrel');
  const controls = neutralControls();
  controls.throttle = 1;
  let timeTo90 = Infinity;
  for (let i = 0; i < 120 / DT; i++) {
    vehicle.step(controls, DT);
    if (vehicle.speed > getShip('kestrel').stats.topSpeed * 0.9) {
      timeTo90 = i * DT;
      break;
    }
  }
  range('kestrel reaches 90% of top speed in a sensible time', timeTo90, 4, 16);
});

describe('braking and reverse', () => {
  const vehicle = onStraight();
  const go = neutralControls();
  go.throttle = 1;
  run(vehicle, 32, go);
  const entrySpeed = vehicle.speed;

  const stop = neutralControls();
  stop.brake = 1;
  let stopTime = Infinity;
  for (let i = 0; i < 30 / DT; i++) {
    vehicle.step(stop, DT);
    if (vehicle.speed < 2) {
      stopTime = i * DT;
      break;
    }
  }
  check('braking brings the craft to a halt', Number.isFinite(stopTime), `still moving after 30 s`);
  range('stopping time is plausible', stopTime, 1.5, 8);
  check('braking does not drive the craft backwards fast', vehicle.velocityAlong > -30);
  check('entry speed was actually high', entrySpeed > 100, `${entrySpeed.toFixed(1)} m/s`);
});

describe('airbrakes rotate the craft', () => {
  const vehicle = onStraight();
  const go = neutralControls();
  go.throttle = 1;
  run(vehicle, 20, go);

  const before = vehicle.yaw;
  const brake = neutralControls();
  brake.throttle = 1;
  brake.airbrakeRight = 1;
  run(vehicle, 1, brake);
  check('right airbrake yaws right', vehicle.yaw > before + 0.1, `yaw moved ${(vehicle.yaw - before).toFixed(3)}`);

  const v2 = onStraight();
  run(v2, 20, go);
  const speedBefore = v2.speed;
  const both = neutralControls();
  both.airbrakeLeft = 1;
  both.airbrakeRight = 1;
  run(v2, 1.5, both);
  check('both airbrakes scrub speed', v2.speed < speedBefore * 0.9, `${speedBefore.toFixed(0)} → ${v2.speed.toFixed(0)}`);
  near('both airbrakes together do not net-yaw the craft', v2.yaw, 0, 0.15);
});

describe('inside line is genuinely shorter', () => {
  // Two craft, identical inputs, one on the inside of a long corner. The
  // inside one must gain centreline distance — if it does not, the racing
  // line is worthless and so is every overtake.
  const track = Track.build(getTrack('solstice-ring'));
  // Find a sustained corner.
  let cornerS = 0;
  let best = 0;
  for (let i = 0; i < track.path.count; i++) {
    const k = Math.abs(track.path.rawCurvature(i));
    if (k > best) {
      best = k;
      cornerS = i * track.path.step;
    }
  }
  const sign = Math.sign(track.path.curvatureAt(cornerS)) || 1;
  const start = track.path.wrap(cornerS - 60);

  const stats = getShip('kestrel').stats;
  const inside = new Vehicle({ track, stats, s: start, lateral: sign * 14 });
  const outside = new Vehicle({ track, stats, s: start, lateral: -sign * 14 });
  const go = neutralControls();
  go.throttle = 1;
  // Steer both to hold their offset through the corner.
  for (let i = 0; i < 4 / DT; i++) {
    for (const v of [inside, outside]) {
      const holdAt = v === inside ? sign * 14 : -sign * 14;
      go.steer = clamp(((holdAt - v.lateral) * 0.08 - v.yaw * 2.2), -1, 1);
      v.step(go, DT);
    }
  }
  check(
    'craft on the inside covers more centreline distance',
    inside.progress > outside.progress,
    `inside ${inside.progress.toFixed(1)} m vs outside ${outside.progress.toFixed(1)} m`,
  );
});

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

describe('walls contain the craft', () => {
  const { track, vehicle } = makeVehicle('ironbound');
  const go = neutralControls();
  go.throttle = 1;
  run(vehicle, 10, go);

  // Drive hard into the barrier for several seconds.
  const intoWall = neutralControls();
  intoWall.throttle = 1;
  intoWall.steer = 1;
  let maxOver = -Infinity;
  for (let i = 0; i < 6 / DT; i++) {
    vehicle.step(intoWall, DT);
    const limit = track.path.halfWidthAt(vehicle.s) - SHIP_HALF_WIDTH;
    maxOver = Math.max(maxOver, Math.abs(vehicle.lateral) - limit);
  }
  check('craft never passes through a solid wall', maxOver < 0.5, `overshot by ${maxOver.toFixed(3)} m`);
  check('hitting walls costs shield', vehicle.shieldFraction < 1);
  check('craft survives ordinary wall contact', !vehicle.destroyed);
});

describe('open ledges let the craft fall', () => {
  // Rainbow Vector has no guardrails anywhere.
  const { vehicle } = makeVehicle('rainbow-vector');
  const go = neutralControls();
  go.throttle = 1;
  run(vehicle, 6, go);
  const off = neutralControls();
  off.throttle = 1;
  off.steer = 1;
  let fell = false;
  for (let i = 0; i < 14 / DT; i++) {
    vehicle.step(off, DT);
    if (vehicle.height < -20) {
      fell = true;
      break;
    }
  }
  check('driving off an unwalled edge drops the craft', fell, `height ${vehicle.height.toFixed(1)} m`);
});

describe('respawn recovers cleanly', () => {
  // Fall the way a player actually falls — off the side of an open ledge —
  // rather than by teleporting the craft underground, which is not a state
  // the simulation can otherwise reach.
  const { track, vehicle } = makeVehicle('rainbow-vector');
  const off = neutralControls();
  off.throttle = 1;
  run(vehicle, 6, off);
  off.steer = 1;
  let destroyed = false;
  for (let i = 0; i < 25 / DT; i++) {
    vehicle.step(off, DT);
    if (vehicle.events.some((e) => e.type === 'destroyed')) destroyed = true;
    vehicle.events.length = 0;
    if (destroyed) break;
  }
  check('falling off the track eventually destroys the craft', destroyed, `height ${vehicle.height.toFixed(1)}`);
  vehicle.step(neutralControls(), DT);
  check('respawn puts the craft back on the surface', vehicle.height > 0 && vehicle.height < 12);
  check('respawn is not inside a gap', !track.path.isGapAt(vehicle.s));
  check('respawn clears the destroyed flag', !vehicle.destroyed);
  check(
    'respawn grants brief protection',
    vehicle.invulnerable > 0,
    `invulnerable=${vehicle.invulnerable} destroyed=${vehicle.destroyed} height=${vehicle.height.toFixed(1)}`,
  );
  check('respawn state is finite', Number.isFinite(vehicle.s) && Number.isFinite(vehicle.lateral));
});

describe('boost does what it says', () => {
  const vehicle = onStraight();
  const go = neutralControls();
  go.throttle = 1;
  run(vehicle, 30, go);
  const cruise = vehicle.speed;
  vehicle.applyBoost(4, 1);
  run(vehicle, 3, go);
  check('boost raises top speed', vehicle.speed > cruise * 1.08, `${cruise.toFixed(0)} → ${vehicle.speed.toFixed(0)}`);
  run(vehicle, 14, go);
  near('speed returns to normal after the boost expires', vehicle.speed, cruise, cruise * 0.06);
});

describe('AI completes clean laps on every track', () => {
  for (const def of TRACKS) {
    const track = Track.build(def);
    const stats = getShip('kestrel').stats;
    const vehicle = new Vehicle({ track, stats, s: 0, lateral: 0 });
    const driver = new Driver(track, { skill: 0.85, seed: `test-${def.id}` });

    let respawns = 0;
    let destroyed = 0;
    let lapTimes: number[] = [];
    let lastLapAt = 0;
    let bad = false;
    const maxSeconds = 400;

    for (let i = 0; i < maxSeconds / DT && lapTimes.length < 3; i++) {
      const controls = driver.update(vehicle, DT);
      vehicle.step(controls, DT);
      const t = i * DT;
      for (const e of vehicle.events) {
        if (e.type === 'respawn') respawns++;
        if (e.type === 'destroyed') destroyed++;
        if (e.type === 'lap') {
          lapTimes.push(t - lastLapAt);
          lastLapAt = t;
        }
      }
      vehicle.events.length = 0;
      if (!Number.isFinite(vehicle.s) || !Number.isFinite(vehicle.speed) || !Number.isFinite(vehicle.lateral)) {
        bad = true;
        break;
      }
    }

    check(`${def.id}: simulation stays finite`, !bad);
    check(`${def.id}: AI completes three laps`, lapTimes.length >= 3, `completed ${lapTimes.length}`);
    check(`${def.id}: AI does not fall off repeatedly`, destroyed <= 1, `${destroyed} destructions`);
    if (lapTimes.length >= 3) {
      // Compare the AI's flying lap against the theoretical ideal.
      const flying = Math.min(...lapTimes.slice(1));
      const idealSeconds = track.idealLapMs / 1000;
      range(
        `${def.id}: AI lap time is within reach of the ideal`,
        flying / idealSeconds,
        1.0,
        1.75,
      );
      console.log(
        `    ${def.id.padEnd(16)} ideal ${idealSeconds.toFixed(1)}s  AI ${flying.toFixed(1)}s  ` +
          `(${((flying / idealSeconds - 1) * 100).toFixed(0)}% off)  respawns=${respawns}`,
      );
    }
  }
});

describe('skill actually changes pace', () => {
  const track = Track.build(getTrack('neon-meridian'));
  const stats = getShip('kestrel').stats;
  const results: { skill: number; distance: number }[] = [];
  for (const skill of [0.25, 0.6, 1]) {
    const vehicle = new Vehicle({ track, stats, s: 0, lateral: 0 });
    const driver = new Driver(track, { skill, seed: 'skill-test', aggression: 0 });
    for (let i = 0; i < 90 / DT; i++) vehicle.step(driver.update(vehicle, DT), DT);
    results.push({ skill, distance: vehicle.progress });
  }
  check(
    'a better driver covers more ground in the same time',
    results[0].distance < results[1].distance && results[1].distance < results[2].distance,
    results.map((r) => `${r.skill}: ${r.distance.toFixed(0)}m`).join('  '),
  );
});

describe('transforms are renderable', () => {
  const { vehicle } = makeVehicle('cascade-run');
  const go = neutralControls();
  go.throttle = 1;
  const position = new Vector3();
  const quaternion = new Quaternion();
  let bad = 0;
  for (let i = 0; i < 40 / DT; i++) {
    vehicle.step(go, DT);
    vehicle.writeTransform(position, quaternion);
    if (!Number.isFinite(position.x) || Math.abs(quaternion.length() - 1) > 1e-3) bad++;
  }
  check('world transform is always finite and normalised', bad === 0, `${bad} bad frames`);
});

report('vehicle physics');
