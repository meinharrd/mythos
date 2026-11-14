import * as THREE from "three";
import { Undervault, UV_ZONES, VAULT_CENTER, LASER_R0, LASER_R1, LASER_Y, PYLON_HEALTH } from "./Undervault";
import type { Pylon } from "./Undervault";
import type { Player } from "./Player";
import type { EnemyManager, EnemyKind } from "./Enemies";
import type { Effects } from "./Effects";
import type { AudioFX } from "./AudioFX";
import type { HUD } from "./HUD";
import { beamTexture } from "./Textures";

/** Seconds the player must hold the freight lift while it spins up. */
const HOLDOUT_TIME = 45;
/** Holdout reinforcements: interval and cap on simultaneous hostiles. */
const HOLDOUT_SPAWN_EVERY = 6;
const HOLDOUT_MAX_ALIVE = 14;
/** Steam vent cycle: warning hiss, then the blast at the end of each period. */
const VENT_WARN = 2.2;
const VENT_BLAST = 1.6;
const VENT_RADIUS = 1.5;
const VENT_DPS = 48;
const LASER_DAMAGE = 35;

export interface Level2Deps {
  world: Undervault;
  camera: THREE.PerspectiveCamera;
  player: Player;
  enemies: EnemyManager;
  effects: Effects;
  audio: AudioFX;
  hud: HUD;
  addScore: (n: number) => void;
  onWin: () => void;
}

/**
 * Level 2 plot and set pieces. Story: the core cell stolen in Level 1
 * powers the freight lift out of the facility, but slotting it in lets
 * MYTHOS (the facility mind running the robots) seize the grid.
 *
 *   0  slot the core cell into the lift's power bay → blackout
 *   1  reach the vault through the flooded tunnels
 *   2  destroy the three relay pylons (the Warden wakes)
 *   3  MYTHOS offline: get back to the lift
 *   4  hold the lift while it spins up → win
 */
export class Level2Director {
  private d: Level2Deps;
  private stage = 0;
  private time = 0;
  /** Delay between slotting the cell and MYTHOS cutting the power. */
  private blackoutTimer = -1;
  private laserAngle = 0;
  private laserCooldown = 0;
  private ventTick = 0;
  private holdTimer = HOLDOUT_TIME;
  private spawnTimer = 0;
  private flashOn = true;
  private flashFlicker = 0;
  private flashlight: THREE.SpotLight;
  private beam: THREE.Mesh;
  private beamMat: THREE.MeshBasicMaterial;
  /** Per-pylon hit dip: the glow browns out briefly on every hit. */
  private pylonDip = new Map<Pylon, number>();

  constructor(d: Level2Deps) {
    this.d = d;

    // Flashlight: a single spotlight riding on the camera (exists from
    // the start; toggling only fades its intensity — the light count
    // never changes). No shadows: the shadow map is frozen by design.
    this.flashlight = new THREE.SpotLight(0xfff0d6, 0, 46, 0.46, 0.55, 1.25);
    this.flashlight.position.set(0.22, -0.28, 0.1);
    d.camera.add(this.flashlight);
    const target = new THREE.Object3D();
    target.position.set(0, -0.15, -10);
    d.camera.add(target);
    this.flashlight.target = target;

    // Fake volumetric beam: an open additive cone fading along its length.
    this.beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff0d6,
      alphaMap: beamTexture(),
      transparent: true,
      opacity: 0.045,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const coneLen = 13;
    const cone = new THREE.ConeGeometry(2.4, coneLen, 24, 1, true);
    // Apex (+y) onto +z at the lens, opening toward -z (view direction).
    cone.rotateX(Math.PI / 2);
    cone.translate(0, 0, -coneLen / 2);
    this.beam = new THREE.Mesh(cone, this.beamMat);
    this.beam.position.set(0.22, -0.28, 0.1);
    this.beam.frustumCulled = false;
    d.camera.add(this.beam);

    document.addEventListener("keydown", (e) => {
      if (e.code === "KeyF" && !e.repeat) {
        this.flashOn = !this.flashOn;
        d.audio.empty(); // dry switch click
      }
    });
  }

