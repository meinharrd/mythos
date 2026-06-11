import * as THREE from "three";
import { Net, PeerState, PEER_TIMEOUT_MS } from "./Net";
import { RemoteAvatar } from "./RemoteAvatar";
import { Player } from "./Player";
import { World } from "./World";
import { Effects } from "./Effects";
import { AudioFX } from "./AudioFX";

const PUBLISH_INTERVAL = 1 / 15;
const AVATAR_RADIUS = 0.55;
/** Avatar body radius + local player radius: bodies can't overlap. */
const BODY_DIST = AVATAR_RADIUS + 0.45;

export interface ScoreRow {
  id: string;
  name: string;
  kills: number;
  deaths: number;
  alive: boolean;
}

/**
 * Owns the gun.js session for one arena match: publishes the local
 * player's pose, mirrors every peer as a RemoteAvatar, replicates
 * shots as tracers, and applies incoming damage to the local player.
 */
export class Multiplayer {
  readonly net: Net;
  readonly avatars = new Map<string, RemoteAvatar>();
  /** Display name; editable from the menu mid-session. */
  playerName: string;

  kills = 0;
  deaths = 0;
  private shotSeq = 0;
  private deathSeq = 0;
  private killedBy = "";
  private lastShotDir = new THREE.Vector3(0, 0, -1);
  private publishTimer = 0;
  private pendingStates = new Map<string, PeerState>();
  /** Last sender-timestamp of peers we expired; gun re-delivers cached
   * states on sync, which must not resurrect dead sessions. */
  private expired = new Map<string, number>();

  /** Fired for the kill feed: attacker name, victim name. */
  onKillFeed: (attacker: string, victim: string, attackerIsMe: boolean) => void = () => {};
  /** Fired when the local player was killed; arg is the killer's name. */
  onLocalDeath: (killerName: string) => void = () => {};

  constructor(
    room: string,
    playerName: string,
    private player: Player,
    private world: World,
    private effects: Effects,
    private audio: AudioFX,
    private envMap: THREE.Texture
  ) {
    this.playerName = playerName;
    this.net = new Net(room);

    // Buffer network callbacks; the game loop drains them so all scene
    // mutation happens at a defined point in the frame.
    this.net.onPeer = (id, state) => this.pendingStates.set(id, state);

    this.net.onDamage = (attackerId, amount) => {
      if (!this.player.alive) return;
      this.player.takeDamage(amount);
      if (!this.player.alive) {
        this.deaths++;
        this.deathSeq++;
        this.killedBy = attackerId;
        const killer = this.avatars.get(attackerId);
        this.onLocalDeath(killer?.name ?? "unknown");
        this.publish(); // broadcast the death immediately
      }
    };
  }

