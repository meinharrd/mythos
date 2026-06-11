import * as THREE from "three";
import { World } from "./World";
import { EnemyManager } from "./Enemies";
import { Player } from "./Player";
import { Effects } from "./Effects";
import { AudioFX } from "./AudioFX";
import { metalTexture, screenTexture } from "./Textures";
import type { Multiplayer } from "./Multiplayer";

export interface WeaponDef {
  name: string;
  sound: "rifle" | "shotgun" | "smg";
  damage: number;
  fireInterval: number;
  magSize: number;
  reloadTime: number;
  pellets: number;
  spread: number;
  recoil: number;
  range: number;
  auto: boolean;
}

const WEAPONS: WeaponDef[] = [
  {
    name: "PULSE RIFLE",
    sound: "rifle",
    damage: 22,
    fireInterval: 0.13,
    magSize: 30,
    reloadTime: 1.4,
    pellets: 1,
    spread: 0.012,
    recoil: 0.022,
    range: 120,
    auto: true,
  },
  {
    name: "SCATTERGUN",
    sound: "shotgun",
    damage: 12,
    fireInterval: 0.75,
    magSize: 8,
    reloadTime: 2.0,
    pellets: 8,
    spread: 0.055,
    recoil: 0.07,
    range: 45,
    auto: false,
  },
  {
    name: "VIPER SMG",
    sound: "smg",
    damage: 11,
    fireInterval: 0.06,
    magSize: 42,
    reloadTime: 1.2,
    pellets: 1,
    spread: 0.03,
    recoil: 0.01,
    range: 80,
    auto: true,
  },
];

export class WeaponSystem {
  current = 0;
  ammo: number[] = WEAPONS.map((w) => w.magSize);
  reloading = false;
  private reloadTimer = 0;
  private cooldown = 0;
  private triggerHeld = false;

  private camera: THREE.PerspectiveCamera;
  private world: World;
  private enemies: EnemyManager;
  private player: Player;
  private effects: Effects;
  private audio: AudioFX;

  private viewmodel: THREE.Group;
  private barrel!: THREE.Mesh;
  private glow!: THREE.Mesh;
  private muzzleLight: THREE.PointLight;
  private vmFlash: THREE.PointLight;
  private kick = 0;
  private swayTime = 0;

  onHit: () => void = () => {};
  /** Set by Game in arena mode; shots then also hit remote players. */
  mp: Multiplayer | null = null;

  constructor(
    camera: THREE.PerspectiveCamera,
    vmScene: THREE.Scene,
    world: World,
    enemies: EnemyManager,
    player: Player,
    effects: Effects,
    audio: AudioFX
  ) {
    this.camera = camera;
    this.world = world;
    this.enemies = enemies;
    this.player = player;
    this.effects = effects;
    this.audio = audio;

    // The viewmodel renders in its own depth-cleared pass (see Game) so
    // it never clips through world geometry. Its camera sits at the
    // origin, so the camera-local offsets below work unchanged.
    this.viewmodel = this.buildViewmodel();
    vmScene.add(this.viewmodel);

    // World-scene flash lights the surroundings; the vmScene twin
    // lights the gun itself.
    this.muzzleLight = new THREE.PointLight(0x9fe8ff, 0, 8, 2);
    this.muzzleLight.position.set(0.28, -0.22, -1.1);
    camera.add(this.muzzleLight);
    this.vmFlash = new THREE.PointLight(0x9fe8ff, 0, 8, 2);
    this.vmFlash.position.set(0.28, -0.22, -1.1);
    vmScene.add(this.vmFlash);

    document.addEventListener("mousedown", (e) => {
      if (e.button === 0 && document.pointerLockElement !== null) this.triggerHeld = true;
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.triggerHeld = false;
    });
    document.addEventListener("keydown", (e) => {
      if (e.code === "KeyR") this.startReload();
      if (e.code === "Digit1") this.switchTo(0);
      if (e.code === "Digit2") this.switchTo(1);
      if (e.code === "Digit3") this.switchTo(2);
    });
  }

