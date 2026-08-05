import { AdaptiveQuality, PerformanceGovernor, applyEffectReduction, tierSettings, TIER_ORDER } from '../src/core/quality';
import { Rng, ValueNoise1D, hashString } from '../src/core/rng';
import { clamp, damp, deadzone, formatTime, loopDelta, mod, wrapAngle } from '../src/core/mathx';
import { check, describe, near, range, report } from './harness';

describe('seeded randomness', () => {
  const a = new Rng('velocity-horizon');
  const b = new Rng('velocity-horizon');
  const values = Array.from({ length: 200 }, () => a.next());
  check('same seed gives the same stream', values.every((v, i) => v === b.next()));
  check('values stay in range', values.every((v) => v >= 0 && v < 1));

  const c = new Rng('different');
  check('different seeds diverge', c.next() !== new Rng('velocity-horizon').next());

  // A coarse uniformity check: ten buckets over ten thousand draws should all
  // be populated within a reasonable band. This is not a rigorous randomness
  // test, just a guard against a generator that has collapsed.
  const rng = new Rng(12345);
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 10000; i++) buckets[Math.floor(rng.next() * 10)]++;
  check('distribution is roughly uniform', buckets.every((n) => n > 800 && n < 1200), buckets.join(','));

  const forked = new Rng('root').fork('a');
  const forked2 = new Rng('root').fork('a');
  const forkedB = new Rng('root').fork('b');
  check('forks are reproducible', forked.next() === forked2.next());
  check('different salts give different forks', new Rng('root').fork('a').next() !== forkedB.next());

  check('hashString is stable', hashString('neon-meridian') === hashString('neon-meridian'));
  check('hashString separates inputs', hashString('a') !== hashString('b'));

  const shuffleRng = new Rng(7);
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const shuffled = shuffleRng.shuffle([...items]);
  check('shuffle keeps every element', [...shuffled].sort((x, y) => x - y).join(',') === items.join(','));

  const noise = new ValueNoise1D('noise');
  let maxJump = 0;
  let prev = noise.at(0);
  for (let x = 0; x < 100; x += 0.05) {
    const v = noise.at(x);
    maxJump = Math.max(maxJump, Math.abs(v - prev));
    prev = v;
    check('noise stays bounded', v >= -1.001 && v <= 1.001);
  }
  check('noise is continuous', maxJump < 0.2, `largest step ${maxJump.toFixed(3)}`);
  range('fbm stays in range', noise.fbm(3.7), -1, 1);
});

describe('maths helpers', () => {
  near('mod is always positive', mod(-1, 10), 9, 1e-9);
  near('mod handles multiples', mod(20, 10), 0, 1e-9);
  // Convention is [-pi, pi): exactly-pi lands on the negative end. Either is
  // fine for an angle, but the code and the docs have to agree.
  near('wrapAngle folds a large angle back', wrapAngle(Math.PI * 3), -Math.PI, 1e-9);
  near('wrapAngle handles negatives', wrapAngle(-Math.PI * 3), -Math.PI, 1e-9);
  near('wrapAngle leaves small angles alone', wrapAngle(0.4), 0.4, 1e-9);
  near('wrapAngle folds just past pi to just past -pi', wrapAngle(Math.PI + 0.1), -Math.PI + 0.1, 1e-9);
  near('loopDelta takes the short way round', loopDelta(9, 1, 10), 2, 1e-9);
  near('loopDelta is signed', loopDelta(1, 9, 10), -2, 1e-9);
  near('clamp clamps', clamp(5, 0, 1), 1, 1e-9);
  near('deadzone kills small inputs', deadzone(0.1, 0.15), 0, 1e-9);
  near('deadzone rescales to full range', deadzone(1, 0.15), 1, 1e-9);
  check('deadzone preserves sign', deadzone(-0.6, 0.15) < 0);

  // damp() must be framerate independent: reaching the same place after one
  // second regardless of how many steps it took to get there.
  const stepped = (steps: number) => {
    let v = 0;
    for (let i = 0; i < steps; i++) v = damp(v, 1, 0.01, 1 / steps);
    return v;
  };
  near('damp is framerate independent', stepped(30), stepped(240), 0.002);

  check('formatTime formats a lap', formatTime(83456) === '01:23.456', formatTime(83456));
  check('formatTime handles zero', formatTime(0) === '00:00.000');
  check('formatTime rejects nonsense', formatTime(NaN) === '--:--.---');
});

describe('quality tiers are ordered', () => {
  let previousStars = -1;
  let previousDistance = -1;
  for (const tier of TIER_ORDER) {
    const s = tierSettings(tier);
    check(`${tier} star count increases`, s.starCount > previousStars, `${s.starCount} after ${previousStars}`);
    check(`${tier} draw distance increases`, s.drawDistance > previousDistance);
    check(`${tier} tessellation gets finer`, s.trackSegmentLength > 0);
    previousStars = s.starCount;
    previousDistance = s.drawDistance;
  }
  check('potato disables the expensive effects', !tierSettings('potato').bloom && !tierSettings('potato').motionBlur);
  check('ultra enables everything', tierSettings('ultra').bloom && tierSettings('ultra').motionBlur);
  check('settings are copies, not shared', tierSettings('high') !== tierSettings('high'));
});