  /** Random spawn, biased away from living opponents. */
  pickSpawn(): [number, number, number] {
    const spawns = this.world.mpSpawns;
    let best = spawns[0];
    let bestScore = -1;
    for (const s of spawns) {
      let nearest = Infinity;
      for (const a of this.avatars.values()) {
        if (!a.alive) continue;
        nearest = Math.min(nearest, Math.hypot(a.target.x - s[0], a.target.z - s[1]));
      }
      const score = Math.min(nearest, 60) + Math.random() * 8;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  /** Called by the weapon system for every local shot. */
  localShot(dir: THREE.Vector3): void {
    this.shotSeq++;
    this.lastShotDir.copy(dir);
    this.publish();
  }

  /**
   * Capsule raycast against all living remote players. Returns the
   * nearest hit within maxDist or null.
   */
  raycastPlayers(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number
  ): { id: string; dist: number } | null {
    let bestId: string | null = null;
    let bestDist = maxDist;
    for (const [id, a] of this.avatars) {
      if (!a.alive) continue;
      const c = a.hitCenter;
      // Two sphere tests approximate the capsule: torso + head/legs.
      for (const oy of [-0.55, 0, 0.7]) {
        _c.set(c.x, c.y + oy, c.z);
        _toC.subVectors(_c, origin);
        const t = _toC.dot(dir);
        if (t < 0 || t > bestDist) continue;
        _closest.copy(origin).addScaledVector(dir, t);
        if (_closest.distanceToSquared(_c) < AVATAR_RADIUS * AVATAR_RADIUS) {
          bestDist = t;
          bestId = id;
          break;
        }
      }
    }
    return bestId !== null ? { id: bestId, dist: bestDist } : null;
  }

  dealDamage(victimId: string, amount: number): void {
    this.net.dealDamage(victimId, amount);
  }

  update(dt: number, weaponIndex: number): void {
    const now = performance.now();

    // Drain buffered peer states.
    for (const [id, state] of this.pendingStates) {
      let avatar = this.avatars.get(id);
      if (!avatar) {
        // A replayed state from a session we already timed out?
        const lastT = this.expired.get(id);
        if (lastT !== undefined && (state.t ?? 0) <= lastT) continue;
        // The relay replays long-dead sessions on join; skip anything
        // not freshly published (generous slack for clock skew).
        if (Date.now() - (state.t ?? 0) > 60_000) continue;
        avatar = new RemoteAvatar(this.world.scene, id, this.envMap);
        this.avatars.set(id, avatar);
      }
      const prevShot = avatar.shotSeq;
      const prevDeath = avatar.deathSeq;
      avatar.applyState(state, now);

      // Replicate shots: tracer + positional audio from the avatar.
      if (typeof state.s === "number" && state.s !== prevShot) {
        avatar.shotSeq = state.s;
        if (prevShot >= 0 && avatar.alive) {
          _dir.set(state.sdx, state.sdy, state.sdz);
          if (_dir.lengthSq() > 0.5) {
            const from = avatar.muzzle;
            const dist = Math.min(this.world.raycast(from, _dir, 120), 120);
            _end.copy(from).addScaledVector(_dir, dist);
            this.effects.tracer(from, _end);
            this.audio.enemyShoot(from.x, from.z);
          }
        }
      }

      // Death events drive the kill feed and the killer's own counter.
      if (typeof state.ks === "number" && state.ks !== prevDeath) {
        avatar.deathSeq = state.ks;
        if (prevDeath >= 0) {
          const killerIsMe = state.kb === this.net.id;
          const killerName = killerIsMe
            ? this.playerName
            : (this.avatars.get(state.kb)?.name ?? "unknown");
          if (killerIsMe) this.kills++;
          this.onKillFeed(killerName, avatar.name, killerIsMe);
        }
      }
    }
    this.pendingStates.clear();

    // Expire silent peers.
    for (const [id, a] of this.avatars) {
      if (now - a.lastSeen > PEER_TIMEOUT_MS) {
        this.expired.set(id, a.lastT);
        a.dispose();
        this.avatars.delete(id);
      }
    }

    for (const a of this.avatars.values()) a.update(dt);

    // Bodies are solid: push the local player out of living avatars.
    // Only the local position moves; the remote pose is authoritative.
    if (this.player.alive) {
      const p = this.player.position;
      let pushed = false;
      for (const a of this.avatars.values()) {
        if (!a.alive) continue;
        const ap = a.group.position;
        if (Math.abs(ap.y - p.y) > 2.2) continue;
        const dx = p.x - ap.x;
        const dz = p.z - ap.z;
        const dSq = dx * dx + dz * dz;
        if (dSq >= BODY_DIST * BODY_DIST) continue;
        if (dSq > 1e-9) {
          const d = Math.sqrt(dSq);
          p.x += (dx / d) * (BODY_DIST - d);
          p.z += (dz / d) * (BODY_DIST - d);
        } else {
          p.x += BODY_DIST;
        }
        pushed = true;
      }
      // The shove must not put us inside a wall.
      if (pushed) this.world.collide(p, 0.45, 1.7);
    }

    this.publishTimer -= dt;
    if (this.publishTimer <= 0) {
      this.publishTimer = PUBLISH_INTERVAL;
      this.publish(weaponIndex);
    }
  }

  scoreboard(): ScoreRow[] {
    const rows: ScoreRow[] = [
      {
        id: this.net.id,
        name: this.playerName,
        kills: this.kills,
        deaths: this.deaths,
        alive: this.player.alive,
      },
    ];
    for (const [id, a] of this.avatars) {
      rows.push({ id, name: a.name, kills: a.kills, deaths: a.deaths, alive: a.alive });
    }
    rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    return rows;
  }

  private lastWeapon = 0;

  private publish(weaponIndex?: number): void {
    if (weaponIndex !== undefined) this.lastWeapon = weaponIndex;
    const p = this.player;
    this.net.publish({
      n: this.playerName,
      x: round2(p.position.x),
      y: round2(p.position.y),
      z: round2(p.position.z),
      yaw: round2(p.yaw),
      pitch: round2(p.pitch),
      h: Math.max(0, Math.round(p.health)),
      w: this.lastWeapon,
      k: this.kills,
      d: this.deaths,
      s: this.shotSeq,
      sdx: round2(this.lastShotDir.x),
      sdy: round2(this.lastShotDir.y),
      sdz: round2(this.lastShotDir.z),
      ks: this.deathSeq,
      kb: this.killedBy,
      t: Date.now(),
    });
  }

  leave(): void {
    this.net.leave();
    for (const a of this.avatars.values()) a.dispose();
    this.avatars.clear();
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

const _c = new THREE.Vector3();
const _toC = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _end = new THREE.Vector3();
