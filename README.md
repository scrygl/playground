# Heatline

Five courses of momentum. You are a ball on a glowing rail: build speed, hold the
line through loops, and take to the air when the rail runs out.

Open `index.html` in a browser. No build step, no dependencies, no network — one
self-contained file.

## Controls

| | |
|---|---|
| `←` `→` | roll · brake |
| `space` | jump — **hold it in the air to fly** |
| `↓` | tuck on the ground · dive in the air |
| `shift` | burn the boost |
| `R` · `P` · `C` · `M` | restart · pause · courses · mute |

Touch devices get on-screen thumb pads.

## Courses

| # | Course | Length | Gold | Introduces |
|---|---|---|---|---|
| 1 | First Light | 12.6k | 7s | rolling, two loops |
| 2 | Kicker Bowl | 17.7k | 9s | the kicker bowl, washboards, a jump gap |
| 3 | The Chasm | 26.6k | 16s | three spans that only flight crosses |
| 4 | Gauntlet | 32.2k | 16s | back-to-back loops, a momentum-gated climb |
| 5 | Overdrive | 42.4k | 26s | all of it, at pace |

Clear a course to open the next. Gold demands the boost — a clean roll-through
lands around silver. Best times, ring counts and medals persist in
`localStorage`. Each course has its own sky, because the sun is the light source
the whole palette is borrowed from: moving and recolouring it is what actually
changes the mood.

## How it works

The interesting part is the ground model. While the ball is attached to the rail
it isn't simulated as a free body with collision response — it's parameterised by
**arc length**: a distance `s` along a continuous path plus a speed `v` along it.

Two things fall out of that:

**Loops are free.** A self-intersecting path is not ambiguous when position is a
distance along it, so a loop needs no special case, no layer swapping, and no
scripted section. The rail is just a path that happens to cross itself.

**Detachment is physical.** The ball stays on the rail exactly while the normal
force is non-negative:

```
N = v²·κ − g·n̂          stay attached while N ≥ 0
```

where `κ` is the signed curvature of the rail and `n̂` its normal. Carry enough
speed into a loop and `v²·κ` beats gravity at the top and you hold. Arrive slow
and `N` goes negative somewhere on the climb and you fall off — from the same two
lines of code that make you launch off a hill crest. Nothing about "loops" or
"jumps" is special-cased anywhere.

Airborne is an ordinary projectile, re-attaching via a grid-broadphase probe that
only accepts surfaces approached from the normal side and moving inward. Physics
runs on a fixed 1/240s step so nothing tunnels at 2000+ px/s.

### The rules that make it playable

Each of these exists because a playtest found the failure it prevents:

- **Slip.** A slow ball on a steep face loses control for 0.8s. Without the
  lock-out, brake force exceeds gravity along the slope, so a player holding
  "forward" gets re-caught the instant they start sliding and hangs motionless on
  the loop wall forever.
- **Sticky forward.** "Right" is re-read from the rail only while the rail is
  floor-like. Through the top of a loop you travel leftward in world space, and a
  naive mapping turns the player's `→` into a hard brake.
- **Directional plates and kickers.** Both fire only on a forward pass. A plate
  crossed backwards used to launch the player back up the course at full plate
  speed, and a failed loop would then oscillate across it indefinitely; a kicker
  sits at the floor of a bowl, so firing on a backward pass threw you straight
  back into that bowl.
- **Plates catch you in the air.** Sailing over one off a crest silently cost you
  the next loop.
- **Chasms drop to meet you.** A long span with a level landing is unfair to a
  player who only flies on the way down; every chasm now lands ~240px lower —
  and is set past ballistic reach, so flight (or the burner) is still the only
  way over.

### Falling through the track

Reported from real play: "sometimes when the angle is just right, the ball falls
through the track."

It was not tunneling — a 1/240s step moves at most 10px against a 17px ball, and
a sweep of 1,701 clean approaches across every angle and speed found zero
failures. The cause was the grace window after leaving a surface. One timer was
doing two jobs: coyote time for jumping, *and* muting collision so the ball
doesn't instantly re-attach to the rail it just left. At 0.09–0.12s that mute is
up to 290px of blind travel at speed — far enough to cross the opposite wall of
a loop. Every reproduction sat at a loop mouth.

The fix is in two parts. The timers are split, so the collision mute is 0.03s
and coyote time keeps its own. And landing now also runs a **swept** test: as
well as asking where the ball *is*, it tests the line it just travelled against
the rail, and lands at the crossing. The point probe can be muted; the swept
probe never is. A pass-through is now impossible at any speed or angle rather
than merely unlikely.

Before: 1,475 pass-throughs out of 44,832 departures. After: zero.

## Courses are authored, not generated

Each course is written in a phrase vocabulary on top of the path builder —
`descent`, `climb`, `wash`, `bowlIn`/`bowlOut`, `loop` — and everything else is
derived from that geometry: ring layout, ballistic ring arcs sized to each gap,
the goal, the checkpoint floor, the menu's course profile, and the feature pips
on the progress rail. Adding a course means writing its line.

## Visual system

The palette is derived from the mechanic rather than picked: the world is cold
ink-teal, and **the rail heats with your speed** — teal at rest, gold at cruise,
ember flat out. It's implemented as a radial gradient anchored on the ball and
used as the rail's `strokeStyle`, so the track runs molten around you and cools
with distance. The speed read-out, ball corona, particles and trail all sample
the same ramp, so one colour language carries velocity everywhere.

Static backdrop layers (sky, sun, vignette) are baked to offscreen canvases per
course; the rail is pre-split into Path2D tiles with bounding boxes and only
visible tiles are stroked.

## Testing

Driven in headless Chromium rather than eyeballed.

The strongest check drives the physics directly at 1/240s and asserts an
invariant after **every substep**: the ball's centre must never cross a rail's
front face. It runs six play styles (roll, boost, roll-and-fly, jump-mashing,
tuck-diving, random input) across all five courses — about fifteen simulated
minutes per pass — using a crossing test written independently of the collision
solver, so it can't rubber-stamp the code it's checking. Current result: zero
breaches in 30 runs.

That same harness doubles as a design check, since it reports which styles reach
the goal. It is what caught the chasms becoming ballistically crossable: `roll`,
which never flies, was finishing The Chasm. Courses 1, 2 and 4 are clearable by
every style; 3 and 5 require flight or the burner, by design.

Alongside it: real-time runs of all five courses under two agents, five player
behaviours on Gauntlet, and an approach sweep of 1,701 angle/speed combinations.
Last run: no page errors, 60fps under software rendering. There is no way to get
permanently stuck — 25 seconds of jump-mashing stalls progress at 10%, and
running clean afterwards recovers to the end.