  /** Fresh run of the level. */
  reset(): void {
    this.stage = 0;
    this.time = 0;
    this.blackoutTimer = -1;
    this.laserAngle = 0;
    this.laserCooldown = 0;
    this.holdTimer = HOLDOUT_TIME;
    this.spawnTimer = 0;
    this.flashOn = true;
    this.d.world.resetPlot();
  }

  get objective(): string {
    switch (this.stage) {
      case 0:
        return "Slot the core cell into the lift's power bay [E wall]";
      case 1:
        return "Reach the MYTHOS vault through the flooded tunnels [N]";
      case 2: {
        const down = this.d.world.pylons.filter((p) => !p.alive).length;
        return `Destroy the relay pylons (${down}/3). The Warden's shield blocks shots from the front`;
      }
      case 3:
        return "MYTHOS is offline. Get back to the freight lift [S]";
      default: {
        const t = Math.ceil(this.holdTimer);
        const clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
        const onLift = this.d.world.zoneOf(this.d.player.position) === UV_ZONES.lift;
        return onLift ? `Hold the lift while it spins up: ${clock}` : `Get back to the lift! ${clock}`;
      }
    }
  }

  /** Composition of regular wave `n` (Game spawns them as before). */
  waveKinds(wave: number): EnemyKind[] {
    const kinds: EnemyKind[] = [];
    const stalkers = 2 + wave;
    const sentinels = 1 + Math.floor(wave / 2);
    const brutes = wave >= 3 ? Math.floor((wave - 1) / 2) : 0;
    for (let i = 0; i < stalkers; i++) kinds.push("stalker");
    for (let i = 0; i < sentinels; i++) kinds.push("sentinel");
    for (let i = 0; i < brutes; i++) kinds.push("brute");
    return kinds;
  }

  /**
   * A bullet hit world geometry at `p`. Returns true if it struck a
   * relay pylon (so Game can show the hitmarker).
   */
  onWorldHit(p: THREE.Vector3, damage: number): boolean {
    const py = this.d.world.pylonAt(p);
    if (!py) return false;
    py.health -= damage;
    this.pylonDip.set(py, 0.09);
    this.d.effects.burst(p, 10, _violet.setHex(0xe8d0ff), 6, 0.3, false);
    if (py.health <= 0) {
      py.alive = false;
      py.crown.visible = false;
      py.light.intensity = 0;
      py.conduitMat.color.setHex(0x1a1024);
      const at = new THREE.Vector3(py.x, 5.6, py.z);
      this.d.effects.burst(at, 60, _violet.setHex(0xd8b0ff), 10, 0.9);
      this.d.effects.burst(at, 30, _violet.setHex(0xffffff), 6, 0.5);
      this.d.audio.pylonDown(py.x, py.z);
      this.d.addScore(750);
      const alive = this.d.world.pylons.filter((q) => q.alive).length;
      this.d.world.setMythos(alive / 3);
      if (alive > 0) {
        this.d.hud.announce(`RELAY DOWN (${3 - alive}/3)`, "The sweep is speeding up");
      } else {
        this.mythosOffline();
      }
    }
    return true;
  }

  update(dt: number): void {
    this.time += dt;
    const { world, player, hud } = this.d;
    const p = player.position;

    if (this.stage === 0) {
      const dx = world.bayPos.x - p.x;
      const dz = world.bayPos.z - p.z;
      if (this.blackoutTimer < 0 && dx * dx + dz * dz < 2.6 * 2.6) {
        world.setCellInserted(true);
        this.d.audio.pickup();
        this.d.addScore(500);
        hud.announce("CORE CELL SLOTTED", "Lift power restored...");
        this.blackoutTimer = 1.6;
      }
      if (this.blackoutTimer > 0) {
        this.blackoutTimer -= dt;
        if (this.blackoutTimer <= 0) this.blackout();
      }
    } else if (this.stage === 1) {
      if (world.zoneOf(p) === UV_ZONES.vault) this.wakeWarden();
    } else if (this.stage === 3) {
      if (world.onLift(p)) this.startHoldout();
    } else if (this.stage === 4) {
      this.updateHoldout(dt);
    }

    this.updateVents(dt);
    this.updateLaser(dt);
    this.updateFlashlight(dt);
    this.updatePylonGlow(dt);
    hud.setObjective(this.objective);
  }

