import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { World, worldUVBox, coverUVBox, DOOR_HEIGHT } from "./World";
import {
  concreteTexture,
  grateTexture,
  hazardTexture,
  waterNormalTexture,
  floorTexture,
  crateTexture,
  metalTexture,
  pillarTexture,
} from "./Textures";

/**
 * Level 2: the Undervault, the flooded undercroft beneath the facility
 * where MYTHOS lives. Layout (north = -z, the way the player faces at
 * spawn):
 *
 *   vault (5)            MYTHOS core, 3 relay pylons, sweeping laser
 *   ───D──────────D───   z = -59
 *   culvert   |  pump
 *   N (3)     |  gallery (4)   flooded; catwalks over the pumps
 *   M (2)  S-route | (divider)
 *   S (1)     |
 *   ───D────────D─────   z = -12.5 (locked until lift power is restored)
 *        lift hall (0)    freight lift + power bay; spawn and finale
 *
 * Geometry and gameplay data only: the Level2 director (Level2.ts)
 * drives the plot, hazards and lighting changes.
 */

export const UV_ZONES = {
  lift: 0,
  culvertS: 1,
  culvertM: 2,
  culvertN: 3,
  pumps: 4,
  vault: 5,
} as const;
const UV_ZONE_COUNT = 6;

const UV_ZONE_RECTS: Array<[number, number, number, number]> = [
  [-13, 13, -11, 11], // lift hall
  [-33, -5, -26, -14], // culvert south
  [-33, -5, -42, -28], // culvert middle
  [-33, -5, -57, -44], // culvert north
  [5, 33, -57, -14], // pump gallery
  [-29, 29, -95, -61], // vault
];

/** Wall height: pokes through the ceiling plane so tops never z-fight it. */
const H = 8.4;
const CEIL = 8;
/** Water surface height in the flooded tunnels. */
export const WATER_Y = 0.55;
/** Catwalk deck height in the pump gallery. */
const CATWALK_Y = 3;
/** The sweeping vault laser: center, reach and beam height. */
export const VAULT_CENTER = new THREE.Vector3(0, 0, -80);
export const LASER_R0 = 3.4;
export const LASER_R1 = 12.5;
export const LASER_Y = 0.75;

export interface Vent {
  x: number;
  z: number;
  /** Seconds per cycle and offset into it. */
  period: number;
  phase: number;
  /** Ember glow under the grate, brightened before a blast. */
  glowMat: THREE.MeshBasicMaterial;
  /** Last cycle stage, so sounds fire once per transition. */
  stage: number;
}

export interface Pylon {
  x: number;
  z: number;
  health: number;
  alive: boolean;
  /** Bullet hit test volume (slightly larger than the obstacle). */
  box: THREE.Box3;
  light: THREE.PointLight;
  crown: THREE.Mesh;
  crownMat: THREE.MeshBasicMaterial;
  conduitMat: THREE.MeshBasicMaterial;
}

/** A light that dims when MYTHOS cuts the power (blackout). */
interface MainsLight {
  light: THREE.PointLight;
  base: number;
}

export class Undervault extends World {
  readonly vents: Vent[] = [];
  readonly pylons: Pylon[] = [];
  /** Rotating group holding the laser beam (rotation.y = sweep angle). */
  readonly laser = new THREE.Group();
  readonly laserMat: THREE.MeshBasicMaterial;
  /** Power bay socket where the core cell goes. */
  readonly bayPos = new THREE.Vector3(11.6, 0, -4);
  readonly bayLight: THREE.PointLight;
  private bayCell!: THREE.Group;
  private baySocketMat: THREE.MeshBasicMaterial;
  /** Freight lift platform: center and half-size (square). */
  readonly liftCenter = new THREE.Vector3(0, 0, 5);
  readonly liftHalf = 4.5;
  readonly liftBeacon: THREE.PointLight;
  private liftLampMat: THREE.MeshBasicMaterial;
  /** MYTHOS core: light and glowing parts, dimmed as pylons fall. */
  readonly coreLight: THREE.PointLight;
  private coreMats: Array<{ mat: THREE.MeshBasicMaterial; base: THREE.Color }> = [];
  private mains: MainsLight[] = [];
  private emergency: THREE.PointLight[] = [];
  /** Glowing fixtures (light panels, trims) that go dark with the mains. */
  private fixtures: Array<{ mat: THREE.MeshBasicMaterial; base: THREE.Color }> = [];
  private power = 1;
  private powerTarget = 1;
  private mythos = 1;
  private waterNormal: THREE.Texture;

