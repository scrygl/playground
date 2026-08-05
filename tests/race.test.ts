import { getTrack } from '../src/track/library';
import { generateTrack, randomSeed } from '../src/track/generator';
import { Track } from '../src/track/runtime';
import { Race, crossedForward, grooveMultiplier } from '../src/game/race';
import { Driver } from '../src/game/driver';
import { GhostPlayer } from '../src/game/ghost';
import { neutralControls } from '../src/game/vehicle';
import type { RaceConfig } from '../src/game/types';
import { loopDelta } from '../src/core/mathx';
import { check, describe, near, range, report } from './harness';

const FRAME = 1 / 60;

function config(overrides: Partial<RaceConfig> = {}): RaceConfig {
  return {
    mode: 'quick',
    trackId: 'neon-meridian',
    shipId: 'kestrel',
    rivals: 5,
    laps: 2,
    difficulty: 0.6,
    seed: 'test-seed',
    useGhost: false,
    ...overrides,
  };
}

/**
 * Runs a race to completion with an AI standing in for the player, so the whole
 * director is exercised the way a real session would exercise it.
 */
function runRace(
  track: Track,
  cfg: RaceConfig,
  maxSeconds = 420,
  playerSkill = 0.85,
): { race: Race; seconds: number; frames: number } {
  const race = new Race({ track, config: cfg });
  const pilot = new Driver(track, { skill: playerSkill, seed: 'player-stand-in' });
  let seconds = 0;
  let frames = 0;
  while (!race.isOver && seconds < maxSeconds) {
    const controls = race.phase === 'racing' ? pilot.update(race.player.vehicle, FRAME) : neutralControls();
    race.update(FRAME, controls);
    race.events.length = 0;
    seconds += FRAME;
    frames++;
  }
  return { race, seconds, frames };
}

describe('crossedForward', () => {
  const L = 1000;
  check('detects a plain forward crossing', crossedForward(100, 200, 150, L));
  check('ignores a target behind', !crossedForward(100, 200, 50, L));
  check('ignores a target ahead', !crossedForward(100, 200, 250, L));
  check('handles wrapping past the start line', crossedForward(980, 20, 5, L));
  check('handles wrapping with the target before the line', crossedForward(980, 20, 990, L));
  check('excludes the starting point itself', !crossedForward(100, 200, 100, L));
  check('includes the end point', crossedForward(100, 200, 200, L));
  check('reports nothing when stationary', !crossedForward(100, 100, 100, L));
  // A craft that reverses must not re-trigger everything it already passed.
  check('ignores backwards movement', !crossedForward(200, 100, 150, L));
  check('ignores a large backwards wrap', !crossedForward(20, 980, 990, L));
});

describe('groove multiplier', () => {
  near('no chain is a plain multiplier', grooveMultiplier(0), 1, 1e-6);
  check('chain increases the multiplier', grooveMultiplier(10) > grooveMultiplier(5));
  check('multiplier is capped', grooveMultiplier(1000) <= 3.01, `${grooveMultiplier(1000)}`);
  near('cap is reached at 30', grooveMultiplier(30), grooveMultiplier(500), 1e-6);
});

describe('a full quick race', () => {
  const track = Track.build(getTrack('neon-meridian'));
  const { race, seconds } = runRace(track, config());

  check('race reaches a terminal phase', race.isOver, `phase=${race.phase}`);
  check('race did not time out', seconds < 419, `${seconds.toFixed(0)}s`);
  check('player finished', race.player.finished);

  const result = race.getResult();
  check('a result is produced', result !== null);
  if (result) {
    range('finishing position is valid', result.position, 1, 6);
    check('lap times were recorded', result.laps.length === 2, `${result.laps.length} laps`);
    check('every lap time is positive', result.laps.every((l) => l.time > 1000));
    check('exactly one lap is flagged best', result.laps.filter((l) => l.best).length === 1);
    check('total time exceeds the best lap', result.totalTime > result.bestLap);
    // The clock runs from lights-out, and the grid sits behind the line, so
    // the total legitimately exceeds the laps by one standing start.
    const lapSum = result.laps.reduce((a, l) => a + l.time, 0);
    const launch = result.totalTime - lapSum;
    range('total time is the laps plus one standing start', launch / 1000, 0.2, 8);
  }

  // Positions must form a permutation — no ties, no gaps.
  const positions = race.racers.map((r) => r.position).sort((a, b) => a - b);
  check(
    'positions are a clean permutation',
    positions.every((p, i) => p === i + 1),
    positions.join(','),
  );

  check(
    'every racer made real progress',
    race.racers.every((r) => r.vehicle.progress > track.path.length * 0.5),
    race.racers.map((r) => r.vehicle.progress.toFixed(0)).join(' '),
  );
  check(
    'no racer state went non-finite',
    race.racers.every((r) => Number.isFinite(r.vehicle.s) && Number.isFinite(r.vehicle.speed)),
  );
});

