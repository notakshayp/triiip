# Chill Valley — architecture one-pager

_As of 2026-11-08._

Chill Valley is a static browser game: TypeScript + Three.js (WebGL2), bundled by Vite, with no server. The world is infinite and generated on the fly from seeded noise; nearly every visual asset is generated in code at load time.

## Software

| Layer | What we use |
| --- | --- |
| Language | TypeScript (strict), compiled + bundled by Vite → one static JS bundle (~707 KB, 186 KB gzip) |
| Rendering | Three.js `WebGLRenderer` (WebGL2), PCF soft shadows (one 1536² sun shadow map following the player) |
| Post-processing | `EffectComposer`: render → half-res `UnrealBloomPass` → custom anime pass (ink outlines, posterise, ground haze, sun rays) → `OutputPass` (ACES tone map) |
| Shading | Toon materials (3-step gradient + rim light), custom shaders patched in via `onBeforeCompile` for grass, foliage, flowers, far LOD |
| Sky | Custom sky dome with ray-marched volumetric clouds (14 steps through a baked 64³ noise texture), drawn last at the far plane |
| Audio | Web Audio API: real footstep samples + synthesised wind, rustle, rain, crickets, splash |
| Game loop | Fixed 60 Hz physics, decoupled render, adaptive resolution (0.6×–2× pixel ratio) to hold 60 fps |

## Packages and licenses

| Package | Version | Role | License |
| --- | --- | --- | --- |
| three | 0.170.0 | Renderer, math, loaders, post-processing | MIT |
| vite | 6.4.5 | Dev server + bundler (build time only) | MIT |
| typescript | 5.9.3 | Type checking (build time only) | Apache-2.0 |
| playwright | 1.65.0 | Headless screenshots for QA (dev only, not shipped) | Apache-2.0 |
| @types/three, @types/node | 0.170.0, 22.20.5 | Type definitions (dev only) | MIT |

Third-party assets shipped in `public/`:

| Asset | Source | License |
| --- | --- | --- |
| Grass blade mesh + textures (`grassLODs.glb`, `grass.jpeg`, `perlinnoise.webp`) | FluffyGrass by thebenezer (adapted shader in `src/fluffy.ts`) | MIT (`public/LICENSE.txt`) |
| Log + 3 tree stumps at spawn (`public/kenney/`) | Kenney Nature Kit | CC0 |
| Grass footstep sounds (`public/sfx/`) | Kenney Impact Sounds | CC0 |
| Water normal map, lens-flare sprites | three.js examples | MIT |

## Procedural generation

Everything derives from one seed (`WORLD_SEED = 2026`), so the same world appears every load. Terrain is a pure function `groundHeight(x, z)` of six noise fields:

1. **Continentalness** (very low frequency) sets land vs sea via a height spline: abyss → shelf → beach → inland → plateau.
2. **Erosion** sets how hilly land is (up to ±7.5 m relief) vs flat plains.
3. **Weirdness → peaks/valleys** raises mountains inland only (up to +34 m).
4. A sine-winding **river** is carved east of spawn.
5. **Moisture** and **temperature** (temperature falls with altitude) pick the biome.

Streaming:

- **Chunks** are 48 m squares. A 7×7 ring around the player is kept loaded (unloaded at 9×9). Builds run nearest-first within a 4 ms per-frame budget, so streaming never spikes a frame.
- Each chunk has a **static layer** (terrain mesh, trunks, rocks, cacti, leaf canopies — 3 draw calls) built once, and a **detail layer** (grass + flowers) rebuilt at the right density as the chunk moves between distance tiers (2300 → 1000 → 450 → 220 grass clumps).
- **Far LOD** covers the horizon to ~1 km: a 12 m-resolution terrain grid plus billboard impostor trees rendered at boot from the real tree models. It rebuilds in the background (time-sliced) when the player moves 128 m.
- **Weather** cycles clear / overcast / rain on random real-time intervals; it drives cloud cover, fog distance, sun intensity and rain audio.

## Biomes

Rules are checked top to bottom; the first match wins. `h` = ground height (water level is −0.22 m), `c` = continentalness, `m` = moisture, `t` = temperature, `slope` = terrain gradient.

| Biome | Condition | What grows there |
| --- | --- | --- |
| Ocean | underwater and `c < 0.5` (part of the open sea) | nothing; depth-graded seabed |
| Lake | underwater and `c ≥ 0.5` (inland depression) | nothing; depth-graded lakebed |
| Beach | `h < 0.48 m` and (`c < 0.505` or within 4.5 m of the river) | pebbles |
| Rock | `slope > 0.85`, or mountain mass `> 0.3` with `h > 5 m` | bare stone, snow-pale above 18 m |
| Clearing (cold) | `t < 0.34` | sparse short grass, lone conifers |
| Desert | `m < 0.2` and `t > 0.56` | sand dunes, cacti, boulders |
| Forest | `m > 0.62`, `t > 0.42`, `slope < 0.55` | 9–14 mixed trees per chunk, bushes |
| Tallgrass | `m > 0.5` and `t > 0.5` | waist-high grass, wildflowers |
| Clearing (dry) | `m < 0.36` | sparse short grass, lone conifers |
| Meadow | everything else | knee-high grass, wildflowers, lone giant trees |

## Models

All procedural (generated in `src/` at load, no downloads):

| Model | File | Notes |
| --- | --- | --- |
| Player character | `adventurer.ts` | Chibi traveller, toon-shaded, procedural walk / jump / sit animation |
| Trees (broadleaf, poplar, conifer) | `foliage.ts` | 10 variants; leaf-card canopies with spherical normals for soft painterly shading |
| Bushes, wildflowers | `foliage.ts` | 4 bush and 6 flower variants; bend on contact via the footstep trail |
| Boulders, pebbles | `foliage.ts` | Pools of 10 + 8 smooth mossy rocks |
| Cacti | `chunks.ts` | Saguaro trunk + arms |
| Terrain, sky, clouds, far impostors | `chunks.ts`, `sky.ts`, `farlod.ts` | — |

Downloaded: only the grass blade mesh, the spawn log/stumps and the sounds listed above.

Unused files still in `public/` (safe to delete): `rogue.glb` (3.6 MB, the old KayKit character), `grass-ground.jpg`, `grass-normal.jpg`, and the Kenney rock/tree/bush/flower GLBs in `public/kenney/`.