  constructor() {
    super(false, false);
    this.ceilingY = CEIL;
    this.scene.background = new THREE.Color(0x020305);
    this.fog.color.setHex(0x04070a);
    this.fog.density = 0.03;

    this.bounds.minX = -34;
    this.bounds.maxX = 34;
    this.bounds.minZ = -96;
    this.bounds.maxZ = 11.5;

    this.laserMat = new THREE.MeshBasicMaterial({ color: 0xff2a3a });
    this.baySocketMat = new THREE.MeshBasicMaterial({ color: 0x1a4a2c });
    this.liftLampMat = new THREE.MeshBasicMaterial({ color: 0x3a2a10 });
    this.waterNormal = waterNormalTexture();

    // Lights first: their count must never change after this.
    this.hemi = new THREE.HemisphereLight(0x5a6a80, 0x10141a, 0.55);
    this.scene.add(this.hemi);
    const mains = (color: number, i: number, range: number, x: number, y: number, z: number): THREE.PointLight => {
      const l = new THREE.PointLight(color, i, range, 1.6);
      l.position.set(x, y, z);
      this.scene.add(l);
      this.mains.push({ light: l, base: i });
      return l;
    };
    mains(0xcfe4ff, 45, 24, -7, 6.5, -3); // lift hall work lights
    mains(0xcfe4ff, 45, 24, 7, 6.5, 6);
    mains(0xffa040, 40, 28, 15, 5.5, -24); // pump gallery sodium lamps
    mains(0xffa040, 40, 28, 23, 5.5, -47);
    mains(0x8fb3e6, 22, 22, -10, 5.5, -76); // vault service lights
    mains(0x8fb3e6, 22, 22, 10, 5.5, -86);
    for (const [x, z] of [
      [-21, -20],
      [-26, -36],
      [-15, -51],
    ]) {
      const l = new THREE.PointLight(0xff3a2a, 16, 18, 1.6);
      l.position.set(x, 5.5, z);
      this.scene.add(l);
      this.emergency.push(l);
    }
    this.bayLight = new THREE.PointLight(0x57ff9a, 5, 9, 1.8);
    this.bayLight.position.set(this.bayPos.x - 0.8, 1.6, this.bayPos.z);
    this.scene.add(this.bayLight);
    this.coreLight = new THREE.PointLight(0x4fd9ff, 70, 42, 1.5);
    this.coreLight.position.set(VAULT_CENTER.x, 5, VAULT_CENTER.z);
    this.scene.add(this.coreLight);
    this.liftBeacon = new THREE.PointLight(0xffb030, 0, 22, 1.6);
    this.liftBeacon.position.set(this.liftCenter.x, 7, this.liftCenter.z);
    this.scene.add(this.liftBeacon);

    this.buildShell();
    this.buildDoorsUV();
    this.buildWater();
    this.buildLiftHall();
    this.buildCulvert();
    this.buildPumpGallery();
    this.buildVault();
    this.buildSpawnSpotsUV();
  }

  // ------------------------------------------------------------ queries

  zoneOf(p: THREE.Vector3): number {
    if (p.z > -12.5) return UV_ZONES.lift;
    if (p.z < -59) return UV_ZONES.vault;
    if (p.x < 0) {
      if (p.z > -27) return UV_ZONES.culvertS;
      return p.z > -43 ? UV_ZONES.culvertM : UV_ZONES.culvertN;
    }
    return UV_ZONES.pumps;
  }

  zoneRect(zone: number): [number, number, number, number] {
    return UV_ZONE_RECTS[zone];
  }

  protected hasCeiling(): boolean {
    return true; // all underground
  }

  isWater(x: number, z: number): boolean {
    return z < -12.5 && z > -59 && Math.abs(x) > 4;
  }

  /** Wading through the flooded tunnels: 60% speed. */
  moveMultiplier(pos: THREE.Vector3): number {
    return pos.y < WATER_Y - 0.1 && this.isWater(pos.x, pos.z) ? 0.6 : 1;
  }

  /** Player standing on the freight lift platform. */
  onLift(p: THREE.Vector3): boolean {
    return (
      Math.abs(p.x - this.liftCenter.x) < this.liftHalf &&
      Math.abs(p.z - this.liftCenter.z) < this.liftHalf
    );
  }

  /** Pylon whose hit volume contains `p`, if any (bullets). */
  pylonAt(p: THREE.Vector3): Pylon | null {
    for (const py of this.pylons) if (py.alive && py.box.containsPoint(p)) return py;
    return null;
  }

  // ------------------------------------------------------------ state

  /** Restart: lights on, pylons up, core dark, doors relocked. */
  resetPlot(): void {
    for (const d of this.doors) d.relock();
    this.power = this.powerTarget = 1;
    this.applyPower();
    this.setMythos(1);
    this.liftBeacon.intensity = 0;
    this.liftLampMat.color.setHex(0x3a2a10);
    this.setCellInserted(false);
    for (const p of this.pylons) {
      p.health = PYLON_HEALTH;
      p.alive = true;
      p.crown.visible = true;
    }
    this.laser.visible = true;
  }

  /** Fade the mains (and their fixtures) toward `level` (0..1). */
  setPower(level: number): void {
    this.powerTarget = level;
  }

  /** MYTHOS core brightness: 1 = all pylons feeding it, 0 = dead. */
  setMythos(level: number): void {
    this.mythos = level;
    this.coreLight.intensity = 10 + 60 * level;
    for (const { mat, base } of this.coreMats) mat.color.copy(base).multiplyScalar(0.15 + 0.85 * level);
  }

