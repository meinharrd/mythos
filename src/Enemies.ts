import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { World } from "./World";
import { Player } from "./Player";
import { Effects } from "./Effects";
import { AudioFX } from "./AudioFX";
import { metalTexture } from "./Textures";
import { buildRobot, RobotRig, EnemyKind } from "./Robot";

export type { EnemyKind } from "./Robot";

interface EnemyDef {
  health: number;
  speed: number;
  radius: number;
  /** Chest height (aim target), before scaling. */
  bodyY: number;
  damage: number;
  score: number;
  color: number;
  coreColor: number;
  scale: number;
}

const DEFS: Record<EnemyKind, EnemyDef> = {
  stalker: {
    health: 25,
    speed: 7.8,
    radius: 0.5,
    bodyY: 1.4,
    damage: 8,
    score: 100,
    color: 0x8a79c8,
    coreColor: 0xff4f6d,
    scale: 0.9,
  },
  sentinel: {
    health: 50,
    speed: 4.6,
    radius: 0.55,
    bodyY: 1.4,
    damage: 7,
    score: 175,
    color: 0x6f9fc8,
    coreColor: 0xffa040,
    scale: 1.05,
  },
  brute: {
    health: 140,
    speed: 3.4,
    radius: 0.85,
    bodyY: 1.4,
    damage: 20,
    score: 400,
    color: 0xc87f6f,
    coreColor: 0xff3030,
    scale: 1.5,
  },
};

const POOL_SIZE = 36;
const PROJECTILE_POOL = 48;
const PROJECTILE_SPEED = 22;
/** Max melee enemies allowed to press the attack at once; the rest ring up. */
const MELEE_TOKENS = 3;
/** Wrecks stay on the floor; above this count the oldest sink away. */
const MAX_CORPSES = 24;

class Enemy {
  active = false;
  kind: EnemyKind = "stalker";
  health = 0;
  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  attackCooldown = 0;
  strafeDir = 1;
  strafeTimer = 0;
  hitFlash = 0;
  spawnScale = 0;
  walkPhase = 0;
  attackAnim = 0;
  /**
   * Awareness model: patrol → suspicious (investigate a glimpse) →
   * hunt (chase) → search (lost contact, sweep last known position).
   */
  state: "patrol" | "suspicious" | "hunt" | "search" = "patrol";
  /** 0..1 meter that fills while the player is in view. */
  awareness = 0;
  /** Where the player was last seen or heard. */
  lastKnown = new THREE.Vector3();
  /** Seconds since a hunter last perceived the player. */
  lostTimer = 0;
  searchTimer = 0;
  reactTimer = 0;
  /** Holding one of the limited melee attack slots. */
  hasToken = false;
  /** Zone this unit garrisons; it stays there until it discovers the player. */
  homeZone = 0;
  wanderTarget = new THREE.Vector3();
  wanderTimer = 0;

  rig!: RobotRig;
  private builtKind: EnemyKind | null = null;
  blob: THREE.Mesh;
  bodyMat!: THREE.MeshStandardMaterial;
  accentMat!: THREE.MeshStandardMaterial;
  coreMat!: THREE.MeshBasicMaterial;
  private scene: THREE.Scene;
  private skin: THREE.Texture;
  private envMap: THREE.Texture;

  constructor(
    scene: THREE.Scene,
    skin: THREE.Texture,
    blobGeo: THREE.BufferGeometry,
    blobMat: THREE.Material,
    envMap: THREE.Texture
  ) {
    this.scene = scene;
    this.skin = skin;
    this.envMap = envMap;
    this.makeMaterials();

    this.blob = new THREE.Mesh(blobGeo, blobMat);
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.visible = false;
    scene.add(this.blob);
  }

  /** Fresh material set; the previous set may live on in a corpse. */
  private makeMaterials(): void {
    // Polished chrome look: high metalness + low roughness only works
    // with an environment map to reflect, hence the PMREM texture.
    this.bodyMat = new THREE.MeshStandardMaterial({
      map: this.skin,
      roughness: 0.15,
      metalness: 0.95,
      envMap: this.envMap,
      envMapIntensity: 1.7,
      emissiveMap: this.skin,
      emissiveIntensity: 0.12,
    });
    this.accentMat = new THREE.MeshStandardMaterial({
      map: this.skin,
      color: 0x4a5870,
      roughness: 0.2,
      metalness: 0.95,
      envMap: this.envMap,
      envMapIntensity: 1.5,
      emissive: 0x161e2e,
      emissiveMap: this.skin,
      emissiveIntensity: 0.15,
    });
    this.coreMat = new THREE.MeshBasicMaterial({ color: 0xff4f6d });
  }

  /**
   * Hand the rig and its powered-down materials over to a permanent
   * corpse. The slot gets fresh materials and rebuilds its rig on the
   * next spawn, so the wreck keeps its frozen look forever.
   */
  detachRig(): { group: THREE.Group; mats: THREE.Material[] } {
    const out = { group: this.rig.group, mats: [this.bodyMat, this.accentMat, this.coreMat] };
    this.builtKind = null;
    this.makeMaterials();
    return out;
  }

  /** Pool slots are reused across kinds; rebuild the rig when kind changes. */
  private ensureRig(kind: EnemyKind): void {
    if (this.builtKind === kind) return;
    if (this.builtKind !== null) this.scene.remove(this.rig.group);
    this.rig = buildRobot(kind, this.bodyMat, this.accentMat, this.coreMat);
    // Yaw-first euler so the death tip-over pivots in the body's frame.
    this.rig.group.rotation.order = "YXZ";
    this.rig.group.visible = false;
    this.scene.add(this.rig.group);
    this.builtKind = kind;
  }

