# Heatline

A 2D momentum game. You are a ball on a glowing rail: build speed, hold the line
through loops, and take to the air when the rail runs out.

Open `index.html` in a browser. No build step, no dependencies, no network — one
self-contained file.

## Controls

| | |
|---|---|
| `←` `→` | roll · brake |
| `space` | jump — **hold it in the air to fly** |
| `↓` | tuck on the ground · dive in the air |
| `shift` | burn the boost |
| `R` / `P` / `M` | restart · pause · mute |

Touch devices get on-screen thumb pads.

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
only accepts surfaces approached from the normal side and moving inward.

Two supporting rules keep it playable:

- **Slip.** A slow ball on a steep face loses control for 0.8s. Without the
  lock-out, brake force exceeds gravity along the slope, so a player holding
  "forward" gets re-caught the instant they start sliding and hangs motionless on
  the loop wall forever.
- **Sticky forward.** "Right" is re-read from the rail only while the rail is
  floor-like. Through the top of a loop you travel leftward in world space, and a
  naive mapping turns the player's `→` into a hard brake mid-loop.

Physics runs on a fixed 1/240s step so nothing tunnels at 2000+ px/s.

## Visual system

The palette is derived from the mechanic rather than picked: the world is cold
ink-teal, and **the rail heats with your speed** — teal at rest, gold at cruise,
ember flat out. It's implemented as a radial gradient anchored on the ball and
used as the rail's `strokeStyle`, so the track runs molten around you and cools
with distance. The speed read-out, ball corona, particles and trail all sample
the same ramp, so one colour language carries velocity everywhere.

Static backdrop layers (sky, sun, vignette) are baked to offscreen canvases on
resize; the rail is pre-split into Path2D tiles with bounding boxes and only
visible tiles are stroked.

## Course

Four acts, ~44,000px, about 30 seconds at pace: rolling opener into the first
loop, a gauntlet of back-to-back loops, a kicker bowl, a momentum-gated climb and
a big loop, then a chasm too wide for any jump — the only way across is flight.

Missing a gap respawns you at a rolling checkpoint; failing a loop slides you
back out to try again. There's no way to get permanently stuck.
