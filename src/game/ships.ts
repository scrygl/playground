/**
 * The ship roster.
 *
 * Handling numbers are in real units so they can be reasoned about rather than
 * tuned blindly: thrust in m/s², speeds in m/s, rates in rad/s. The spread
 * between craft is deliberately wide — a player who cannot get on with one
 * should find another that suits them, and the elite craft should genuinely
 * punish sloppy inputs rather than just being better.
 */

export interface ShipStats {
  /** Forward acceleration at full throttle, m/s². */
  thrust: number;
  /** Terminal speed under thrust alone, m/s. */
  topSpeed: number;
  /** Deceleration under full brake, m/s². */
  brake: number;
  /**
   * Rate at which sideslip is scrubbed off, 1/s. High grip corners on rails;
   * low grip slides and needs the airbrakes to rotate the craft.
   */
  grip: number;
  /** Peak yaw rate from the steering axis, rad/s. */
  turnRate: number;
  /** Extra yaw rate from a fully-held airbrake, rad/s. */
  airbrakeYaw: number;
  /** Speed scrubbed by a fully-held airbrake, m/s². */
  airbrakeDrag: number;
  /** Total shield energy. Doubles as the boost reservoir. */
  shield: number;
  /** Shield regained per second while not taking damage. */
  shieldRegen: number;
  /** Speed multiplier at full boost. */
  boostPower: number;
  /** Shield burned per second of manual boost. */
  boostDrain: number;
  /** Mass in tonnes — decides who wins a side-to-side collision. */
  mass: number;
  /** Multiplier on damage taken from walls and weapons. */
  fragility: number;
  /** Pitch authority while airborne, rad/s. */
  pitchRate: number;
  /** Bonus multiplier applied to rhythm-gate rewards. */
  grooveBonus: number;
}

export interface ShipDefinition {
  id: string;
  name: string;
  manufacturer: string;
  /** One line of character, shown in the garage. */
  blurb: string;
  stats: ShipStats;
  /** Hull and engine colours, used by the procedural model. */
  colors: { hull: number; trim: number; engine: number };
  /** Unlock cost in credits. Zero means available from the start. */
  cost: number;
}