  spawn(kind: EnemyKind, x: number, z: number): void {
    const def = DEFS[kind];
    this.ensureRig(kind);
    this.kind = kind;
    this.health = def.health;
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.attackCooldown = 1 + Math.random();
    this.active = true;
    this.hitFlash = 0;
    this.spawnScale = 0;
    this.walkPhase = Math.random() * Math.PI * 2;
    this.attackAnim = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = 1 + Math.random() * 2;
    this.state = "patrol";
    this.awareness = 0;
    this.lastKnown.set(x, 0, z);
    this.lostTimer = 0;
    this.searchTimer = 0;
    this.reactTimer = 0;
    this.hasToken = false;
    this.wanderTarget.set(x, 0, z);
    this.wanderTimer = 0.5 + Math.random() * 1.5;
    this.bodyMat.color.setHex(def.color);
    this.bodyMat.emissive.setHex(def.color);
    this.bodyMat.emissiveIntensity = 0.12;
    this.accentMat.emissiveIntensity = 0.15;
    this.coreMat.color.setHex(def.coreColor);
    this.rig.group.rotation.set(0, this.rig.group.rotation.y, 0);
    this.rig.group.visible = true;
    this.blob.visible = true;
  }

  despawn(): void {
    this.active = false;
    this.rig.group.visible = false;
    this.blob.visible = false;
  }

  get def(): EnemyDef {
    return DEFS[this.kind];
  }

  /** World-space chest height — the aim target. */
  get chestY(): number {
    return this.position.y + this.def.bodyY * this.def.scale;
  }
}

interface Projectile {
  active: boolean;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  mesh: THREE.Mesh;
  life: number;
}

/** A powered-down wreck detached from the pool; it stays on the floor. */
interface Corpse {
  group: THREE.Group;
  /** Disposed when the wreck is finally removed. */
  mats: THREE.Material[];
  /** Merged geometries baked at impact; disposed with the wreck. */
  geos: THREE.BufferGeometry[];
  x: number;
  y: number;
  z: number;
  /** Where the head ends up lying — used to keep new falls clear. */
  headX: number;
  headZ: number;
  chestH: number;
  lift: number;
  strafeDir: number;
  /** The body twists from yawFrom to yawFrom + yawDelta while tipping. */
  yawFrom: number;
  yawDelta: number;
  age: number;
  sink: number;
}

/** Candidate fall directions (relative to current heading), tried in order. */
const FALL_OFFSETS = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 2.6, -2.6, Math.PI];

export class EnemyManager {
  private pool: Enemy[] = [];
  private projectiles: Projectile[] = [];
  private corpses: Corpse[] = [];
  private meleeTokens = 0;
  private scene: THREE.Scene;
  private world: World;
  private effects: Effects;
  private audio: AudioFX;
  private deathColor = new THREE.Color();

  onKill: (kind: EnemyKind, score: number) => void = () => {};