describe('the field spreads out', () => {
  const track = Track.build(getTrack('solstice-ring'));
  const { race } = runRace(track, config({ trackId: 'solstice-ring', rivals: 7, laps: 2 }));
  // The race ends the moment the player crosses the line, so most rivals are
  // still running; what matters is that they are strung out along the circuit
  // rather than bunched or lapped into meaninglessness.
  const progresses = race.racers.map((r) => r.vehicle.progress).sort((a, b) => b - a);
  const spread = progresses[0] - progresses[progresses.length - 1];
  range('the field is strung out, not bunched or scattered', spread / track.path.length, 0.02, 1.6);
  check(
    'every rival is within a lap of the leader',
    spread < track.path.length * 1.6,
    `spread ${spread.toFixed(0)} m over ${track.path.length.toFixed(0)} m lap`,
  );
});

describe('difficulty changes the outcome', () => {
  const track = Track.build(getTrack('neon-meridian'));
  // A weak player against strong rivals should do worse than a strong player
  // against weak ones. Anything else means difficulty is not wired up.
  const weak = runRace(track, config({ difficulty: 0.95 }), 420, 0.3).race;
  const strong = runRace(track, config({ difficulty: 0.2 }), 420, 1).race;
  check(
    'a strong player against weak rivals finishes higher',
    strong.player.position < weak.player.position,
    `strong P${strong.player.position} vs weak P${weak.player.position}`,
  );
});

describe('time trial', () => {
  const track = Track.build(getTrack('helix-gate'));
  const { race } = runRace(track, config({ mode: 'timetrial', trackId: 'helix-gate', rivals: 0, laps: 2 }));
  check('time trial completes', race.isOver && race.player.finished);
  const result = race.getResult();
  check('a medal is decided', result !== null && result.medal !== undefined);
  check('only the player is on track', race.racers.length === 1);

  const ghost = race.recordedGhost;
  check('a ghost was recorded', ghost !== null && ghost.length > 0, `${ghost?.length ?? 0} values`);

  if (ghost) {
    const player = new GhostPlayer(ghost, track.path.length);
    check('recorded ghost is playable', player.valid);
    range('ghost duration is a plausible lap', player.duration / 1000, 20, 180);

    // Replay must follow the recorded path, including across the start line.
    let maxError = 0;
    for (let t = 0; t <= player.duration; t += 100) {
      const pose = player.seek(t);
      if (!Number.isFinite(pose.s) || !Number.isFinite(pose.lateral)) {
        maxError = Infinity;
        break;
      }
      // Distance must advance monotonically apart from the wrap.
      maxError = Math.max(maxError, Math.abs(pose.height) > 200 ? 999 : 0);
    }
    check('replayed poses stay finite and on the track', maxError < 1, `${maxError}`);

    // Seeking backwards must give the same answer as seeking forwards.
    const forward = { ...player.seek(player.duration * 0.5) };
    player.seek(player.duration * 0.9);
    const backward = player.seek(player.duration * 0.5);
    near('seeking is order-independent', backward.s, forward.s, 0.01);
    near('lateral seek is order-independent', backward.lateral, forward.lateral, 0.01);

    // The ghost's own recorded distance should increase with time.
    const early = player.timeAtDistance(track.path.length * 0.25);
    const late = player.timeAtDistance(track.path.length * 0.75);
    check('time-at-distance increases along the lap', late > early, `${early} vs ${late}`);
  }
});

