# AGENTS.md

Guidance for AI agents and contributors working on MYTHOS.

## Commands

- `npm run dev` — Vite dev server.
- `npm run build` — type-check + build. `vite.config.ts` sets `base: "./"` so the build runs from any mount point; don't reintroduce absolute base paths.
- No test framework. Verify with `npx tsc --noEmit`, then in the browser (see harnesses below).

## Debug harnesses

- `?nolock` — runs without pointer lock, never pauses, and exposes the game instance as `window.__game` (player, world, mp, weapons are reachable). Use this for any scripted browser testing.
- `?touch` — forces the mobile touch UI on desktop.
- `node scripts/mp-bot.mjs <room> <name> [--shoot]` — headless arena player (15 Hz pose publisher, applies incoming damage, optionally shoots back). Default room is `arena`, the one everybody plays in.

## Architecture (src/)

- `Game.ts` — orchestrator. World and everything in it are built lazily on the menu's single/multi choice (`initWorld`). State: menu / playing / dead / won.
- `World.ts` — both maps: campaign facility and the MP arena (`arenaMode` ctor flag). AABB obstacles, custom raycast/collide; no physics engine.
- `Player.ts`, `Weapons.ts`, `Enemies.ts` — local simulation. Hitscan weapons raycast world, enemies, then remote players.
- `Net.ts` / `Multiplayer.ts` / `RemoteAvatar.ts` — gun.js layer (see below).
- `Robot.ts` (enemies) / `Human.ts` (player avatars) — procedural rigs from shared unit geometries. Part matrices are frozen at build time; animation rotates joint Groups only.
- `Touch.ts` — mobile input (floating joystick, look drag, buttons).

## Conventions and gotchas

- **Yaw convention**: camera yaw 0 looks toward **−z**; rig models are built facing **+z**. RemoteAvatar applies `state.yaw + Math.PI`. Forward = `(-sin yaw, -cos yaw)`.
- **Never add/remove lights (or change light counts) at runtime** — Three.js recompiles every shader in the scene and the game visibly hitches. Fade `intensity` to 0 instead (see pickups in `World.ts`).
- The shadow map is rendered once and frozen (`shadowMap.autoUpdate = false`); dynamic objects don't get fresh shadows by design.
- Avoid coplanar faces in procedural models — they z-fight. Offset surfaces or intersect curved shapes.
- The viewmodel renders in a second pass with cleared depth (`vmScene`), so it never clips into walls.
- Don't normalize partial-deflection input: the touch joystick is analog (`Player.update` clamps wish vectors > 1 instead).

## Multiplayer protocol (gun.js)

- Decentralized graph db; relay peer at `https://vibing.at/gun` (deploy files in `server/gun-relay/`). Every client is a peer; the relay is just a well-known rendezvous + websocket fan-out.
- Room graph: `mythos-mp/<room>/p/<peerId>` holds each player's full `PeerState` (short keys, ~15 Hz). See `Net.ts`.
- **Damage is trust-the-shooter and cumulative**: attacker writes a monotonically increasing `total` to `dmg/<victimId>/<attackerId>`. Victims apply deltas. Never write per-hit events — CRDT last-write-wins would drop them.
- Kills/deaths are self-reported counters in `PeerState` (`ks`/`kb` sequence + killer id drive the kill feed).
- Stale-state ghosts: gun replays cached states on join. `Multiplayer.update` filters by sender timestamp (`expired` map + 60 s freshness gate). Keep this in mind before "simplifying" peer handling.
- Bandwidth is dominated by gun's per-field HAM metadata (~800 B/pose on the wire). If it matters, split hot pose fields from cold meta fields rather than tuning payload values.

## Deploy

- Game: `npm run build`, then rsync `dist/` to the web root (currently `vibing.at/mythos`).
- Relay: `server/gun-relay/` runs as a systemd service on the same host, proxied by nginx at `/gun`.