  // ------------------------------------------------------------ beats

  private blackout(): void {
    const { world, audio, hud } = this.d;
    world.setPower(0);
    audio.blackout();
    world.unlockTag("tunnels");
    this.stage = 1;
    this.flashFlicker = 0.6;
    hud.announce("MYTHOS HAS CUT THE POWER", "Lift locked out. Shut MYTHOS down in the vault");
  }

  private wakeWarden(): void {
    const { enemies, audio, hud, player } = this.d;
    this.stage = 2;
    const x = VAULT_CENTER.x;
    const z = VAULT_CENTER.z - 8;
    enemies.spawnAt("warden", x, z, UV_ZONES.vault, player.position);
    audio.wardenRoar(x, z);
    this.flashFlicker = 0.8;
    hud.announce("THE WARDEN WAKES", "Hit it from behind, or while its shield is up");
  }

  private mythosOffline(): void {
    const { world, audio, hud, enemies, player } = this.d;
    this.stage = 3;
    world.laser.visible = false;
    world.setMythos(0);
    world.setPower(0.4); // backup generators kick in
    audio.blackout();
    enemies.alertAll(player.position);
    this.d.addScore(1500);
    hud.announce("MYTHOS OFFLINE", "Backup power only. Get back to the lift");
  }

  private startHoldout(): void {
    const { world, audio, hud } = this.d;
    this.stage = 4;
    this.holdTimer = HOLDOUT_TIME;
    this.spawnTimer = 1;
    world.setLiftLamp(true);
    audio.liftStart();
    audio.alarm();
    hud.announce("LIFT SPINNING UP", `Hold out for ${HOLDOUT_TIME} seconds`);
  }