  setCellInserted(on: boolean): void {
    this.bayCell.visible = on;
    this.baySocketMat.color.setHex(on ? 0x57ff9a : 0x1a4a2c);
    this.bayLight.intensity = on ? 16 : 5;
  }

  /** Amber lift lamp + beacon: on while the lift spins up. */
  setLiftLamp(on: boolean): void {
    this.liftLampMat.color.setHex(on ? 0xffb030 : 0x3a2a10);
  }

  update(dt: number, isAgentNear: (x: number, z: number, radius: number) => boolean): void {
    this.time += dt;
    this.updateDoors(dt, isAgentNear);
    // Slow ripple drift on the standing water.
    this.waterNormal.offset.set(this.time * 0.012, this.time * 0.007);
    // Emergency lamps breathe red; the mains ease toward their target.
    const pulse = 0.75 + 0.25 * Math.sin(this.time * 2.2);
    for (const l of this.emergency) l.intensity = 16 * pulse;
    if (this.power !== this.powerTarget) {
      const step = dt * (this.powerTarget < this.power ? 1.6 : 0.8);
      this.power =
        this.power < this.powerTarget
          ? Math.min(this.powerTarget, this.power + step)
          : Math.max(this.powerTarget, this.power - step);
      this.applyPower();
    }
    // MYTHOS core: a slow, unsettling heartbeat.
    if (this.mythos > 0) {
      const beat = Math.pow(Math.max(0, Math.sin(this.time * 1.7)), 8);
      this.coreLight.intensity = (10 + 60 * this.mythos) * (0.8 + 0.4 * beat);
    }
  }

  private applyPower(): void {
    // A dying-fluorescent stutter while the power drains away.
    const stutter = this.power > 0.05 && this.power < 0.95 && Math.random() < 0.3 ? 0.3 : 1;
    const f = this.power * stutter;
    for (const m of this.mains) m.light.intensity = m.base * Math.max(0.04, f);
    this.hemi.intensity = 0.12 + 0.43 * f;
    for (const { mat, base } of this.fixtures) mat.color.copy(base).multiplyScalar(0.06 + 0.94 * f);
  }

  // ------------------------------------------------------------ building

  private fixture(color: number): THREE.MeshBasicMaterial {
    const mat = new THREE.MeshBasicMaterial({ color });
    this.fixtures.push({ mat, base: mat.color.clone() });
    return mat;
  }