export const SHIPS: ShipDefinition[] = [
  {
    id: 'kestrel',
    name: 'Kestrel',
    manufacturer: 'Meridian Dynamics',
    blurb: 'Forgiving, quick to trust, and fast enough to win. Start here.',
    cost: 0,
    colors: { hull: 0x2e4a7a, trim: 0x35e0ff, engine: 0x62f0ff },
    stats: {
      thrust: 30,
      topSpeed: 152,
      brake: 42,
      grip: 5.2,
      turnRate: 1.5,
      airbrakeYaw: 1.5,
      airbrakeDrag: 26,
      shield: 100,
      shieldRegen: 2.6,
      boostPower: 1.34,
      boostDrain: 20,
      mass: 1,
      fragility: 1,
      pitchRate: 1.7,
      grooveBonus: 1,
    },
  },
  {
    id: 'vyper',
    name: 'Vyper',
    manufacturer: 'Kessler Aeronautics',
    blurb: 'The highest top speed on the grid, and it will not help you corner.',
    cost: 3500,
    colors: { hull: 0x7a1f2e, trim: 0xff2d55, engine: 0xff6b3d },
    stats: {
      thrust: 33,
      topSpeed: 174,
      brake: 38,
      grip: 3.9,
      turnRate: 1.32,
      airbrakeYaw: 1.42,
      airbrakeDrag: 23,
      shield: 82,
      shieldRegen: 2.2,
      boostPower: 1.4,
      boostDrain: 22,
      mass: 0.95,
      fragility: 1.2,
      pitchRate: 1.8,
      grooveBonus: 1,
    },
  },
  {
    id: 'anvil',
    name: 'Anvil',
    manufacturer: 'Vollmer Heavy',
    blurb: 'Slow to wind up, impossible to move, and it does not care about walls.',
    cost: 3500,
    colors: { hull: 0x4a4033, trim: 0xff8a1f, engine: 0xffb547 },
    stats: {
      thrust: 24,
      topSpeed: 148,
      brake: 50,
      grip: 6.1,
      turnRate: 1.24,
      airbrakeYaw: 1.2,
      airbrakeDrag: 32,
      shield: 155,
      shieldRegen: 3.4,
      boostPower: 1.28,
      boostDrain: 16,
      mass: 1.7,
      fragility: 0.62,
      pitchRate: 1.35,
      grooveBonus: 1,
    },
  },
  {
    id: 'wisp',
    name: 'Wisp',
    manufacturer: 'Sable Composites',
    blurb: 'Turns like nothing else on the circuit. One bad wall ends your race.',
    cost: 6000,
    colors: { hull: 0x1f5f4a, trim: 0x5cff9d, engine: 0x9dffc9 },
    stats: {
      thrust: 29,
      topSpeed: 155,
      brake: 46,
      grip: 7.4,
      turnRate: 1.78,
      airbrakeYaw: 1.95,
      airbrakeDrag: 30,
      shield: 66,
      shieldRegen: 2.9,
      boostPower: 1.33,
      boostDrain: 19,
      mass: 0.78,
      fragility: 1.5,
      pitchRate: 2.1,
      grooveBonus: 1,
    },
  },
  {
    id: 'halcyon',
    name: 'Halcyon',
    manufacturer: 'Auralis Werke',
    blurb: 'Tuned to the circuit itself. Hit the gates on the beat and it never stops accelerating.',
    cost: 8000,
    colors: { hull: 0x3a2a6a, trim: 0xa855f7, engine: 0xd8a5ff },
    stats: {
      thrust: 28,
      topSpeed: 158,
      brake: 44,
      grip: 5.6,
      turnRate: 1.52,
      airbrakeYaw: 1.55,
      airbrakeDrag: 26,
      shield: 96,
      shieldRegen: 4.6,
      boostPower: 1.36,
      boostDrain: 14,
      mass: 1,
      fragility: 1.05,
      pitchRate: 1.75,
      grooveBonus: 1.7,
    },
  },
  {
    id: 'zenith',
    name: 'Zenith',
    manufacturer: 'Classified',
    blurb: 'Everything turned up, nothing forgiven. Earn it.',
    cost: 18000,
    colors: { hull: 0x0d0d12, trim: 0xff1f3d, engine: 0xffffff },
    stats: {
      thrust: 34,
      topSpeed: 172,
      brake: 50,
      grip: 6.8,
      turnRate: 1.72,
      airbrakeYaw: 1.9,
      airbrakeDrag: 30,
      shield: 88,
      shieldRegen: 3,
      boostPower: 1.42,
      boostDrain: 18,
      mass: 0.92,
      fragility: 1.32,
      pitchRate: 2,
      grooveBonus: 1.2,
    },
  },
];

export const SHIPS_BY_ID = new Map(SHIPS.map((s) => [s.id, s]));

export function getShip(id: string): ShipDefinition {
  const s = SHIPS_BY_ID.get(id);
  if (!s) throw new Error(`Unknown ship: ${id}`);
  return s;
}

/**
 * Normalises a stat into the 0..1 bars the garage displays.
 *
 * The ranges are the roster's own spread with a little headroom, so the bars
 * actually differentiate the ships instead of all sitting near the middle.
 */
export const STAT_RANGES: Record<string, { label: string; min: number; max: number; from: (s: ShipStats) => number }> = {
  speed: { label: 'Top Speed', min: 140, max: 180, from: (s) => s.topSpeed },
  accel: { label: 'Acceleration', min: 22, max: 36, from: (s) => s.thrust },
  handling: { label: 'Handling', min: 1.2, max: 1.85, from: (s) => s.turnRate },
  grip: { label: 'Grip', min: 3.5, max: 7.8, from: (s) => s.grip },
  shield: { label: 'Shield', min: 60, max: 160, from: (s) => s.shield },
  // Fragility is inverted: a tough hull should show a long bar, not a short one.
  armour: { label: 'Armour', min: 0, max: 1, from: (s) => 1 - (s.fragility - 0.6) / 1.0 },
};

export function statBars(stats: ShipStats): { key: string; label: string; value: number }[] {
  return Object.entries(STAT_RANGES).map(([key, range]) => ({
    key,
    label: range.label,
    value: Math.max(0, Math.min(1, (range.from(stats) - range.min) / (range.max - range.min))),
  }));
}
