# Velocity Horizon

An anti-gravity racing game for the browser. WebGPU with a WebGL2 fallback, no
external assets of any kind — every circuit, sky, craft, sound effect and note
of music is generated at runtime from a seed.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle in dist/
npm test           # the whole test suite
npm run typecheck
```

---

## What it is

Eight handcrafted circuits and an endless supply of generated ones, six craft,
seven modes, and a soundtrack that the track is built around rather than played
over. The lineage is Wipeout's airbrakes, Trackmania's medals and instant
restart, Thumper's insistence that rhythm is a mechanic and not decoration,
and Rainbow Road's conviction that a guardrail is optional.

### Modes

| Mode | What it is |
| --- | --- |
| **Championship** | Three-round series scored on points. Where craft and circuits unlock. |
| **Quick Race** | One race, full grid, anything you have unlocked. |
| **Time Trial** | Empty circuit, your ghost, four medals. Instant restart. |
| **Elimination** | Last place is removed every twenty seconds. |
| **Pursuit** | Interceptors hunt you down. Finish before your shield does. |
| **Zone** | The throttle is not yours. Speed only ever goes up. |
| **Endless** | A circuit generated from a seed, running forever. Share the seed. |

### Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Throttle / Brake | `W` / `S` | `R2` / `L2` |
| Steer | `A` / `D` | Left stick |
| Airbrake left / right | `Q` / `E` | `L1` / `R1` |
| Boost | `Space` | `✕` |
| Pitch (airborne) | `I` / `K` | Left stick Y |
| Look back | `C` | Right stick click |
| Change camera view | `V` | `▢` |
| Restart | `R` | Back / Share |
| Pause | `Esc` | Start / Options |

Everything is rebindable in Controls. Menus are fully navigable by keyboard,
gamepad, mouse and touch.

---

## How it works

The interesting decisions, and why they went that way.

### Track space is the whole trick

A track is a closed 3D curve resampled to **uniform arc length**, carrying an
orientation frame at every sample. Craft live in `(s, lateral, height)` —
distance along the centreline, offset across it, altitude above it — with a
heading measured relative to the track tangent, and **gravity pointing along the
track's own down axis** rather than the world's.

That one decision is what makes the genre work. Through a vertical loop or a
corkscrew the surface normal swings all the way round to face the world floor,
and none of the physics has to know: cornering, grip, collision, the racing
line and the camera are the same maths they were on the opening straight.
Solving it in world space would mean special-casing every inversion.

Uniform arc-length sampling means "where am I on the track" is an array index
rather than a search, which is what lets eight craft, the AI, the camera and the
HUD all work in track space every frame for free.

A craft offset from the centreline covers a different amount of centreline arc
than it travels — so the inside of a corner is genuinely shorter, and the racing
line is worth something.

### Circuits are driving instructions, not geometry

Tracks are authored as a list of segments — `straight`, `turn`, `loop`,
`corkscrew`, `helix`, `gap` — walked by a cursor that carries a full orientation
frame. A barrel roll is "advance while rolling"; a loop is "pitch through 360°".
Inversions are correct by construction.

Getting such a recipe to land exactly back on its own start point by hand is
impractical. The obvious fallback — bridging the leftover gap with a Hermite
curve — folds into a cusp when it has to span hundreds of metres, and a corner
of 4 m radius then poisons the racing line and drags the whole speed profile
down to walking pace. (It did. That is how this was found.)

With the turn angles fixed, the end position is an **exactly linear** function of
every straight length and corner radius in the recipe, so closure is a solvable
linear system rather than an optimisation. A weighted minimum-norm solve spreads
the correction thinly across the whole circuit instead of mangling one corner,
and any residual under 90 m is absorbed by a compass-rule shear over the entire
lap rather than concentrated at the seam. All eight circuits close with no bridge
at all; the tightest radius across the whole roster is 61 m.

Generated circuits go through the same pipeline, and verify the solver actually
closed them — retrying from a sub-seed if not, so a bad seed can never ship a
broken track.

### Medals derive from the track

Medal times are computed at load from each circuit's own predicted speed
profile — the time a flawless lap of the ideal line would take — times a fixed
set of skill factors, plus an explicit allowance for the standing start. Nothing
is hand-authored, so tuning a corner can never silently make gold unobtainable.

### The AI drives, it doesn't cheat

Rivals run pure pursuit against a precomputed minimum-curvature racing line,
with a separate speed controller reading the precomputed speed profile.
Difficulty scales how close they run to the physical limit, how early they
brake, and how much noise is in their inputs — not their physics. Rubber-banding
rides on the same drag term the slipstream uses, so it is bounded, invisible,
and never touches their line. A rival beating you is genuinely driving better.

Across all eight circuits the AI runs clean three-lap races 12–20% off the
theoretical ideal lap with no falls.

### Rhythm is load-bearing

The music is generated, not played back: a deterministic composer emits note
events per bar from the circuit's seed, and a lookahead scheduler places them
against the WebAudio hardware clock. Arrangement density follows the race — it
thickens as a battle develops and thins when you are cruising alone — and
transitions land on bar boundaries so it stays musical.

Beat gates are spaced by how far a craft travels in one musical beat at racing
pace, so they are hittable *in rhythm*. Passing through one is worth something;
passing through on the beat is worth much more and chains into a multiplier.
The timing window is judged against a **latency-compensated** beat clock, so it
reflects what the player actually heard rather than when the note was queued.

### Ghosts store transforms, not inputs

Replaying inputs would be a fraction of the size but demands a bit-identical
simulation forever — one tuning change to grip and every stored ghost drives
into a wall. Transforms cost a few kilobytes and cannot rot. They are stored in
track space, so they interpolate correctly through loops.

### It runs on what you have

Capabilities are detected once at boot and a quality tier is chosen, then
continuously corrected from measured frame time. Resolution scales first because
it is continuous and reversible; effects are only shed after resolution runs out
of headroom, in order of how much they are missed. Bloom is never dropped —
without it the neon stops reading as neon and the game looks broken rather than
cheaper. The controller falls faster than it climbs, ignores one-off hitches,
and provably does not thrash on a machine sitting exactly on target.

Simulation runs on a fixed 120 Hz step decoupled from rendering, so the same
corner behaves identically at 30 and 144 fps and lap records mean something.

---

## Layout

```
src/
  core/      seeded RNG, maths, quality tiers and the adaptive governor
  track/     spline, orientation frames, closure solver, circuits, generator
  game/      vehicle physics, AI driver, race director, ghosts, profile, world
  render/    renderer and post chain, track mesh, craft, particles, camera
  audio/     music theory, composer, synthesis, SFX
  ui/        screens, HUD, navigation