  private buildViewmodel(): THREE.Group {
    const g = new THREE.Group();
    const metal = metalTexture();
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x4a6390,
      roughness: 0.45,
      metalness: 0.3,
      map: metal,
      emissive: 0x24365a,
      emissiveMap: metal,
      emissiveIntensity: 0.9,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x2c3c5c,
      roughness: 0.55,
      metalness: 0.25,
      map: metal,
      emissive: 0x18253c,
      emissiveMap: metal,
      emissiveIntensity: 0.9,
    });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x4fd9ff });

    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.5), bodyMat);
    receiver.position.set(0, 0, 0.1);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.16), darkMat);
    stock.position.set(0, -0.015, 0.41);

    // Round barrel with shroud rings and a glowing muzzle core.
    this.barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.5, 12), darkMat);
    this.barrel.rotation.x = Math.PI / 2;
    this.barrel.position.set(0, 0.02, -0.36);
    const ringGeo = new THREE.CylinderGeometry(0.036, 0.036, 0.022, 12);
    for (const z of [-0.2, -0.32, -0.44]) {
      const ring = new THREE.Mesh(ringGeo, bodyMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(0, 0.02, z);
      g.add(ring);
    }
    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.06, 12), darkMat);
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, 0.02, -0.59);
    const muzzleCore = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.065, 10), glowMat);
    muzzleCore.rotation.x = Math.PI / 2;
    muzzleCore.position.set(0, 0.02, -0.59);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.09), darkMat);
    grip.position.set(0, -0.13, 0.22);
    grip.rotation.x = 0.3;
    // Rounded trigger guard.
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.007, 6, 12, Math.PI), darkMat);
    guard.rotation.set(0, Math.PI / 2, Math.PI);
    guard.position.set(0, -0.065, 0.13);

    // Angled magazine with a baseplate.
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.1), bodyMat);
    mag.position.set(0, -0.15, -0.04);
    mag.rotation.x = 0.12;
    const magBase = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.022, 0.108), darkMat);
    magBase.position.set(0, -0.232, -0.052);
    magBase.rotation.x = 0.12;

    this.glow = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.02, 0.3), glowMat);
    this.glow.position.set(0, 0.045, 0.05);

    // Top rail with notches, ring rear sight and a front post.
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.014, 0.36), darkMat);
    rail.position.set(0, 0.082, -0.02);
    for (let i = 0; i < 5; i++) {
      const notch = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.012, 0.024), bodyMat);
      notch.position.set(0, 0.09, -0.17 + i * 0.075);
      g.add(notch);
    }
    const rearSight = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.005, 6, 12), darkMat);
    rearSight.position.set(0, 0.115, 0.16);
    const frontPost = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.05, 0.008), darkMat);
    frontPost.position.set(0, 0.07, -0.55);

    // Side screws and a tiny status screen facing the shooter.
    const screwGeo = new THREE.CylinderGeometry(0.007, 0.007, 0.096, 8);
    for (const [y, z] of [
      [0.04, 0.3],
      [-0.01, 0.02],
      [0.04, -0.08],
    ]) {
      const screw = new THREE.Mesh(screwGeo, darkMat);
      screw.rotation.z = Math.PI / 2;
      screw.position.set(0, y, z);
      g.add(screw);
    }
    const screenMat = new THREE.MeshBasicMaterial({ map: screenTexture() });
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.04, 0.08), [
      darkMat,
      screenMat,
      darkMat,
      darkMat,
      darkMat,
      darkMat,
    ]);
    // Keep the inner face clear of the receiver's side (x = -0.045) or the
    // two coplanar surfaces z-fight at this close camera range.
    screen.position.set(-0.0515, 0.025, 0.16);

    g.add(
      receiver,
      stock,
      this.barrel,
      muzzle,
      muzzleCore,
      grip,
      guard,
      mag,
      magBase,
      this.glow,
      rail,
      rearSight,
      frontPost,
      screen
    );
    g.position.set(0.28, -0.24, -0.55);
    g.rotation.y = 0.04;
    return g;
  }

  get def(): WeaponDef {
    return WEAPONS[this.current];
  }

  reset(): void {
    this.current = 0;
    this.ammo = WEAPONS.map((w) => w.magSize);
    this.reloading = false;
    this.cooldown = 0;
    this.triggerHeld = false;
  }

  /** Touch fire button; mouse uses the pointer-lock listeners above. */
  setTrigger(held: boolean): void {
    this.triggerHeld = held;
  }

  /** Touch weapon button cycles through the arsenal. */
  cycleWeapon(): void {
    this.switchTo((this.current + 1) % WEAPONS.length);
  }

  private switchTo(index: number): void {
    if (index === this.current || !this.player.alive) return;
    this.current = index;
    this.reloading = false;
    this.cooldown = 0.25;
    this.kick = 0.6;
    const glowColors = [0x4fd9ff, 0xffa040, 0x9dff4f];
    (this.glow.material as THREE.MeshBasicMaterial).color.setHex(glowColors[index]);
  }

  startReload(): void {
    if (this.reloading || this.ammo[this.current] === this.def.magSize || !this.player.alive) return;
    this.reloading = true;
    this.reloadTimer = this.def.reloadTime;
    this.audio.reload();
  }

  update(dt: number): void {
    this.cooldown -= dt;
    this.kick = Math.max(0, this.kick - dt * 7);
    this.swayTime += dt;
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 220);
    this.vmFlash.intensity = this.muzzleLight.intensity;

    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloading = false;
        this.ammo[this.current] = this.def.magSize;
      }
    }

    if (this.triggerHeld && this.player.alive && !this.reloading && this.cooldown <= 0) {
      if (this.ammo[this.current] > 0) {
        this.fire();
        if (!this.def.auto) this.triggerHeld = false;
      } else {
        this.audio.empty();
        this.startReload();
        this.triggerHeld = this.def.auto && this.triggerHeld;
        this.cooldown = 0.3;
      }
    }

    // Viewmodel animation: sway + recoil kick + reload dip.
    const sway = Math.sin(this.swayTime * 1.7) * 0.004;
    const reloadDip = this.reloading
      ? Math.sin((1 - this.reloadTimer / this.def.reloadTime) * Math.PI) * 0.18
      : 0;
    this.viewmodel.position.set(
      0.28 + sway,
      -0.24 + Math.cos(this.swayTime * 2.3) * 0.003 - reloadDip,
      -0.55 + this.kick * 0.07
    );
    this.viewmodel.rotation.x = this.kick * 0.12 - reloadDip * 1.2;
  }

  private fire(): void {
    const def = this.def;
    this.ammo[this.current]--;
    this.cooldown = def.fireInterval;
    this.kick = 1;
    this.player.recoilPitch += def.recoil;
    this.muzzleLight.intensity = 30;
    this.vmFlash.intensity = 30;
    this.audio.shoot(def.sound);
    // Gunfire is loud: every robot in earshot starts hunting.
    this.enemies.alertFromSound(this.player.position, 32);

    const origin = this.player.eyePosition;
    _muzzle.set(0.28, -0.26, -1.0).applyMatrix4(this.camera.matrixWorld);

    for (let i = 0; i < def.pellets; i++) {
      this.camera.getWorldDirection(_dir);
      _dir.x += (Math.random() - 0.5) * 2 * def.spread;
      _dir.y += (Math.random() - 0.5) * 2 * def.spread;
      _dir.z += (Math.random() - 0.5) * 2 * def.spread;
      _dir.normalize();
      if (i === 0 && this.mp) this.mp.localShot(_dir);

      const worldDist = this.world.raycast(origin, _dir, def.range);
      const enemyHit = this.enemies.raycast(origin, _dir, Math.min(worldDist, def.range));
      const playerHit = this.mp
        ? this.mp.raycastPlayers(origin, _dir, Math.min(worldDist, def.range))
        : null;

      let endDist = Math.min(worldDist, def.range);
      if (playerHit && (!enemyHit || playerHit.dist < enemyHit.dist)) {
        endDist = playerHit.dist;
        _hitPoint.copy(origin).addScaledVector(_dir, endDist);
        this.mp!.dealDamage(playerHit.id, def.damage);
        _normalHint.copy(_dir).multiplyScalar(-1);
        this.effects.impact(_hitPoint, _normalHint);
        this.audio.hit();
        this.onHit();
      } else if (enemyHit) {
        endDist = enemyHit.dist;
        _hitPoint.copy(origin).addScaledVector(_dir, endDist);
        this.enemies.damage(enemyHit.enemy, def.damage, _hitPoint, this.player.position);
        this.audio.hit();
        this.onHit();
      } else if (worldDist < def.range) {
        _hitPoint.copy(origin).addScaledVector(_dir, worldDist);
        _normalHint.copy(_dir).multiplyScalar(-1);
        this.effects.impact(_hitPoint, _normalHint);
      }

      _end.copy(origin).addScaledVector(_dir, endDist);
      this.effects.tracer(_muzzle, _end);
    }
  }
}

const _dir = new THREE.Vector3();
const _end = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _normalHint = new THREE.Vector3();
