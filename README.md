# Chill Valley — 3D Open-World Base

A chill, move-around, procedurally generated 3D playground. No login — anyone can load it.

**Scope:** first-person chill open world — **infinite** procedurally generated
grassland (rolling hills, FluffyGrass wind-swept full-body grass that bends
around you), scattered flowers + flat rocks, lakes + a winding river, and a
day/night cycle synced to your local clock — with a click-to-scrub time
switcher. Movement, jump, and proper cross-legged sitting — on the ground
**and** on flat rocks, a fallen log, tree stumps, and a wooden crate.
Pixar-style procedural character (big head, cat ears, tail, squash & stretch)
— no external assets, stays offline + tiny. Press `V` for third person.

## Third-party assets (MIT — credit required)

Grass uses **FluffyGrass** — *"The Fluffy Grass From Elysium"* by **thebenezer**,
MIT-licensed: https://github.com/thebenezer/FluffyGrass
Vendored: `src/fluffy.ts` (adapted — player-bend patch) + `public/grassLODs.glb`,
`public/grass.jpeg`, `public/perlinnoise.webp`, `public/LICENSE.txt`.
Nothing else external: terrain, water, rocks, flowers, and character are
procedural.

## Character asset shortlist (open, CC0 — pick one and I'll swap it in)

| Pack | Look | Animations | Form |
|---|---|---|---|
| **Quaternius — Universal Base Characters** | realistic humanoid, humanoid-rigged | compatible with Universal Animation Library | FBX + glTF |
| **Quaternius — Ultimate Animated Character Pack** | blocky, 50+ characters | idle/walk/run/jump baked | FBX/OBJ/Blend |
| **Kenney — Mini Characters** | chibi blocky (closest to our current cat-ish vibe) | walk/idle | FBX/glTF |

Links: https://quaternius.com/packs/universalbasecharacters.html ·
https://quaternius.com/packs/ultimatedanimatedcharacter.html ·
https://kenney.nl/assets/mini-characters

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static bundle in dist/ — drop on any static host
npm run preview  # preview the production build
```

## Controls

| Input | Action |
|---|---|
| `W A S D` / arrows | Move (camera-relative, includes left/right strafe) |
| `Space` | Jump |
| `C` (or `X`/`E`) | Sit cross-legged / stand — walks onto nearby surface when prompted |
| `V` | First person ⇄ third person |
| `T` | Time speed 1× (real time) → 60× → 240× preview |
| Click clock | Switch time of day (scrub slider + Dawn/Noon/Dusk/Night presets) |
| `[` / `]` | Nudge time ±1h |
| Drag mouse | Look (FP) / orbit (TP), wheel to zoom (TP) |
| Touch | Left joystick + Jump / Sit buttons, drag to orbit |

Walk to a rock / log / stump / crate and press `C` to climb up and sit on it.
While sitting, movement is locked (proper meditation pose) — press `C` to stand.

## How it's optimized (principle #1)

- **Stack:** Vite + TypeScript + Three.js only — no React / R3F / physics engine
  payload. Single small static bundle, instant load, zero assets fetched.
- **Fixed-step physics (60 Hz accumulator), decoupled render** — deterministic
  movement, no spiral of death on hitches, clamped `dt`.
- **Zero allocation in the hot loop** — preallocated vectors, dust particle
  pool (90 max), no `new` per frame, no GC pauses.
- **Adaptive resolution** — caps pixel ratio and steps down under load,
  restores with headroom. Stencil buffer disabled, `powerPreference: high-performance`.
- **Few draw calls** — merged ground (1), instanced rocks + stumps, shared
  materials, **no textures** (vertex colors + procedural shader sky).
- **One 1024 shadow map**, texel-snapped frustum that follows the player
  (no shimmer), fog culls the horizon, paused when the tab is hidden.
- **Procedural world** — seeded value-noise heightfield + deterministic
  placement (same valley every load, ready for infinite-chunk extension).
- Walk cycle is driven by **distance travelled**, not time — feet never slide.

## Project layout

```
src/main.ts       boot + fixed-step loop + HUD
src/world.ts      scene, lights, sky, shadows
src/terrain.ts    seeded noise, ground mesh, sittable surfaces
src/character.ts  procedural rig + cross-legged sit pose
src/player.ts     movement / jump / sit state machine
src/input.ts      keyboard + touch joystick/buttons
src/camera.ts     third-person orbit follow rig
src/fx.ts         pooled dust particles
src/quality.ts    adaptive pixel-ratio governor
```

## Next steps (tell me what to add)

Terrain chunking for a truly endless map, trees/rocks/campfire scatter,
water, day-night cycle, sound, idle animations, or multiplayer — say the word.