  private buildShell(): void {
    const DH = DOOR_HEIGHT;
    const wallMat = new THREE.MeshStandardMaterial({
      map: concreteTexture(),
      roughness: 0.92,
      metalness: 0.05,
    });
    // cx, cz, sx, sz, y0, y1
    const segs: Array<[number, number, number, number, number, number]> = [
      // Lift hall.
      [-14.5, 0, 1, 25, 0, H],
      [14.5, 0, 1, 25, 0, H],
      [0, 12.5, 30, 1, 0, H],
      // Tunnel south wall (z -12.5) with doors at x = -8 and 8.
      [-22.75, -12.5, 24.5, 1, 0, H],
      [0, -12.5, 11, 1, 0, H],
      [22.75, -12.5, 24.5, 1, 0, H],
      [-8, -12.5, 5, 1, DH, H],
      [8, -12.5, 5, 1, DH, H],
      // Tunnel outer walls and the rock divider between the two routes.
      [-35, -36, 1, 47, 0, H],
      [35, -36, 1, 47, 0, H],
      [0, -35.75, 8, 45.5, 0, H],
      // Culvert baffles: an S-route (gap east at z -27, west at z -43).
      [-24.5, -27, 21, 1, 0, H],
      [-14, -43, 20, 1, 0, H],
      // Vault south wall (z -59) with doors at x = -19 and 19.
      [-28.25, -59, 13.5, 1, 0, H],
      [0, -59, 33, 1, 0, H],
      [28.25, -59, 13.5, 1, 0, H],
      [-19, -59, 5, 1, DH, H],
      [19, -59, 5, 1, DH, H],
      // Vault shell.
      [-31, -78.25, 1, 37.5, 0, H],
      [31, -78.25, 1, 37.5, 0, H],
      [0, -97, 63, 1, 0, H],
    ];
    const geos = segs.map(([cx, cz, sx, sz, y0, y1]) => {
      const g = worldUVBox(sx, y1 - y0, sz, H);
      g.translate(cx, (y0 + y1) / 2, cz);
      this.addObstacleBoxAt(cx, cz, sx, sz, y0, y1);
      return g;
    });
    const walls = new THREE.Mesh(mergeGeometries(geos), wallMat);
    for (const g of geos) g.dispose();
    walls.receiveShadow = true;
    this.scene.add(walls);

    // Floors: steel deck in the lift hall, silted concrete in the tunnels,
    // polished black stone in the vault. Planes abut, never overlap.
    const deckMap = floorTexture(7);
    deckMap.repeat.set(7, 6);
    const floors: Array<[THREE.Material, number, number, number, number]> = [
      [
        new THREE.MeshStandardMaterial({ map: deckMap, color: 0x8a919c, roughness: 0.8, metalness: 0.4 }),
        0,
        0,
        30,
        25,
      ],
      [new THREE.MeshStandardMaterial({ color: 0x1c2420, roughness: 1, metalness: 0 }), 0, -35.75, 70, 46.5],
      [
        new THREE.MeshStandardMaterial({ color: 0x0c0f14, roughness: 0.25, metalness: 0.6 }),
        0,
        -78.25,
        62,
        37.5,
      ],
    ];
    for (const [mat, cx, cz, w, d] of floors) {
      const f = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
      f.rotation.x = -Math.PI / 2;
      f.position.set(cx, 0, cz);
      f.receiveShadow = true;
      this.scene.add(f);
    }

    // One ceiling over everything, with a few dim strip lights.
    const ceilMat = new THREE.MeshStandardMaterial({ color: 0x15191e, roughness: 0.95, metalness: 0.1 });
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(72, 110), ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(0, CEIL, -42);
    this.scene.add(ceil);
    const stripMat = this.fixture(0xbfd8f0);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const strips: Array<[number, number, number, number]> = [
      [-7, -3, 0.5, 6],
      [7, 6, 0.5, 6],
      [-10, -76, 0.5, 8],
      [10, -86, 0.5, 8],
    ];
    for (const [x, z, sx, sz] of strips) {
      const s = new THREE.Mesh(box, stripMat);
      s.scale.set(sx, 0.12, sz);
      s.position.set(x, CEIL - 0.08, z);
      this.scene.add(s);
    }
    const sodium = this.fixture(0xffb060);
    for (const [x, z] of [
      [15, -24],
      [23, -47],
    ]) {
      const s = new THREE.Mesh(box, sodium);
      s.scale.set(1.2, 0.25, 0.6);
      s.position.set(x, 5.9, z);
      this.scene.add(s);
    }
    // Emergency cages: red bulbs that never go dark.
    const redMat = new THREE.MeshBasicMaterial({ color: 0xff4030 });
    for (const l of this.emergency) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), redMat);
      b.position.copy(l.position);
      this.scene.add(b);
    }
  }

  private buildDoorsUV(): void {
    const panelMap = metalTexture();
    const panelMat = new THREE.MeshStandardMaterial({
      map: panelMap,
      color: 0x4a5566,
      roughness: 0.5,
      metalness: 0.6,
      emissive: 0x1a2230,
      emissiveMap: panelMap,
      emissiveIntensity: 0.4,
    });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const amber = 0xffb050;
    const cyan = 0x4fd9ff;
    this.addDoor({ x: -8, z: -12.5, axis: "x", a: 0, b: 1, tag: "tunnels" }, geo, panelMat, amber, 0xe89638);
    this.addDoor({ x: 8, z: -12.5, axis: "x", a: 0, b: 4, tag: "tunnels" }, geo, panelMat, amber, 0xe89638);
    this.addDoor({ x: -19, z: -59, axis: "x", a: 3, b: 5 }, geo, panelMat, cyan, 0x37c4f0);
    this.addDoor({ x: 19, z: -59, axis: "x", a: 4, b: 5 }, geo, panelMat, cyan, 0x37c4f0);
    // Open gaps in the culvert's S-route.
    this.addPortal(-9, -27, UV_ZONES.culvertS, UV_ZONES.culvertM);
    this.addPortal(-29.5, -43, UV_ZONES.culvertM, UV_ZONES.culvertN);
    this.buildRouting(UV_ZONE_COUNT);
  }

  private buildWater(): void {
    this.waterNormal.repeat.set(5, 7);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0b1a1c,
      roughness: 0.08,
      metalness: 0.2,
      normalMap: this.waterNormal,
      normalScale: new THREE.Vector2(0.35, 0.35),
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
    });
    for (const cx of [-19.5, 19.5]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(31, 46.5), mat);
      w.rotation.x = -Math.PI / 2;
      w.position.set(cx, WATER_Y, -35.75);
      w.renderOrder = 1;
      this.scene.add(w);
    }
  }

  private crate(mat: THREE.Material, cx: number, cz: number, s: number, y = 0, rot = 0): void {
    const c = new THREE.Mesh(coverUVBox(s, s, s), mat);
    c.position.set(cx, y + s / 2, cz);
    c.rotation.y = rot;
    c.castShadow = true;
    c.receiveShadow = true;
    this.scene.add(c);
    this.addObstacleBoxAt(cx, cz, s + 0.12, s + 0.12, y, y + s);
  }

  /** Horizontal pipe run along a wall (visual only, up out of reach). */
  private pipe(mat: THREE.Material, x0: number, z0: number, x1: number, z1: number, y: number, d: number): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const p = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2, len, 12), mat);
    p.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    // Cylinder axis is +y: tip it onto +z, then yaw toward the run.
    p.rotation.order = "YXZ";
    p.rotation.set(Math.PI / 2, Math.atan2(x1 - x0, z1 - z0), 0);
    this.scene.add(p);
  }

  private buildLiftHall(): void {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const steel = new THREE.MeshStandardMaterial({
      map: metalTexture(),
      color: 0x6a7280,
      roughness: 0.45,
      metalness: 0.75,
    });
    const L = this.liftCenter;
    const half = this.liftHalf;

    // Platform: a low steel slab (walkable step) with hazard edges.
    const deck = new THREE.Mesh(box, new THREE.MeshStandardMaterial({ map: grateTexture(4), roughness: 0.6, metalness: 0.7 }));
    deck.scale.set(half * 2, 0.35, half * 2);
    deck.position.set(L.x, 0.175, L.z);
    deck.receiveShadow = true;
    this.scene.add(deck);
    this.addObstacleBoxAt(L.x, L.z, half * 2, half * 2, 0, 0.35);
    const hz = new THREE.MeshStandardMaterial({ map: hazardTexture(6), roughness: 0.7 });
    for (const [x, z, sx, sz] of [
      [L.x, L.z - half - 0.2, half * 2 + 0.8, 0.4],
      [L.x, L.z + half + 0.2, half * 2 + 0.8, 0.4],
      [L.x - half - 0.2, L.z, 0.4, half * 2],
      [L.x + half + 0.2, L.z, 0.4, half * 2],
    ]) {
      const s = new THREE.Mesh(box, hz);
      s.scale.set(sx, 0.04, sz);
      s.position.set(x, 0.02, z);
      this.scene.add(s);
    }

    // Cage: four corner posts up to the ceiling, cross beams, guide rails.
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      const x = L.x + sx * (half + 0.55);
      const z = L.z + sz * (half + 0.55);
      const post = new THREE.Mesh(box, steel);
      post.scale.set(0.5, CEIL, 0.5);
      post.position.set(x, CEIL / 2, z);
      post.castShadow = true;
      this.scene.add(post);
      this.addObstacleBox(x, z, 0.5, CEIL, 0.5);
    }
    for (const sz of [-1, 1]) {
      const beam = new THREE.Mesh(box, steel);
      beam.scale.set(half * 2 + 1.6, 0.5, 0.4);
      beam.position.set(L.x, 6.2, L.z + sz * (half + 0.55));
      this.scene.add(beam);
    }
    // Hoist motor block above, with the amber spin-up lamp.
    const motor = new THREE.Mesh(box, steel);
    motor.scale.set(3, 1.2, 3);
    motor.position.set(L.x, CEIL - 0.6, L.z);
    this.scene.add(motor);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 8), this.liftLampMat);
    lamp.position.set(L.x, CEIL - 1.4, L.z);
    this.scene.add(lamp);

    // Power bay: a console set into the east wall with an empty socket.
    const bay = this.bayPos;
    const consoleMat = new THREE.MeshStandardMaterial({
      map: metalTexture(),
      color: 0x3c4656,
      roughness: 0.5,
      metalness: 0.7,
    });
    const cons = new THREE.Mesh(box, consoleMat);
    cons.scale.set(1.6, 2.6, 2.4);
    cons.position.set(bay.x + 1.4, 1.3, bay.z);
    cons.castShadow = true;
    this.scene.add(cons);
    this.addObstacleBox(bay.x + 1.4, bay.z, 1.6, 2.6, 2.4);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.06, 8, 20), this.baySocketMat);
    ring.rotation.y = Math.PI / 2;
    ring.position.set(bay.x + 0.56, 1.4, bay.z);
    this.scene.add(ring);
    const label = new THREE.Mesh(box, this.fixture(0xffb050));
    label.scale.set(0.05, 0.12, 1.2);
    label.position.set(bay.x + 0.58, 2.2, bay.z);
    this.scene.add(label);
    // The core cell, shown once slotted in.
    this.bayCell = new THREE.Group();
    const cell = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 0.5, 10),
      new THREE.MeshBasicMaterial({ color: 0x57ff9a })
    );
    cell.rotation.z = Math.PI / 2;
    this.bayCell.add(cell);
    this.bayCell.position.set(bay.x + 0.5, 1.4, bay.z);
    this.bayCell.visible = false;
    this.scene.add(this.bayCell);
    this.humSpots.push({ x: bay.x + 1, y: 1.4, z: bay.z, kind: "console" });

    // Cover: crates and cable drums around the hall.
    const crateMat = new THREE.MeshStandardMaterial({ map: crateTexture(1), roughness: 0.8, metalness: 0.2 });
    this.crate(crateMat, -10, -6, 2.2);
    this.crate(crateMat, -10, -6, 1.6, 2.2, 0.4);
    this.crate(crateMat, -7.6, -7.4, 1.8, 0, 0.3);
    this.crate(crateMat, -10.5, 8.5, 2.2, 0, 0.2);
    this.crate(crateMat, 10.4, 8.8, 2, 0, -0.3);
    this.crate(crateMat, 6.5, -8.5, 1.7, 0, 0.6);
    const drumMat = new THREE.MeshStandardMaterial({ color: 0x3a3f2a, roughness: 0.8, metalness: 0.3 });
    for (const [x, z] of [
      [-4.5, -9],
      [10.5, 1.5],
    ]) {
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1.4, 16), drumMat);
      drum.position.set(x, 0.7, z);
      drum.castShadow = true;
      this.scene.add(drum);
      this.addObstacleBox(x, z, 1.8, 1.4, 1.8);
    }
  }

  private buildCulvert(): void {
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.7, metalness: 0.6 });
    // Pipe bundles along the outer wall and the baffles.
    for (const [y, d] of [
      [5.2, 0.9],
      [6.2, 0.6],
    ]) {
      this.pipe(pipeMat, -34.2, -13, -34.2, -58.5, y, d);
      this.pipe(pipeMat, -4.8, -13, -4.8, -58.5, y + 0.3, d);
    }
    this.pipe(pipeMat, -34.5, -26.2, -14, -26.2, 4.4, 0.7);
    this.pipe(pipeMat, -24, -43.8, -4, -43.8, 4.4, 0.7);

    // Steam vents: grates over an ember glow. Each vents on its own cycle.
    const grateMat = new THREE.MeshStandardMaterial({ map: grateTexture(1), roughness: 0.6, metalness: 0.7 });
    const ventSpots: Array<[number, number, number]> = [
      [-22, -19, 0],
      [-29, -31, 0.3],
      [-20, -35, 0.6],
      [-11, -39, 0.1],
      [-29, -48, 0.45],
      [-19, -52, 0.8],
      [-10, -49, 0.25],
    ];
    const box = new THREE.BoxGeometry(1, 1, 1);
    for (const [x, z, ph] of ventSpots) {
      const glowMat = new THREE.MeshBasicMaterial({ color: 0x401206 });
      const glow = new THREE.Mesh(box, glowMat);
      glow.scale.set(1.8, 0.05, 1.8);
      glow.position.set(x, 0.03, z);
      this.scene.add(glow);
      const g = new THREE.Mesh(box, grateMat);
      g.scale.set(2.2, 0.12, 2.2);
      g.position.set(x, 0.1, z);
      this.scene.add(g);
      this.vents.push({ x, z, period: 4.6, phase: ph * 4.6, glowMat, stage: 0 });
    }

    // Debris for cover in the water: tipped crates and a fallen beam.
    const crateMat = new THREE.MeshStandardMaterial({ map: crateTexture(2), roughness: 0.85, metalness: 0.2 });
    this.crate(crateMat, -27, -21, 2, 0, 0.5);
    this.crate(crateMat, -13, -33, 2.2, 0, -0.3);
    this.crate(crateMat, -24, -40, 1.8, 0, 0.2);
    this.crate(crateMat, -27.5, -54, 2.2, 0, 0.7);
    this.crate(crateMat, -14, -47, 1.6, 0, 0.1);
    const beam = new THREE.Mesh(box, pipeMat);
    beam.scale.set(9, 0.9, 0.9);
    beam.position.set(-19, 0.45, -24);
    beam.rotation.y = 0.25;
    this.scene.add(beam);
    this.addObstacleBoxAt(-19, -24, 8.6, 2.6, 0, 0.9);
  }

  private buildPumpGallery(): void {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const deckMat = new THREE.MeshStandardMaterial({ map: grateTexture(6), roughness: 0.6, metalness: 0.7 });
    const steel = new THREE.MeshStandardMaterial({
      map: pillarTexture(2),
      color: 0x8a8070,
      roughness: 0.5,
      metalness: 0.7,
    });
    const railMat = this.fixture(0xffa040);
    const CW = CATWALK_Y;

    // cx, cz, w, d: east walkway along the wall + a bridge to the divider.
    const decks: Array<[number, number, number, number]> = [
      [31.5, -36, 6, 40],
      [16.25, -36, 24.5, 4],
    ];
    for (const [cx, cz, w, d] of decks) {
      const slab = new THREE.Mesh(box, deckMat);
      slab.scale.set(w, 0.4, d);
      slab.position.set(cx, CW - 0.2, cz);
      slab.receiveShadow = true;
      this.scene.add(slab);
      this.obstacles.push({
        box: new THREE.Box3(
          new THREE.Vector3(cx - w / 2, CW - 0.4, cz - d / 2),
          new THREE.Vector3(cx + w / 2, CW, cz + d / 2)
        ),
      });
    }
    // Support legs (tall enough to walk under the deck).
    const legs: Array<[number, number]> = [
      [28.9, -18],
      [28.9, -28],
      [28.9, -44],
      [28.9, -54],
      [10, -34.3],
      [10, -37.7],
      [20, -34.3],
      [20, -37.7],
    ];
    for (const [x, z] of legs) {
      const leg = new THREE.Mesh(box, steel);
      leg.scale.set(0.45, CW - 0.4, 0.45);
      leg.position.set(x, (CW - 0.4) / 2, z);
      this.scene.add(leg);
      this.addObstacleBox(x, z, 0.45, CW - 0.4, 0.45);
    }
    // Glowing handrails along the open edges (visual only).
    const rails: Array<[number, number, number, number]> = [
      [28.55, -26, 0.08, 10], // walkway west edge, south of the bridge
      [28.55, -47, 0.08, 18], // walkway west edge, north of the bridge
      [16.25, -33.95, 24.5, 0.08],
      [16.25, -38.05, 24.5, 0.08],
    ];
    for (const [x, z, sx, sz] of rails) {
      const r = new THREE.Mesh(box, railMat);
      r.scale.set(sx, 0.06, sz);
      r.position.set(x, CW + 1.0, z);
      this.scene.add(r);
    }

    // Stairs from the water up to the catwalks.
    const stairDefs: Array<{ px: number; pz: number; dx: number; dz: number }> = [
      { px: 28.5, pz: -21, dx: -1, dz: 0 },
      { px: 12, pz: -38, dx: 0, dz: -1 },
      { px: 28.5, pz: -51, dx: -1, dz: 0 },
    ];
    const STEPS = 8;
    const RUN = 0.85;
    const WIDTH = 3.6;
    const m = new THREE.Matrix4();
    const steps = new THREE.InstancedMesh(box, deckMat, stairDefs.length * STEPS);
    stairDefs.forEach(({ px, pz, dx, dz }, s) => {
      for (let k = 0; k < STEPS; k++) {
        const top = (CW * (STEPS - k)) / STEPS;
        const cx = px + dx * (k + 0.5) * RUN;
        const cz = pz + dz * (k + 0.5) * RUN;
        const sx = dx !== 0 ? RUN : WIDTH;
        const sz = dz !== 0 ? RUN : WIDTH;
        m.makeScale(sx, top, sz);
        m.setPosition(cx, top / 2, cz);
        steps.setMatrixAt(s * STEPS + k, m);
        this.addObstacleBox(cx, cz, sx, top, sz);
      }
      const len = STEPS * RUN;
      this.stairWays.push({
        bottom: new THREE.Vector3(px + dx * (len + 1), 0, pz + dz * (len + 1)),
        top: new THREE.Vector3(px - dx * 1.5, CW, pz - dz * 1.5),
      });
    });
    steps.instanceMatrix.needsUpdate = true;
    this.scene.add(steps);

    // Pump housings standing in the water: big round cover.
    const pumpMat = new THREE.MeshStandardMaterial({ color: 0x3e5a52, roughness: 0.55, metalness: 0.6 });
    for (const [x, z] of [
      [12, -24],
      [20, -47],
      [9, -53],
      [21, -29],
    ]) {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.8, 3.6, 18), pumpMat);
      body.position.set(x, 1.8, z);
      body.castShadow = true;
      this.scene.add(body);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.6, 0.6, 18), steel);
      cap.position.set(x, 3.9, z);
      this.scene.add(cap);
      this.addObstacleBox(x, z, 3.2, 4.2, 3.2);
    }
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.7, metalness: 0.6 });
    this.pipe(pipeMat, 34.2, -13, 34.2, -58.5, 6.4, 0.9);
    this.pipe(pipeMat, 4.8, -13, 4.8, -58.5, 6, 0.7);
  }

  private buildVault(): void {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const C = VAULT_CENTER;
    const dark = new THREE.MeshStandardMaterial({
      map: metalTexture(),
      color: 0x2a303c,
      roughness: 0.35,
      metalness: 0.85,
    });
    const glow = (color: number): THREE.MeshBasicMaterial => {
      const mat = new THREE.MeshBasicMaterial({ color });
      this.coreMats.push({ mat, base: mat.color.clone() });
      return mat;
    };

    // MYTHOS: a stepped plinth and a ribbed column to the ceiling, banded
    // with light, with a ring "eye" floating around it.
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.4, 1.0, 32), dark);
    plinth.position.set(C.x, 0.5, C.z);
    this.scene.add(plinth);
    this.addObstacleBox(C.x, C.z, 5.4, 1.0, 5.4);
    const column = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, CEIL, 24), dark);
    column.position.set(C.x, CEIL / 2, C.z);
    this.scene.add(column);
    this.addObstacleBox(C.x, C.z, 3.0, CEIL, 3.0);
    const bandMat = glow(0x4fd9ff);
    for (const y of [1.6, 2.6, 3.6, 5.4, 6.6]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(1.62, 1.62, 0.12, 24), bandMat);
      band.position.set(C.x, y, C.z);
      this.scene.add(band);
    }
    const eye = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.09, 8, 48), glow(0xb46bff));
    eye.rotation.x = Math.PI / 2;
    eye.position.set(C.x, 4.5, C.z);
    this.scene.add(eye);

    // Laser: a rotating beam at shin height from the plinth outward.
    // (Robots ignore it; the player has to jump it.)
    this.laser.position.set(C.x, 0, C.z);
    const beam = new THREE.Mesh(box, this.laserMat);
    beam.scale.set(LASER_R1 - LASER_R0, 0.07, 0.07);
    beam.position.set((LASER_R0 + LASER_R1) / 2, LASER_Y, 0);
    this.laser.add(beam);
    const halo = new THREE.Mesh(
      box,
      new THREE.MeshBasicMaterial({
        color: 0xff2a3a,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    halo.scale.set(LASER_R1 - LASER_R0, 0.28, 0.28);
    halo.position.copy(beam.position);
    this.laser.add(halo);
    const emitter = new THREE.Mesh(box, dark);
    emitter.scale.set(0.5, 0.4, 0.5);
    emitter.position.set(LASER_R1 + 0.2, LASER_Y, 0);
    this.laser.add(emitter);
    this.scene.add(this.laser);
    // Floor ring marking the sweep radius.
    const ringMark = new THREE.Mesh(
      new THREE.RingGeometry(LASER_R1 - 0.1, LASER_R1 + 0.1, 64),
      new THREE.MeshBasicMaterial({ color: 0x5a1018 })
    );
    ringMark.rotation.x = -Math.PI / 2;
    ringMark.position.set(C.x, 0.015, C.z);
    this.scene.add(ringMark);

    // Relay pylons feeding the core, with conduits on the floor.
    const pylonSpots: Array<[number, number]> = [
      [-20, -68],
      [20, -68],
      [0, -94],
    ];
    for (const [x, z] of pylonSpots) {
      const base = new THREE.Mesh(box, dark);
      base.scale.set(2.2, 0.6, 2.2);
      base.position.set(x, 0.3, z);
      this.scene.add(base);
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.6, 5, 12), dark);
      col.position.set(x, 3, z);
      this.scene.add(col);
      for (const a of [0, Math.PI / 2]) {
        const fin = new THREE.Mesh(box, dark);
        fin.scale.set(1.6, 3.6, 0.12);
        fin.rotation.y = a;
        fin.position.set(x, 2.6, z);
        this.scene.add(fin);
      }
      const crownMat = new THREE.MeshBasicMaterial({ color: 0xc89bff });
      const crown = new THREE.Mesh(new THREE.OctahedronGeometry(0.7, 0), crownMat);
      crown.position.set(x, 6.1, z);
      this.scene.add(crown);
      this.addObstacleBox(x, z, 1.6, 5.5, 1.6);
      const light = new THREE.PointLight(0xb46bff, 14, 12, 1.6);
      light.position.set(x, 5.6, z);
      this.scene.add(light);
      // Conduit from the pylon to the plinth.
      const conduitMat = new THREE.MeshBasicMaterial({ color: 0x8a50d0 });
      const dx = C.x - x;
      const dz = C.z - z;
      const len = Math.hypot(dx, dz) - 3.4;
      const conduit = new THREE.Mesh(box, conduitMat);
      conduit.scale.set(0.18, 0.05, len);
      conduit.rotation.y = Math.atan2(dx, dz);
      conduit.position.set(x + (dx / (len + 3.4)) * (len / 2), 0.03, z + (dz / (len + 3.4)) * (len / 2));
      this.scene.add(conduit);
      this.pylons.push({
        x,
        z,
        health: PYLON_HEALTH,
        alive: true,
        box: new THREE.Box3(new THREE.Vector3(x - 1.2, 0, z - 1.2), new THREE.Vector3(x + 1.2, 7, z + 1.2)),
        light,
        crown,
        crownMat,
        conduitMat,
      });
    }

    // Server racks along the side walls: cover outside the laser ring.
    const rackMat = new THREE.MeshStandardMaterial({ map: metalTexture(), color: 0x1e232c, roughness: 0.4, metalness: 0.8 });
    const ledMat = glow(0x37c4f0);
    for (const sx of [-1, 1]) {
      for (const z of [-74, -80, -86]) {
        const x = sx * 27.5;
        const rack = new THREE.Mesh(box, rackMat);
        rack.scale.set(1.6, 4, 3.4);
        rack.position.set(x, 2, z);
        this.scene.add(rack);
        this.addObstacleBox(x, z, 1.6, 4, 3.4);
        const led = new THREE.Mesh(box, ledMat);
        led.scale.set(0.05, 3, 0.12);
        led.position.set(x - sx * 0.82, 2, z);
        this.scene.add(led);
      }
    }
    // Low barricades between the doors and the ring.
    const crateMat = new THREE.MeshStandardMaterial({ map: crateTexture(0), roughness: 0.8, metalness: 0.25 });
    this.crate(crateMat, -12, -64, 1.8, 0, 0.2);
    this.crate(crateMat, 12, -64, 1.8, 0, -0.2);
    this.crate(crateMat, -22, -88, 2, 0, 0.4);
    this.crate(crateMat, 22, -90, 2, 0, -0.4);
  }

  private buildSpawnSpotsUV(): void {
    this.spawnSpots[UV_ZONES.lift] = [
      [-10, -9],
      [10, -9],
      [-11, 3],
    ];
    this.spawnSpots[UV_ZONES.culvertS] = [
      [-30, -16],
      [-15, -19],
      [-8, -22],
    ];
    this.spawnSpots[UV_ZONES.culvertM] = [
      [-31, -33],
      [-17, -38],
      [-8, -32],
    ];
    this.spawnSpots[UV_ZONES.culvertN] = [
      [-31, -50],
      [-17, -47],
      [-7, -55],
    ];
    this.spawnSpots[UV_ZONES.pumps] = [
      [8, -18],
      [24, -24],
      [14, -44],
      [25, -55],
    ];
    this.spawnSpots[UV_ZONES.vault] = [
      [-25, -64],
      [25, -64],
      [-25, -93],
      [25, -93],
    ];
  }
}

export const PYLON_HEALTH = 420;
