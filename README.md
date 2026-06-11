# MYTHOS // Facility Raid

A high-performance FPS that runs entirely in the browser. Built with Three.js, TypeScript and Vite — no assets to download, everything (geometry, sounds, effects) is generated procedurally at runtime. Infiltrate the facility, find the keycard, steal the reactor core and fight your way out through the garden gate — while waves of patrolling robots garrison every room.

## Run

```bash
npm install
npm run dev
```

Then open the printed URL (default http://localhost:5173) and click **Engage**.

## Controls

| Input | Action |
| --- | --- |
| WASD | Move |
| Mouse | Look / shoot (hold for auto weapons) |
| Shift | Sprint |
| Space | Jump |
| R | Reload |
| 1 / 2 / 3 | Pulse Rifle / Scattergun / Viper SMG |
| Esc | Pause (release pointer lock) |

## Gameplay

### The heist

A three-beat objective chain drives the run (tracked in the HUD):

1. **Find the keycard** in the supply depot — the reactor control room is locked (red status lamps over its doors) until you do.
2. **Extract the core cell** from the reactor room. Pulling it trips the **facility alarm**: red emergency lighting, a pulsing alert vignette, and every robot in the building converging on you.
3. **Reach the extraction gate** in the south garden — it unlocks with the alarm and its beacon strobes to guide you out.

Waves keep garrisoning the facility the whole time; surviving to the gate ends the run with a victory tally.

### The facility

Eight connected zones, each with its own look, lighting and door color code:

- the central **hall** with platforms, pillars and crate cover
- the amber **depot** (NE) stacked with crate towers — keycard here
- the green **reactor** room (SW) around a glowing core column — locked until you find the keycard
- the open-air **yard** (N) under a starfield
- an **east corridor** with a gallery deck on a second level, reached by a staircase
- a magenta-lit **hydroponics** bay with planter troughs, grow lights and a humming water tank
- a cold-blue **archive** full of server racks, lit by a failing, flickering tube
- a south **garden**: open sky, soil and stepping stones, trees, shrubs, rocks and warm lantern posts — and the extraction gate

Doors are **proximity-triggered sliding doors** with recessed panels, viewport slits, kick plates and a status lamp (green = unlocked, red = locked). Closed doors block movement, bullets, enemy sight *and* hearing. Robot navigation routes through multi-hop door paths (corridor → room → hall) using a precomputed zone graph.

### The robots

Three enemy types (procedurally built and rigged — walk cycles, attack swings, glowing cores):

- **Stalker** — fast slim melee swarmer
- **Sentinel** — keeps distance, strafes, fires from an arm cannon
- **Brute** — big, slow, hits hard (wave 4+)

Every spawned robot is **assigned a zone to garrison** and patrols only there until it actually discovers you — sneaking past a room leaves its guards undisturbed. Robots run a four-state awareness model: **patrol → suspicious → hunt → search**. They patrol unaware until an *awareness meter* fills — sight (frontal vision cone + line of sight, faster up close), hearing you nearby, getting shot, gunfire within earshot, or intel from a squadmate with live contact. **No sense works through walls**: vision, hearing, gunfire and squad radio all require a clear line — a muffled gunshot through a wall only makes a nearby robot suspicious enough to investigate. A glimpse makes them *suspicious*; full awareness sends them hunting after a brief reaction pause. Lose them and they converge on your **last known position**, sweep the room it's in, then give up and garrison wherever the hunt ended. In melee, an **attack-token system** caps how many can press the attack at once — the rest circle you in a wider ring and step in when a slot frees up. Attackers **commit to their strikes**: they plant their feet, square up and lunge through the swing. Health regenerates slowly out of combat.

## Performance design

- **Zero per-frame allocations** in the hot path — all vectors are preallocated module-level scratch objects.
- **Custom analytic collision/raycasts** (slab-method ray vs AABB, circle vs AABB resolution) instead of a physics engine or mesh raycasting, including step-up logic and ground-height queries for stairs/platforms.
- **Doors as toggleable AABBs** — a sliding door is just an obstacle with an `enabled` flag, so open/closed state flows through the same collision, raycast and line-of-sight code for free. Enemy routing uses a tiny 8-zone door graph with precomputed next-hop tables (BFS at startup) instead of a navmesh.
- **Procedural robot rigs** — every enemy is a jointed box-part robot (shared unit-box geometry, pooled materials) animated in code; no skeletons, skinning or animation clips to load.
- **Object pooling** for enemies, projectiles, tracers, and particles — one `THREE.Points` cloud with typed arrays drives up to 2048 particles.
- **Instanced meshes** for all static level geometry (walls, crates, pillars).
- **Frozen shadow map** — the scene's shadow map is rendered once at startup (`shadowMap.autoUpdate = false`) since all shadow casters are static.
- **DOM HUD with change detection** — text/styles are only written when values change.
- **Procedural WebAudio SFX** — no audio files, no decoding, no network. Every sound is layered (sub-bass thump + driven mid + noise transient) through a master compressor and a tanh waveshaper for weight. Ambience is localized, not global: the reactor core emits a deep detuned throb and each console a faint electronic whine, through HRTF panners with real distance rolloff — you hear them swell as you approach. World-positioned sounds (servo footfalls, detection stingers, hunting growls, melee whooshes, cannon fire, wreck slams, pneumatic door hiss/thunk) play through **HRTF binaural panners** driven by the listener pose — you can hear which side (and with headphones, front or behind) a robot is coming from. Distance falloff stays hand-tuned per sound type, with global throttles so a robot crowd doesn't wash out the mix.
- **Procedural canvas textures** — floor plates, ceiling panels, wall panels, three crate liveries, barrel skins, console screens, pillars, brushed weapon metal and enemy skins are all drawn to canvases once at startup (`src/Textures.ts`); zero downloads, shared across instanced meshes and pools.
- **Aspect-correct UVs** — walls use world-scaled UVs (constant texel density) and crates use a centered cover-crop per face, so emblems and rivets stay perfectly round on any box size; round props (barrels, cable drums) get a dedicated circular lid texture for their caps.
- **Rounded set dressing** — barrel clusters, tipped barrels, flanged cable drums, holo consoles with radar screens, overhead pipe runs with collars and floor junctions; robots carry cylindrical joints, sensor dishes, exhaust stacks, antenna beacons and vents; the rifle has a round shrouded barrel, ring sights, a trigger guard torus and a live status screen.
- **Procedural flora** — bushes are merged cone clusters, trees are instanced trunks + merged icosahedron crowns, all drawn as a handful of instanced meshes; garden soil and stepping stones are canvas textures like everything else.
- **Cheap atmosphere** — per-zone accent point lights with tight ranges, one animated flicker light (archive) and one beacon (gate); the facility-wide alarm just re-tints the hemisphere light, fog and background and pulses a DOM vignette — no extra draw calls.
- Pixel ratio capped at 2, delta time clamped to keep physics stable after tab switches.

## Build

```bash
npm run build
npm run preview
```