  private updateHoldout(dt: number): void {
    const { world, enemies, player } = this.d;
    // The beacon swings like a rotating amber lamp.
    world.liftBeacon.intensity = 18 + 16 * Math.sin(this.time * 7);
    // The countdown only runs while you're in the lift hall.
    if (world.zoneOf(player.position) === UV_ZONES.lift) this.holdTimer -= dt;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && enemies.aliveCount < HOLDOUT_MAX_ALIVE) {
      this.spawnTimer = HOLDOUT_SPAWN_EVERY;
      // Reinforcements pour out of both tunnel mouths, already hunting.
      const kinds: EnemyKind[] = ["stalker", "stalker", "sentinel", Math.random() < 0.5 ? "brute" : "stalker"];
      kinds.forEach((kind, i) => {
        const zone = i % 2 === 0 ? UV_ZONES.culvertS : UV_ZONES.pumps;
        const spots = world.spawnSpots[zone];
        const [x, z] = spots[Math.floor(Math.random() * spots.length)];
        enemies.spawnAt(kind, x, z, zone, player.position);
      });
    }
    if (this.holdTimer <= 0) {
      this.stage = 5;
      this.d.audio.liftStart();
      this.d.onWin();
    }
  }

  // ------------------------------------------------------------ hazards

  private updateVents(dt: number): void {
    const { world, player, effects, audio } = this.d;
    const p = player.position;
    this.ventTick -= dt;
    for (const v of world.vents) {
      const t = (this.time + v.phase) % v.period;
      const stage = t > v.period - VENT_BLAST ? 2 : t > v.period - VENT_BLAST - VENT_WARN ? 1 : 0;
      if (stage !== v.stage) {
        if (stage === 1) audio.steam(v.x, v.z, false);
        if (stage === 2) audio.steam(v.x, v.z, true);
        v.stage = stage;
      }
      // Ember glow brightens through the warning and flares on the blast.
      const heat = stage === 0 ? 0 : stage === 1 ? (t - (v.period - VENT_BLAST - VENT_WARN)) / VENT_WARN : 1;
      v.glowMat.color.setRGB(0.25 + 0.75 * heat, 0.07 + 0.3 * heat, 0.02 + 0.06 * heat);
      if (stage !== 2) continue;
      const dx = v.x - p.x;
      const dz = v.z - p.z;
      const dSq = dx * dx + dz * dz;
      // Steam column (only spend particles when someone could see it).
      if (dSq < 45 * 45) {
        for (let k = 0; k < 3; k++) {
          _at.set(v.x + (Math.random() - 0.5) * 1.2, 0.4 + Math.random() * 3.2, v.z + (Math.random() - 0.5) * 1.2);
          effects.burst(_at, 1, _steam.setRGB(0.75, 0.78, 0.8), 1.2, 0.7, false);
        }
      }
      if (dSq < VENT_RADIUS * VENT_RADIUS && p.y < 2.6 && this.ventTick <= 0) {
        // Damage in chunks so the hurt sound doesn't fire every frame.
        player.takeDamage(VENT_DPS * 0.25);
        this.ventTick = 0.25;
      }
    }
  }

  private updateLaser(dt: number): void {
    const { world, player } = this.d;
    if (!world.laser.visible) return;
    const down = world.pylons.filter((q) => !q.alive).length;
    this.laserAngle = (this.laserAngle + dt * (0.5 + 0.22 * down)) % (Math.PI * 2);
    world.laser.rotation.y = this.laserAngle;
    world.laserMat.color.setHex(Math.sin(this.time * 30) > 0 ? 0xff2a3a : 0xff6070);

    this.laserCooldown -= dt;
    const p = player.position;
    if (!player.alive || this.laserCooldown > 0) return;
    const dx = p.x - VAULT_CENTER.x;
    const dz = p.z - VAULT_CENTER.z;
    const r = Math.hypot(dx, dz);
    if (r < LASER_R0 - 0.4 || r > LASER_R1 + 0.4) return;
    // Beam direction for rotation θ is (cos θ, 0, -sin θ).
    const phi = Math.atan2(-dz, dx);
    const diff = Math.atan2(Math.sin(phi - this.laserAngle), Math.cos(phi - this.laserAngle));
    const tolerance = 0.5 / Math.max(1, r);
    // Feet above the beam = jumped it.
    if (Math.abs(diff) < tolerance && p.y < LASER_Y + 0.1) {
      player.takeDamage(LASER_DAMAGE);
      // Knock the player along the sweep and up off the floor.
      player.velocity.x += -Math.sin(this.laserAngle) * 7;
      player.velocity.z += -Math.cos(this.laserAngle) * 7;
      player.velocity.y = 5;
      this.laserCooldown = 0.6;
      _at.set(p.x, LASER_Y, p.z);
      this.d.effects.burst(_at, 18, _steam.setHex(0xff4050), 5, 0.3);
    }
  }

  /**
   * Pylons show their damage: crown, light and conduit dim as health
   * drains, and every hit browns the glow out for a moment.
   */
  private updatePylonGlow(dt: number): void {
    for (const py of this.d.world.pylons) {
      if (!py.alive) continue;
      let dip = this.pylonDip.get(py) ?? 0;
      if (dip > 0) {
        dip -= dt;
        if (dip > 0) this.pylonDip.set(py, dip);
        else this.pylonDip.delete(py);
      }
      const frac = Math.max(0, py.health / PYLON_HEALTH);
      // Badly damaged pylons sputter on their own.
      const sputter = frac < 0.35 && Math.random() < dt * 6 ? 0.4 : 1;
      const level = (0.12 + 0.88 * frac) * (dip > 0 ? 0.2 : 1) * sputter;
      py.crownMat.color.copy(_crown).multiplyScalar(level);
      py.conduitMat.color.copy(_conduit).multiplyScalar(0.2 + 0.8 * level);
      py.light.intensity = 14 * level;
    }
  }

  private updateFlashlight(dt: number): void {
    // Rare battery stutters once the lights are out; scripted flickers
    // on big story beats.
    if (this.stage >= 1 && Math.random() < dt * 0.04) this.flashFlicker = 0.15 + Math.random() * 0.2;
    this.flashFlicker = Math.max(0, this.flashFlicker - dt);
    const flick = this.flashFlicker > 0 && Math.sin(this.time * 70) > -0.2 ? 0.08 : 1;
    const on = this.flashOn && this.d.player.alive ? flick : 0;
    this.flashlight.intensity = 140 * on;
    this.beamMat.opacity = 0.045 * on;
  }
}

const _at = new THREE.Vector3();
const _steam = new THREE.Color();
const _violet = new THREE.Color();
const _crown = new THREE.Color(0xc89bff);
const _conduit = new THREE.Color(0x8a50d0);