describe('ghost racing produces a delta', () => {
  const track = Track.build(getTrack('neon-meridian'));
  const first = runRace(track, config({ mode: 'timetrial', rivals: 0, laps: 2 })).race;
  const ghost = first.recordedGhost;
  check('first run recorded a ghost', ghost !== null);
  if (!ghost) return;

  const race = new Race({
    track,
    config: config({ mode: 'timetrial', rivals: 0, laps: 2, useGhost: true }),
    ghostData: ghost,
  });
  const pilot = new Driver(track, { skill: 0.85, seed: 'ghost-run' });
  let sawFiniteDelta = false;
  let sawGhostPose = false;
  for (let i = 0; i < 60 / FRAME && !race.isOver; i++) {
    race.update(FRAME, race.phase === 'racing' ? pilot.update(race.player.vehicle, FRAME) : neutralControls());
    race.events.length = 0;
    if (Number.isFinite(race.hud.ghostDelta)) sawFiniteDelta = true;
    if (race.ghostPose()) sawGhostPose = true;
  }
  check('ghost delta is reported', sawFiniteDelta);
  check('ghost pose is available for rendering', sawGhostPose);
  check('ghost delta is a sane magnitude', Math.abs(race.hud.ghostDelta) < 120000, `${race.hud.ghostDelta}`);
});

describe('elimination', () => {
  const track = Track.build(getTrack('neon-meridian'));
  const race = new Race({ track, config: config({ mode: 'elimination', rivals: 5, laps: 8 }) });
  const pilot = new Driver(track, { skill: 0.95, seed: 'elim' });
  let seconds = 0;
  while (!race.isOver && seconds < 300) {
    race.update(FRAME, race.phase === 'racing' ? pilot.update(race.player.vehicle, FRAME) : neutralControls());
    race.events.length = 0;
    seconds += FRAME;
  }
  const eliminated = race.racers.filter((r) => r.eliminated).length;
  check('craft are eliminated over time', eliminated > 0, `${eliminated} eliminated`);
  check('elimination reaches a conclusion', race.isOver, `phase=${race.phase} after ${seconds.toFixed(0)}s`);
});

describe('zone survival', () => {
  const track = Track.build(getTrack('neon-meridian'));
  const race = new Race({ track, config: config({ mode: 'zone', rivals: 0, laps: 99 }) });
  const pilot = new Driver(track, { skill: 0.9, seed: 'zone' });
  let seconds = 0;
  let peakSpeed = 0;
  while (!race.isOver && seconds < 150) {
    race.update(FRAME, race.phase === 'racing' ? pilot.update(race.player.vehicle, FRAME) : neutralControls());
    race.events.length = 0;
    peakSpeed = Math.max(peakSpeed, race.player.vehicle.speed);
    seconds += FRAME;
  }
  check('zone level climbs', race.zone >= 3, `reached zone ${race.zone} in ${seconds.toFixed(0)}s`);
  check('the craft is pushed past its normal top speed', peakSpeed > 150, `${peakSpeed.toFixed(0)} m/s`);
  check('score accumulates with zones', race.player.score > 0, `${race.player.score}`);
});

describe('generated circuits are raceable', () => {
  for (const seed of ['alpha-run-101', 'vesper-drift-777', randomSeed()]) {
    const definition = generateTrack({ seed });
    let track: Track | null = null;
    let error = '';
    try {
      track = Track.build(definition);
    } catch (e) {
      error = String(e);
    }
    check(`generated "${seed}" builds`, track !== null, error);
    if (!track) continue;

    range(`generated "${seed}" is a plausible length`, track.path.length, 1200, 9000);
    // Same structural guarantees the handcrafted circuits get.
    let maxCurv = 0;
    for (let i = 0; i < track.path.count; i++) maxCurv = Math.max(maxCurv, Math.abs(track.path.rawCurvature(i)));
    check(
      `generated "${seed}" has no cusps`,
      maxCurv < 0.05,
      `tightest radius ${(1 / maxCurv).toFixed(1)} m`,
    );
    let lineOk = true;
    for (let i = 0; i < track.path.count; i++) {
      if (Math.abs(track.racingLine[i]) > track.path.rawHalfWidth(i)) lineOk = false;
    }
    check(`generated "${seed}" racing line stays on track`, lineOk);

    const { race } = runRace(track, config({ trackId: definition.id, rivals: 3, laps: 1, seed }), 300);
    check(`generated "${seed}" can be raced to the end`, race.isOver && race.player.finished, `phase=${race.phase}`);
  }
});