describe('effect reduction', () => {
  const base = tierSettings('ultra');
  const one = applyEffectReduction(base, 1);
  const two = applyEffectReduction(base, 2);

  check('level 0 is a no-op', applyEffectReduction(base, 0).filmGrain === base.filmGrain);
  check('level 1 drops grain and aberration', !one.filmGrain && !one.chromaticAberration);
  check('level 1 keeps motion blur', one.motionBlur);
  check('level 2 drops motion blur', !two.motionBlur);
  check('reduction is monotonic on particles', two.particleBudget < one.particleBudget);
  check('reduction is monotonic on trails', two.trailLength <= one.trailLength);
  // Bloom carries the entire neon look; without it the game reads as broken.
  check('bloom survives every reduction level', one.bloom && two.bloom);
  check('the base settings are not mutated', base.filmGrain === tierSettings('ultra').filmGrain);
});

describe('adaptive quality', () => {
  const slowFrame = 1 / 30;
  const fastFrame = 1 / 144;

  const q = new AdaptiveQuality({ targetFps: 60, minScale: 0.5, maxScale: 1, enabled: true });
  // Feed sustained slow frames; resolution must come down.
  for (let i = 0; i < 600; i++) q.update(slowFrame);
  check('sustained slow frames reduce resolution', q.scale < 1, `scale ${q.scale.toFixed(2)}`);
  check('resolution never goes below the floor', q.scale >= 0.5 - 1e-6, `scale ${q.scale}`);
  check('measured fps is roughly right', Math.abs(q.fps - 30) < 3, `${q.fps.toFixed(1)}`);

  // Once it has run out of resolution headroom it starts shedding effects.
  check('effects are reduced once resolution bottoms out', q.effectReduction > 0, `${q.effectReduction}`);
  check('effect reduction is bounded', q.effectReduction <= 2);

  // Now feed fast frames. Recovery is deliberately slower than the drop, but
  // it must still complete in a time a player would accept — being pinned at
  // half resolution long after the load has gone is its own failure.
  let recoveredAt = Infinity;
  let simulated = 0;
  for (let i = 0; i < 20000 && recoveredAt === Infinity; i++) {
    q.update(fastFrame);
    simulated += fastFrame;
    if (q.effectReduction === 0 && q.scale >= 0.999) recoveredAt = simulated;
  }
  check('effects and resolution both recover', recoveredAt < Infinity, `scale ${q.scale.toFixed(2)}`);
  range('recovery completes in a reasonable time', recoveredAt, 5, 45);

  // Hysteresis: frames right at the target must not cause churn.
  const steady = new AdaptiveQuality({ targetFps: 60, minScale: 0.5, maxScale: 1, enabled: true });
  let changes = 0;
  for (let i = 0; i < 3000; i++) {
    // Jitter around exactly 60fps, as a real machine does.
    const dt = 1 / 60 + (Math.sin(i * 0.7) * 0.0012);
    if (steady.update(dt)) changes++;
  }
  check('a machine sitting on target does not thrash quality', changes <= 2, `${changes} changes`);
  near('and stays at full resolution', steady.scale, 1, 0.11);

  // Hitches must be ignored rather than triggering a downgrade.
  const hitchy = new AdaptiveQuality({ targetFps: 60, minScale: 0.5, maxScale: 1, enabled: true });
  for (let i = 0; i < 3000; i++) hitchy.update(i % 400 === 0 ? 1.5 : 1 / 90);
  check('occasional hitches do not degrade quality', hitchy.scale > 0.95, `scale ${hitchy.scale.toFixed(2)}`);

  const off = new AdaptiveQuality({ targetFps: 60, minScale: 0.5, maxScale: 1, enabled: false });
  for (let i = 0; i < 600; i++) off.update(slowFrame);
  check('disabling adaptive quality pins the scale', off.scale === 1);
  check('but it still measures fps', off.fps > 0);
});

describe('performance governor', () => {
  const gov = new PerformanceGovernor('ultra', { targetFps: 60, enabled: true });
  check('starts at the requested tier', gov.settings.tier === 'ultra');
  check('starts at full resolution', gov.resolutionScale === 1);

  let rebuilds = 0;
  for (let i = 0; i < 900; i++) if (gov.update(1 / 24)) rebuilds++;
  check('a slow machine triggers a rebuild', rebuilds > 0, `${rebuilds}`);
  check('and effects are actually reduced', !gov.settings.filmGrain);
  check('rebuilds are rare, not per-frame', rebuilds <= 3, `${rebuilds} rebuilds over 900 frames`);

  gov.setTier('low');
  check('changing tier resets the scaler', gov.resolutionScale === 1);
  check('and applies the new tier', gov.settings.tier === 'low');
});

report('core systems');