tests/       ~13k assertions, runnable in Node with no browser
tools/       esbuild test runner, headless capture harness
```

The simulation has no dependency on the renderer or the DOM, which is why the
physics, the race director, the track maths, the music theory and the quality
controller are all testable in plain Node.

---

## Testing

```bash
npm test                                  # everything
node tools/run-test.mjs tests/race.test.ts   # one suite
```

Suites cover track geometry and closure, the circuit roster, vehicle physics,
the race director and all modes, core systems, procedural audio, environment
generation and rendering primitives.

Anything visual is verified by rendering it. `tools/shot.mjs` boots the built
game in headless Chromium, drives it with a scripted step list, and writes
screenshots and the page console:

```bash
npx vite build
node tools/shot.mjs --root dist --out shots/ --steps steps.json \
  --query "gpu=webgl&tier=low&autopilot=1" --width 1280 --height 720
```

Headless Chromium cannot composite a WebGPU canvas into a screenshot, so the
harness drives the WebGL2 fallback by default. Because every material is written
in TSL, both backends run the same shader graph — which means the capture path
continuously validates the fallback as a side effect.

Useful query parameters: `gpu=webgl` forces the fallback, `tier=` pins a quality
tier, `autopilot=1` hands the player's craft to the AI.

---

## Browser support

Needs WebGPU or WebGL2. Recent Chrome, Edge, Firefox and Safari all qualify.
WebGPU is preferred automatically where available; the fallback is not a reduced
experience, just a slower one.