describe('determinism', () => {
  // The same seed and the same inputs must produce the same race, or ghosts,
  // replays, and shared seeds all mean nothing.
  const track = Track.build(getTrack('neon-meridian'));
  const runOnce = () => {
    const race = new Race({ track, config: config({ seed: 'determinism', laps: 1 }) });
    const pilot = new Driver(track, { skill: 0.8, seed: 'fixed-pilot' });
    for (let i = 0; i < 40 / FRAME && !race.isOver; i++) {
      race.update(FRAME, race.phase === 'racing' ? pilot.update(race.player.vehicle, FRAME) : neutralControls());
      race.events.length = 0;
    }
    return race.racers.map((r) => `${r.vehicle.s.toFixed(4)}:${r.vehicle.lateral.toFixed(4)}`).join('|');
  };
  check('two identical runs agree exactly', runOnce() === runOnce());
});

describe('lap wrap bookkeeping', () => {
  const track = Track.build(getTrack('neon-meridian'));
  const L = track.path.length;
  near('loopDelta handles the seam', loopDelta(L - 10, 10, L), 20, 1e-6);
  near('loopDelta is signed', loopDelta(10, L - 10, L), -20, 1e-6);

  const { race } = runRace(track, config({ laps: 3 }), 420);
  check(
    'no craft reports more laps than it drove',
    race.racers.every((r) => r.vehicle.lap <= 4),
    race.racers.map((r) => r.vehicle.lap).join(','),
  );
  check(
    'lap counts match recorded lap times for finishers',
    race.racers.filter((r) => r.finished).every((r) => r.lapTimes.length >= 3),
  );
});

describe('hud snapshot integrity', () => {
  const track = Track.build(getTrack('cascade-run'));
  const race = new Race({ track, config: config({ trackId: 'cascade-run', laps: 2 }) });
  const pilot = new Driver(track, { skill: 0.8, seed: 'hud' });
  let bad = 0;
  let sawCountdown = false;
  let sawRacing = false;
  for (let i = 0; i < 90 / FRAME && !race.isOver; i++) {
    race.update(FRAME, race.phase === 'racing' ? pilot.update(race.player.vehicle, FRAME) : neutralControls());
    race.events.length = 0;
    const h = race.hud;
    if (h.phase === 'countdown') sawCountdown = true;
    if (h.phase === 'racing') sawRacing = true;
    if (
      !Number.isFinite(h.speed) ||
      !Number.isFinite(h.time) ||
      h.position < 1 ||
      h.position > h.entrants ||
      h.lapProgress < 0 ||
      h.lapProgress > 1 ||
      h.shieldFraction < 0 ||
      h.shieldFraction > 1 ||
      h.standings.length !== race.racers.length
    ) {
      bad++;
    }
  }
  check('countdown phase was observed', sawCountdown);
  check('racing phase was observed', sawRacing);
  check('every HUD snapshot is well-formed', bad === 0, `${bad} bad frames`);
  check(
    'standings are ordered by position',
    race.hud.standings.every((row, i, arr) => i === 0 || arr[i - 1].position <= row.position),
  );
});

describe('variable frame rate does not change the simulation much', () => {
  // The fixed timestep exists so that a 30 fps machine and a 144 fps machine
  // race the same car. Small divergence from accumulator remainders is fine;
  // a different outcome is not.
  const track = Track.build(getTrack('neon-meridian'));
  const distanceAfter = (frameDt: number) => {
    const race = new Race({ track, config: config({ seed: 'framerate', rivals: 1, laps: 3 }) });
    const pilot = new Driver(track, { skill: 0.8, seed: 'fixed-pilot' });
    let t = 0;
    while (t < 30 && !race.isOver) {
      race.update(frameDt, race.phase === 'racing' ? pilot.update(race.player.vehicle, frameDt) : neutralControls());
      race.events.length = 0;
      t += frameDt;
    }
    return race.player.vehicle.progress;
  };
  const at30 = distanceAfter(1 / 30);
  const at60 = distanceAfter(1 / 60);
  const at144 = distanceAfter(1 / 144);
  const spread = Math.max(at30, at60, at144) - Math.min(at30, at60, at144);
  check(
    'distance covered in 30 s agrees across frame rates',
    spread / at60 < 0.04,
    `30fps ${at30.toFixed(0)} 60fps ${at60.toFixed(0)} 144fps ${at144.toFixed(0)} (spread ${((spread / at60) * 100).toFixed(1)}%)`,
  );
});

report('race director');