  constructor(
    scene: THREE.Scene,
    world: World,
    effects: Effects,
    audio: AudioFX,
    envMap: THREE.Texture
  ) {
    this.scene = scene;
    this.world = world;
    this.effects = effects;
    this.audio = audio;

    const skin = metalTexture(); // shared by every robot
    const blobGeo = new THREE.CircleGeometry(0.5, 16);
    const blobMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    });
    for (let i = 0; i < POOL_SIZE; i++) {
      this.pool.push(new Enemy(scene, skin, blobGeo, blobMat, envMap));
    }

    const projGeo = new THREE.SphereGeometry(0.14, 8, 6);
    const projMat = new THREE.MeshBasicMaterial({ color: 0xffa040 });
    for (let i = 0; i < PROJECTILE_POOL; i++) {
      const mesh = new THREE.Mesh(projGeo, projMat);
      mesh.visible = false;
      scene.add(mesh);
      this.projectiles.push({
        active: false,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        mesh,
        life: 0,
      });
    }
  }

  get aliveCount(): number {
    let n = 0;
    for (const e of this.pool) if (e.active) n++;
    return n;
  }

  /** True if any active enemy is within `radius` of (x, z). Used by doors. */
  anyActiveNear(x: number, z: number, radius: number): boolean {
    const r2 = radius * radius;
    for (const e of this.pool) {
      if (!e.active) continue;
      const dx = e.position.x - x;
      const dz = e.position.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  reset(): void {
    for (const e of this.pool) {
      e.hasToken = false;
      if (e.active) e.despawn();
    }
    for (const c of this.corpses) {
      this.scene.remove(c.group);
      for (const m of c.mats) m.dispose();
      for (const g of c.geos) g.dispose();
    }
    this.corpses.length = 0;
    this.meleeTokens = 0;
    for (const p of this.projectiles) {
      p.active = false;
      p.mesh.visible = false;
    }
  }

  private releaseToken(e: Enemy): void {
    if (e.hasToken) {
      e.hasToken = false;
      this.meleeTokens--;
    }
  }

  /**
   * Garrison the wave across the facility: each unit is assigned a zone
   * (never the player's, when avoidable) and patrols only there until
   * it discovers the player.
   */
  spawnWave(kinds: EnemyKind[], player: Player): void {
    const playerZone = this.world.zoneOf(player.position);
    const zones = this.world.spawnSpots
      .map((_, z) => z)
      .filter((z) => z !== playerZone && this.world.spawnSpots[z].length > 0);
    let zi = Math.floor(Math.random() * zones.length);
    for (const kind of kinds) {
      const e = this.pool.find((e) => !e.active);
      if (!e) return;
      let x = 0;
      let z = 0;
      let zone = 0;
      for (let attempt = 0; attempt < 12; attempt++) {
        zone = zones[zi % zones.length];
        zi++;
        const spots = this.world.spawnSpots[zone];
        [x, z] = spots[Math.floor(Math.random() * spots.length)];
        const dx = x - player.position.x;
        const dz = z - player.position.z;
        if (dx * dx + dz * dz > 16 * 16) break;
      }
      e.spawn(kind, x, z);
      e.homeZone = zone;
    }
  }

  /** Facility-wide alarm: every active unit converges on the position. */
  alertAll(pos: THREE.Vector3): void {
    for (const e of this.pool) {
      if (!e.active) continue;
      this.alertEnemy(e, 0.3 + Math.random() * 0.8, pos);
    }
  }

  /**
   * Ray vs enemy bounding spheres (centered on the chest). Returns the
   * nearest hit enemy and distance, or null. Allocation-free.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { enemy: Enemy; dist: number } | null {
    let best: Enemy | null = null;
    let bestDist = maxDist;
    for (const e of this.pool) {
      if (!e.active) continue;
      const r = e.def.radius * e.def.scale + 0.2;
      _toCenter.set(e.position.x - origin.x, e.chestY - origin.y, e.position.z - origin.z);
      const proj = _toCenter.dot(dir);
      if (proj < 0 || proj > bestDist) continue;
      const distSq = _toCenter.lengthSq() - proj * proj;
      if (distSq < r * r) {
        best = e;
        bestDist = proj;
      }
    }
    return best ? { enemy: best, dist: bestDist } : null;
  }

  damage(enemy: Enemy, amount: number, hitPoint: THREE.Vector3, shooterPos?: THREE.Vector3): boolean {
    enemy.health -= amount;
    enemy.hitFlash = 0.12;
    // Getting shot wakes them up instantly; they know roughly where from.
    this.alertEnemy(enemy, 0, shooterPos ?? hitPoint);
    this.deathColor.setHex(enemy.def.coreColor);
    this.effects.burst(hitPoint, 6, this.deathColor, 5, 0.3);
    if (enemy.health <= 0) {
      this.releaseToken(enemy);
      this.killEnemy(enemy);
      _center.copy(enemy.position);
      _center.y = enemy.chestY;
      this.effects.burst(_center, 24, this.deathColor, 7, 0.6);
      this.audio.kill();
      this.onKill(enemy.kind, enemy.def.score);
      return true;
    }
    return false;
  }

  /** Power down, tip over, and leave the wreck on the floor for good. */
  private killEnemy(e: Enemy): void {
    e.active = false; // out of combat: no AI, raycasts, doors or waves
    e.blob.visible = false;
    // Lights off.
    e.bodyMat.emissiveIntensity = 0;
    e.accentMat.emissiveIntensity = 0;
    e.coreMat.color.setHex(0x14161a);
    // Limp sprawl instead of whatever pose it died in. The wreck lands
    // on its back, so limb x-swings must be negative (toward the body's
    // front = up off the floor plane the back rests on).
    const rig = e.rig;
    rig.legL.rotation.set(-0.3, 0, 0.25 * e.strafeDir);
    rig.legR.rotation.set(-0.1, 0, -0.2 * e.strafeDir);
    rig.armL.rotation.set(-0.45, 0, 0.55);
    rig.armR.rotation.set(-0.15, 0, -0.5);
    rig.torso.rotation.set(0.08, 0, 0.06 * e.strafeDir);
    rig.head.rotation.y = 0.5 * e.strafeDir;

    const def = e.def;
    const yawFrom = rig.group.rotation.y;
    const yawTo = this.pickFallYaw(e, yawFrom, 1.9 * def.scale);
    let yawDelta = yawTo - yawFrom;
    yawDelta = Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta));

    const { group, mats } = e.detachRig();
    this.corpses.push({
      group,
      mats,
      geos: [],
      x: e.position.x,
      y: e.position.y,
      z: e.position.z,
      headX: e.position.x - Math.sin(yawTo) * 1.9 * def.scale,
      headZ: e.position.z - Math.cos(yawTo) * 1.9 * def.scale,
      chestH: def.bodyY * def.scale,
      lift: 0.22 * def.scale,
      strafeDir: e.strafeDir,
      yawFrom,
      yawDelta,
      age: 0,
      sink: 0,
    });
  }

  /**
   * Find the clearest direction to topple in (the body falls backward,
   * head landing opposite the yaw). Scores candidates near the current
   * heading against existing wrecks, living robots and obstacles so
   * falling bodies don't slam through each other or through crates.
   */
  private pickFallYaw(e: Enemy, yaw0: number, len: number): number {
    let bestYaw = yaw0;
    let bestScore = -Infinity;
    for (let i = 0; i < FALL_OFFSETS.length; i++) {
      const yaw = yaw0 + FALL_OFFSETS[i];
      const hx = e.position.x - Math.sin(yaw) * len;
      const hz = e.position.z - Math.cos(yaw) * len;
      const mx = e.position.x - Math.sin(yaw) * len * 0.55;
      const mz = e.position.z - Math.cos(yaw) * len * 0.55;

      let clear = Infinity;
      for (const c of this.corpses) {
        // Sample each wreck as three points: feet, middle, head.
        for (let t = 0; t <= 2; t++) {
          const px = c.x + (c.headX - c.x) * t * 0.5;
          const pz = c.z + (c.headZ - c.z) * t * 0.5;
          clear = Math.min(
            clear,
            Math.hypot(hx - px, hz - pz),
            Math.hypot(mx - px, mz - pz)
          );
        }
      }
      for (const o of this.pool) {
        if (!o.active || o === e) continue;
        clear = Math.min(clear, Math.hypot(hx - o.position.x, hz - o.position.z));
      }
      _corner.set(hx, e.position.y + 0.45, hz);
      for (const ob of this.world.obstacles) {
        if (ob.enabled === false) continue;
        if (ob.box.containsPoint(_corner)) clear = 0;
      }

      // Current heading wins outright when it's already clear.
      if (i === 0 && clear > 1.6) return yaw;
      const score = clear - Math.abs(FALL_OFFSETS[i]) * 0.35;
      if (score > bestScore) {
        bestScore = score;
        bestYaw = yaw;
      }
    }
    return bestYaw;
  }

  /**
   * Corpses tip over around the feet under gravity and then stay where
   * they fell. Only when too many have piled up do the oldest sink away.
   */
  private updateCorpses(dt: number): void {
    const over = this.corpses.length - MAX_CORPSES;
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      const agePrev = c.age;
      c.age += dt;
      if (c.age < 3) {
        const fPrev = Math.min(1, (agePrev / 0.55) * (agePrev / 0.55));
        const f = Math.min(1, (c.age / 0.55) * (c.age / 0.55));
        c.group.rotation.x = -f * 1.45;
        c.group.rotation.z = f * c.strafeDir * 0.12;
        // Twist toward the chosen clear fall direction while tipping.
        c.group.rotation.y = c.yawFrom + c.yawDelta * f;
        // Lift by half the body's thickness as it tips so the lying
        // wreck rests on the floor instead of sinking to its center.
        c.group.position.y = c.y + f * c.lift;

        // Chest position follows the fall (rotation pivots at the feet).
        const yaw = c.group.rotation.y;
        const horiz = c.chestH * Math.sin(c.group.rotation.x);
        _center.set(
          c.x + Math.sin(yaw) * horiz,
          c.group.position.y + c.chestH * Math.cos(c.group.rotation.x),
          c.z + Math.cos(yaw) * horiz
        );
        // Electric sparks sputter from the chest while it powers down,
        // with a bigger shower the moment the wreck slams into the floor.
        if (fPrev < 1 && f >= 1) {
          // Settle exactly onto the ground: measure the lowest corner of
          // any part (all parts are scaled unit boxes) and shift so it
          // touches. Redefining `lift` keeps later frames and the sink
          // animation consistent with the snapped height.
          c.group.updateWorldMatrix(true, true);
          let minY = Infinity;
          c.group.traverse((o) => {
            if (!(o as THREE.Mesh).isMesh) return;
            for (let k = 0; k < 8; k++) {
              _corner.set(k & 1 ? 0.5 : -0.5, k & 2 ? 0.5 : -0.5, k & 4 ? 0.5 : -0.5);
              _corner.applyMatrix4(o.matrixWorld);
              if (_corner.y < minY) minY = _corner.y;
            }
          });
          c.group.position.y += c.y - minY;
          c.lift = c.group.position.y - c.y;
          this.compactCorpse(c);
          this.deathColor.setHex(0xfff0b8);
          this.effects.burst(_center, 30, this.deathColor, 5.5, 0.55);
          this.audio.slam(c.x, c.z, c.chestH);
        } else if (c.age < 2.4 && Math.random() < dt * 10) {
          // Slow + dense so the additive points overlap into a bright fizz.
          this.deathColor.setHex(Math.random() < 0.5 ? 0xffe8a8 : 0xbfe8ff);
          this.effects.burst(_center, 14, this.deathColor, 2.4, 0.45);
        }
      }

      // Oldest wrecks beyond the cap sink into the floor and free up.
      if (i < over && c.age > 3) {
        c.sink += dt;
        c.group.position.y = c.y + c.lift - c.sink * c.sink * 1.2;
        if (c.sink > 1.1) {
          this.scene.remove(c.group);
          for (const m of c.mats) m.dispose();
          for (const g of c.geos) g.dispose();
          this.corpses.splice(i, 1);
        }
      }
    }
  }

  update(dt: number, player: Player): void {
    const time = performance.now() * 0.001;

    this.updateCorpses(dt);

    for (const e of this.pool) {
      if (!e.active) continue;
      const def = e.def;

      // Scale-in on spawn.
      e.spawnScale = Math.min(1, e.spawnScale + dt * 3);
      e.attackCooldown -= dt;
      e.hitFlash = Math.max(0, e.hitFlash - dt);

      _toPlayer.subVectors(player.position, e.position);
      const dy = _toPlayer.y;
      _toPlayer.y = 0;
      const dist = _toPlayer.length();
      if (dist > 1e-4) _toPlayer.multiplyScalar(1 / dist);

      // Periodically flip orbit/strafe direction.
      e.strafeTimer -= dt;
      if (e.strafeTimer <= 0) {
        e.strafeTimer = 1.5 + Math.random() * 2.5;
        e.strafeDir = Math.random() < 0.5 ? -1 : 1;
      }

      // --- Perception ------------------------------------------------
      // Vision: frontal cone + line of sight (no cone up close, wider
      // cone once alarmed). Hearing: very close proximity.
      let visible = false;
      const vigilant = e.state === "hunt" || e.state === "search";
      if (player.alive && Math.abs(dy) < 5 && dist < (vigilant ? 34 : 30)) {
        const fx = Math.sin(e.rig.group.rotation.y);
        const fz = Math.cos(e.rig.group.rotation.y);
        const dot = fx * _toPlayer.x + fz * _toPlayer.z;
        if (dist < 7 || dot > (vigilant ? -0.5 : 0.25)) {
          _from.copy(e.position);
          _from.y = e.chestY;
          _to.copy(player.position);
          _to.y = player.position.y + 1.4;
          visible = !this.world.blocksLine(_from, _to);
        }
      }
      // Hearing is blocked by walls and closed doors too: footsteps in
      // the next room don't give you away.
      let heard = player.alive && dist < 7 && Math.abs(dy) < 3;
      if (heard && !visible) {
        _from.copy(e.position);
        _from.y = e.chestY;
        _to.copy(player.position);
        _to.y = player.position.y + 1.4;
        heard = !this.world.blocksLine(_from, _to);
      }

      // Awareness meter: fills while the player is in view (faster up
      // close, faster when already suspicious), decays out of view.
      // Hearing maxes it instantly.
      if (visible) {
        const closeness = 1.2 - dist / 34;
        const mult = e.state === "suspicious" ? 1.8 : 1;
        e.awareness = Math.min(1, e.awareness + dt * (0.5 + closeness) * mult);
        e.lastKnown.copy(player.position);
      } else if (e.awareness > 0) {
        e.awareness = Math.max(0, e.awareness - dt * 0.2);
      }
      if (heard) {
        e.awareness = 1;
        e.lastKnown.copy(player.position);
      }

      // --- State transitions ------------------------------------------
      if (e.state === "patrol") {
        if (e.awareness >= 1) {
          this.alertEnemy(e, 0.25 + Math.random() * 0.35, player.position);
        } else if (e.awareness > 0.35 && visible) {
          e.state = "suspicious"; // something moved over there...
        }
      } else if (e.state === "suspicious") {
        if (e.awareness >= 1) {
          this.alertEnemy(e, 0.15 + Math.random() * 0.2, player.position);
        } else if (e.awareness <= 0) {
          e.state = "patrol";
          e.wanderTimer = 0;
        }
      } else if (e.state === "hunt") {
        // Intermittent hunting growl: you hear them coming for you.
        if (Math.random() < dt * 0.35) this.audio.growl(e.position.x, e.position.z);
        if (visible || heard || (dist < 10 && player.alive)) {
          e.lostTimer = 0;
          e.lastKnown.copy(player.position);
        } else {
          e.lostTimer += dt;
          const lkx = e.lastKnown.x - e.position.x;
          const lkz = e.lastKnown.z - e.position.z;
          if (e.lostTimer > 1.5 && lkx * lkx + lkz * lkz < 2.5 * 2.5) {
            // Reached the last known position with no contact: sweep it.
            this.releaseToken(e);
            e.state = "search";
            e.searchTimer = 8 + Math.random() * 4;
            e.wanderTimer = 0;
          }
        }
      } else if (e.state === "search") {
        if (visible) {
          this.alertEnemy(e, 0.1, player.position); // re-acquired!
        } else {
          e.searchTimer -= dt;
          if (e.searchTimer <= 0) {
            // Gave up: garrison wherever the hunt ended.
            e.state = "patrol";
            e.awareness = 0;
            e.wanderTimer = 0;
            e.homeZone = this.world.zoneOf(e.position);
          }
        }
      }

      // Hunters with live contact share intel with nearby squadmates.
      // (Without the live-contact gate, packs would pin each other in
      // the hunt state forever with stale positions.)
      if (e.state === "hunt" && e.reactTimer <= 0 && e.lostTimer === 0) {
        for (const other of this.pool) {
          if (other === e || !other.active || other.state === "hunt") continue;
          const adx = other.position.x - e.position.x;
          const adz = other.position.z - e.position.z;
          if (adx * adx + adz * adz < 12 * 12) {
            // Radio chatter doesn't go through bulkheads: squadmates
            // only pick up intel with a clear line between them.
            _from.copy(e.position);
            _from.y = e.chestY;
            _to.copy(other.position);
            _to.y = other.chestY;
            if (this.world.blocksLine(_from, _to)) continue;
            this.alertEnemy(other, 0.4 + Math.random() * 0.4, e.lastKnown);
          }
        }
      }

      // Hunting target: the player while perceived, otherwise the last
      // known position (converge there, then transition to search).
      const perceived = e.lostTimer === 0 && player.alive;
      _target.copy(perceived ? player.position : e.lastKnown);
      _toTarget.set(_target.x - e.position.x, 0, _target.z - e.position.z);
      const tDist = _toTarget.length();
      if (tDist > 1e-4) _toTarget.multiplyScalar(1 / tDist);
      const tDy = _target.y - e.position.y;

      // Navigation waypoints (hunters only): route through doors between
      // zones, and to staircases when the target is on a higher level.
      let seeking = false;
      if (e.state === "hunt" && e.reactTimer <= 0) {
        const doorWp = this.world.doorTarget(e.position, _target);
        if (doorWp) {
          seeking = true;
          _seek.set(doorWp.x - e.position.x, 0, doorWp.z - e.position.z);
          const d = _seek.length();
          if (d > 1e-4) _seek.multiplyScalar(1 / d);
        } else if (e.kind !== "sentinel" && tDy > 1.1) {
          const wp = this.world.nearestStairTarget(e.position, _target);
          if (wp) {
            seeking = true;
            _seek.set(wp.x - e.position.x, 0, wp.z - e.position.z);
            const d = _seek.length();
            if (d > 1e-4) _seek.multiplyScalar(1 / d);
          }
        }
      }

      let moveX = 0;
      let moveZ = 0;
      let speed = 0;
      let facePlayer = false;

      if (e.state === "patrol") {
        // Amble between waypoints inside the assigned zone, pausing to
        // scan between legs. Undiscovered units never leave their post.
        e.wanderTimer -= dt;
        if (e.wanderTimer <= 0) {
          e.wanderTimer = 3 + Math.random() * 3;
          const r = this.world.zoneRect(e.homeZone);
          e.wanderTarget.set(
            Math.max(r[0], Math.min(r[1], e.position.x + (Math.random() - 0.5) * 26)),
            0,
            Math.max(r[2], Math.min(r[3], e.position.z + (Math.random() - 0.5) * 26))
          );
        }
        const wx = e.wanderTarget.x - e.position.x;
        const wz = e.wanderTarget.z - e.position.z;
        const wd = Math.hypot(wx, wz);
        if (wd > 1.2) {
          moveX = wx / wd;
          moveZ = wz / wd;
          speed = def.speed * 0.35;
        }
      } else if (e.state === "suspicious") {
        // Investigate the glimpse: approach it warily.
        const wx = e.lastKnown.x - e.position.x;
        const wz = e.lastKnown.z - e.position.z;
        const wd = Math.hypot(wx, wz);
        if (wd > 1.6) {
          moveX = wx / wd;
          moveZ = wz / wd;
          speed = def.speed * 0.55;
        }
      } else if (e.state === "search") {
        // Sweep points around the last known position, staying inside
        // the room it lies in (no blind wandering through walls).
        e.wanderTimer -= dt;
        if (e.wanderTimer <= 0) {
          e.wanderTimer = 2 + Math.random() * 2;
          const r = this.world.zoneRect(this.world.zoneOf(e.lastKnown));
          e.wanderTarget.set(
            Math.max(r[0], Math.min(r[1], e.lastKnown.x + (Math.random() - 0.5) * 16)),
            0,
            Math.max(r[2], Math.min(r[3], e.lastKnown.z + (Math.random() - 0.5) * 16))
          );
        }
        const wx = e.wanderTarget.x - e.position.x;
        const wz = e.wanderTarget.z - e.position.z;
        const wd = Math.hypot(wx, wz);
        if (wd > 1.2) {
          moveX = wx / wd;
          moveZ = wz / wd;
          speed = def.speed * 0.5;
        }
      } else if (e.reactTimer > 0) {
        // Just spotted the player: freeze and turn before charging.
        e.reactTimer -= dt;
        facePlayer = true;
      } else if (seeking) {
        // March to the door/staircase waypoint at full speed.
        moveX = _seek.x;
        moveZ = _seek.z;
        speed = def.speed;
      } else if (!perceived) {
        // Lost contact: head straight for the last known position
        // (no combat dance around an empty spot).
        if (tDist > 0.5) {
          moveX = _toTarget.x;
          moveZ = _toTarget.z;
          speed = def.speed;
        }
      } else if (e.kind === "sentinel") {
        // Keep mid range and strafe.
        const ideal = 14;
        const radial = tDist > ideal + 2 ? 1 : tDist < ideal - 2 ? -1 : 0;
        moveX = _toTarget.x * radial + -_toTarget.z * e.strafeDir * 0.8;
        moveZ = _toTarget.z * radial + _toTarget.x * e.strafeDir * 0.8;
        const len = Math.hypot(moveX, moveZ);
        if (len > 1e-4) {
          moveX /= len;
          moveZ /= len;
        }
        speed = def.speed;
        facePlayer = perceived;

        // Fire from the arm cannon when in range with line of sight.
        if (e.attackCooldown <= 0 && dist < 26 && player.alive) {
          _from.copy(e.position);
          _from.y = e.chestY;
          _to.copy(player.position);
          _to.y = player.position.y + 1.4;
          if (!this.world.blocksLine(_from, _to)) {
            this.fireProjectile(_from, _to);
            e.attackCooldown = 1.6 + Math.random() * 0.8;
            e.attackAnim = 1;
          }
        }
      } else {
        // Melee chasers with attack tokens: only a few may press in to
        // striking range at once; the rest hold a wider ring and orbit,
        // stepping in when a slot frees up.
        const standoff = def.radius * def.scale + 1.6;
        if (!e.hasToken) {
          if (this.meleeTokens < MELEE_TOKENS && tDist < standoff + 5) {
            e.hasToken = true;
            this.meleeTokens++;
          }
        } else if (tDist > standoff + 9) {
          this.releaseToken(e);
        }
        const hold = e.hasToken ? standoff : standoff + 3.5;

        // Commit to the strike: a token holder in range with the swing
        // wound up (or mid-swing) plants its feet and squares up instead
        // of circle-strafing. The plant doubles as the telegraph; the
        // ring keeps circling, so "stopped and facing you" reads as
        // "about to swing". A short lunge carries the swing forward.
        const committed =
          e.hasToken && tDist < standoff + 1.1 && (e.attackCooldown <= 0.35 || e.attackAnim > 0.2);
        if (committed) {
          facePlayer = true;
          if (e.attackAnim > 0.45) {
            moveX = _toTarget.x;
            moveZ = _toTarget.z;
            speed = def.speed * 0.55;
          }
        } else {
          // Positive: close in. Negative: too close, back off.
          const approach = Math.min(1, Math.max(-1, (tDist - hold) / 1.2));
          const inRange = 1 - Math.min(1, Math.abs(approach));
          const weave = Math.sin(time * 2 + e.position.x * 0.7) * 0.25;
          const orbit = (1 - Math.max(0, approach)) * e.strafeDir * (e.hasToken ? 0.9 : 1.05);

          moveX = _toTarget.x * approach - _toTarget.z * (weave * inRange + orbit);
          moveZ = _toTarget.z * approach + _toTarget.x * (weave * inRange + orbit);
          const len = Math.hypot(moveX, moveZ);
          if (len > 1e-4) {
            moveX /= len;
            moveZ /= len;
          }
          // Full speed while chasing or retreating, slower while circling.
          speed = def.speed * Math.max(Math.abs(approach), Math.abs(orbit) * 0.45);
          if (!e.hasToken) speed *= 0.85;
          facePlayer = perceived && approach < 0.6;
        }

        if (dist < standoff + 0.4 && Math.abs(dy) < 1.6 && e.attackCooldown <= 0 && player.alive) {
          player.takeDamage(def.damage);
          e.attackCooldown = e.kind === "brute" ? 1.5 : 0.9;
          e.attackAnim = 1;
          this.audio.swing(e.position.x, e.position.z, e.kind === "brute");
        }
      }

      e.velocity.x = moveX * speed * e.spawnScale;
      e.velocity.z = moveZ * speed * e.spawnScale;
      e.position.x += e.velocity.x * dt;
      e.position.z += e.velocity.z * dt;

      // Separation from other enemies (O(n^2) over a small pool is fine).
      for (const other of this.pool) {
        if (other === e || !other.active) continue;
        const dx = e.position.x - other.position.x;
        const dz = e.position.z - other.position.z;
        const minDist = def.radius * def.scale + other.def.radius * other.def.scale + 0.35;
        const dSq = dx * dx + dz * dz;
        if (dSq < minDist * minDist && dSq > 1e-9) {
          const d = Math.sqrt(dSq);
          const push = ((minDist - d) / d) * 0.5;
          e.position.x += dx * push;
          e.position.z += dz * push;
        }
      }

      // Hard collision with the player: never overlap, no matter what
      // the steering above decided.
      if (player.alive && Math.abs(dy) < 2) {
        const minPD = def.radius * def.scale + 1.1;
        const pdx = e.position.x - player.position.x;
        const pdz = e.position.z - player.position.z;
        const pdSq = pdx * pdx + pdz * pdz;
        if (pdSq < minPD * minPD && pdSq > 1e-9) {
          const pd = Math.sqrt(pdSq);
          e.position.x = player.position.x + (pdx / pd) * minPD;
          e.position.z = player.position.z + (pdz / pd) * minPD;
        }
      }

      // World collision LAST: separation and player pushback above can
      // shove a robot into a pillar, so the wall resolve must have the
      // final say or bodies visibly clip into columns.
      this.world.collide(e.position, def.radius * def.scale, def.bodyY * def.scale * 1.4);

      // Follow the terrain: climb steps quickly, fall off ledges.
      const ground = this.world.groundHeight(e.position, 0.3);
      if (e.position.y < ground) {
        e.position.y = Math.min(ground, e.position.y + dt * 7);
      } else if (e.position.y > ground) {
        e.position.y = Math.max(ground, e.position.y - dt * 12);
      }

      // Keep the current heading when standing still (idle scan pose).
      let faceX = facePlayer ? _toPlayer.x : moveX;
      let faceZ = facePlayer ? _toPlayer.z : moveZ;
      if (Math.abs(faceX) + Math.abs(faceZ) < 1e-4) {
        faceX = Math.sin(e.rig.group.rotation.y);
        faceZ = Math.cos(e.rig.group.rotation.y);
      }
      this.animate(e, dt, time, faceX, faceZ);
    }

    this.updateProjectiles(dt, player);
  }

  /**
   * Bake a settled wreck into one merged mesh per material. A full rig
   * is ~25 scene-graph objects that three.js re-transforms, frustum-tests
   * and draws individually every frame; two dozen persistent corpses cost
   * more frame time than the live robots did. Geometry is baked in the
   * group's local space, so the group transform (and the later sink
   * animation) keeps working unchanged. Each corpse drops to <= 3 draws.
   */
  private compactCorpse(c: Corpse): void {
    const group = c.group;
    group.updateWorldMatrix(true, true);
    _invGroup.copy(group.matrixWorld).invert();

    const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry.clone();
      _bake.multiplyMatrices(_invGroup, mesh.matrixWorld);
      geo.applyMatrix4(_bake);
      const mat = mesh.material as THREE.Material;
      let list = buckets.get(mat);
      if (!list) buckets.set(mat, (list = []));
      list.push(geo);
    });

    group.clear(); // shared unit geometries stay alive for other rigs
    for (const [mat, geos] of buckets) {
      const merged = mergeGeometries(geos);
      for (const g of geos) g.dispose();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      c.geos.push(merged);
      group.add(mesh);
    }
  }

  /** Send an enemy hunting toward a known position. */
  private alertEnemy(e: Enemy, reaction: number, knownPos: THREE.Vector3): void {
    e.lastKnown.copy(knownPos);
    e.awareness = 1;
    e.lostTimer = 0;
    if (e.state === "hunt") return;
    // Searchers re-acquire near-instantly; the unaware take a beat.
    e.reactTimer = e.state === "search" ? Math.min(reaction, 0.15) : reaction;
    e.state = "hunt";
    this.audio.alert(e.position.x, e.position.z);
  }

  /**
   * Loud noises (gunfire) send enemies to the source — but walls and
   * closed doors muffle them. With a clear line the full radius applies;
   * occluded listeners only catch it much closer, and even then they only
   * get suspicious enough to investigate rather than going straight to a
   * full hunt.
   */
  alertFromSound(pos: THREE.Vector3, radius: number): void {
    const r2 = radius * radius;
    for (const e of this.pool) {
      if (!e.active || e.state === "hunt") continue;
      const dx = e.position.x - pos.x;
      const dz = e.position.z - pos.z;
      const dSq = dx * dx + dz * dz;
      if (dSq >= r2) continue;
      _from.copy(e.position);
      _from.y = e.chestY;
      _to.copy(pos);
      _to.y = pos.y + 1.4;
      if (!this.world.blocksLine(_from, _to)) {
        this.alertEnemy(e, 0.25 + Math.random() * 0.4, pos);
      } else if (dSq < 14 * 14) {
        // A muffled thump through the wall: investigate, don't charge.
        e.lastKnown.copy(pos);
        e.awareness = Math.max(e.awareness, 0.7);
        if (e.state === "patrol") e.state = "suspicious";
      }
    }
  }

  /** Drive the robot rig: walk cycle, lean, attack swings, glow pulse. */
  private animate(e: Enemy, dt: number, time: number, faceX: number, faceZ: number): void {
    const def = e.def;
    const rig = e.rig;
    const hSpeed = Math.hypot(e.velocity.x, e.velocity.z);
    const stride = Math.min(1, hSpeed / (def.speed * 0.55));

    // Turn toward the desired heading along the shortest arc instead of
    // snapping; heavier bots swing around more slowly.
    const targetYaw = Math.atan2(faceX, faceZ);
    const curYaw = rig.group.rotation.y;
    const dYaw = Math.atan2(Math.sin(targetYaw - curYaw), Math.cos(targetYaw - curYaw));
    const yaw = curYaw + dYaw * Math.min(1, (dt * 10) / def.scale);
    rig.group.rotation.y = yaw;

    // Split velocity into the body frame so the legs animate along the
    // direction the feet actually travel: forward strides for the walk
    // component, a lateral shuffle for the side-step component.
    const fwd = (e.velocity.x * Math.sin(yaw) + e.velocity.z * Math.cos(yaw)) / def.speed;
    const lat = (e.velocity.x * Math.cos(yaw) - e.velocity.z * Math.sin(yaw)) / def.speed;
    const fMix = Math.abs(fwd) / (Math.abs(fwd) + Math.abs(lat) + 1e-5);

    // Step frequency tracks ground speed; big bots take longer strides.
    // Each half-cycle of the gait is one footfall: clank when it lands.
    const stepParity = Math.floor(e.walkPhase / Math.PI);
    e.walkPhase += dt * (2 + (hSpeed * 2.3) / def.scale);
    if (Math.floor(e.walkPhase / Math.PI) !== stepParity && stride > 0.35 && e.spawnScale > 0.9) {
      this.audio.servoStep(e.position.x, e.position.z, def.scale);
    }
    e.attackAnim = Math.max(0, e.attackAnim - dt * 3.5);
    const ph = Math.sin(e.walkPhase);
    const fSwing = ph * 0.8 * stride * fMix;

    // Side-step gait: a leg at zero hip rotation stands flat on the
    // ground, and any sideways hip swing lifts that foot in an arc. So
    // each leg only swings during its own half of the cycle — the lead
    // leg steps out toward the move direction while the trail leg stays
    // planted at zero, then the trail leg closes the gap. One foot is
    // always down: a proper step-close shuffle instead of a dangle.
    const latAmp = 0.55 * stride * (1 - fMix);
    const dir = lat >= 0 ? 1 : -1;
    const stepL = Math.max(0, ph) * latAmp * dir;
    const stepR = Math.max(0, -ph) * latAmp * dir;

    rig.legL.rotation.x = fSwing;
    rig.legR.rotation.x = -fSwing;
    rig.legL.rotation.z = stepL;
    rig.legR.rotation.z = stepR;

    // Arms work the gait instead of dangling: both sway together as a
    // counterweight against whichever leg is stepping, plus a small
    // alternating jog pump front-to-back.
    const armSway = (stepR - stepL) * 0.5;
    const armPump = ph * latAmp * 0.35;
    rig.armL.rotation.x = -fSwing * 0.65 - armPump - e.attackAnim * 1.7;
    rig.armL.rotation.z = armSway;
    if (e.kind === "sentinel") {
      // Cannon arm tracks the player; recoils when firing.
      rig.armR.rotation.x = -1.25 + e.attackAnim * 0.5;
      rig.armR.rotation.z = 0;
    } else {
      rig.armR.rotation.x = fSwing * 0.65 + armPump - e.attackAnim * 1.7;
      rig.armR.rotation.z = armSway;
    }
    rig.torso.rotation.x = stride * 0.14 * fMix + e.attackAnim * 0.18;
    // Lean into the side-step.
    rig.torso.rotation.z = -lat * stride * 0.22;
    rig.head.rotation.y = Math.sin(time * 1.6 + e.position.x * 0.5) * 0.3 * (1 - stride);

    const s = def.scale * (0.25 + 0.75 * e.spawnScale);
    rig.group.scale.setScalar(s);
    const bob = Math.abs(Math.sin(e.walkPhase)) * 0.05 * stride * def.scale;
    rig.group.position.set(e.position.x, e.position.y + bob, e.position.z);

    // Chest core / visor glow pulse; hit flash on the armor.
    e.coreMat.color.setHex(def.coreColor).multiplyScalar(0.8 + 0.25 * Math.sin(time * 6 + e.position.x));
    e.bodyMat.emissiveIntensity = e.hitFlash > 0 ? 2.5 : 0.12;

    e.blob.position.set(e.position.x, e.position.y + 0.02, e.position.z);
    e.blob.scale.setScalar(def.radius * def.scale * 2.4 * e.spawnScale);
  }

  private fireProjectile(from: THREE.Vector3, to: THREE.Vector3): void {
    const p = this.projectiles.find((p) => !p.active);
    if (!p) return;
    p.position.copy(from);
    p.velocity.subVectors(to, from).normalize().multiplyScalar(PROJECTILE_SPEED);
    p.life = 3;
    p.active = true;
    p.mesh.visible = true;
    p.mesh.position.copy(from);
    this.audio.enemyShoot(from.x, from.z);
  }

  private updateProjectiles(dt: number, player: Player): void {
    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.life -= dt;
      p.position.addScaledVector(p.velocity, dt);
      p.mesh.position.copy(p.position);

      let dead = p.life <= 0 || p.position.y < 0;

      if (!dead) {
        // Hit player? (capsule approximated as cylinder of radius 0.5)
        const dx = p.position.x - player.position.x;
        const dz = p.position.z - player.position.z;
        const dyP = p.position.y - player.position.y;
        if (dx * dx + dz * dz < 0.55 * 0.55 && dyP > -0.1 && dyP < 1.9 && player.alive) {
          player.takeDamage(DEFS.sentinel.damage);
          dead = true;
        }
      }

      if (!dead) {
        for (const o of this.world.obstacles) {
          if (o.enabled === false) continue;
          if (o.box.containsPoint(p.position)) {
            dead = true;
            break;
          }
        }
      }

      if (dead) {
        _orange.setHex(0xffa040);
        this.effects.burst(p.position, 8, _orange, 4, 0.25, false);
        p.active = false;
        p.mesh.visible = false;
      }
    }
  }
}

const _toPlayer = new THREE.Vector3();
const _toCenter = new THREE.Vector3();
const _seek = new THREE.Vector3();
const _target = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _center = new THREE.Vector3();
const _corner = new THREE.Vector3();
const _orange = new THREE.Color();
const _invGroup = new THREE.Matrix4();
const _bake = new THREE.Matrix4();
