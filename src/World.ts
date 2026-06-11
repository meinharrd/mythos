import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { AudioFX } from "./AudioFX";
import {
  floorTexture,
  wallTexture,
  crateTexture,
  pillarTexture,
  ceilingTexture,
  metalTexture,
  barrelTexture,
  barrelLidTexture,
  screenTexture,
  soilTexture,
  pavingTexture,
} from "./Textures";

export const ARENA_HALF = 44; // arena spans -44..44 on x/z
/** Depth of the open-air yard beyond the north wall. */
export const YARD_DEPTH = 26;
/** East wing: corridor x 46..54, rooms x 55..78, outer wall at 79. */
export const EAST_OUTER = 80;
/** South garden: z 46..70, outer wall at 71. */
export const GARDEN_OUTER = 72;
const WALL_HEIGHT = 7;
const CEILING_HEIGHT = 7.2;
const DOOR_WIDTH = 5;
const DOOR_HEIGHT = 3.6;
/** Height of the gallery deck above the east corridor. */
const GALLERY_Y = 4.4;
/** Max ledge height that can be walked up without jumping. */
export const STEP_HEIGHT = 0.6;
/** Multiplayer arena half-extent (the arena spans -MP_HALF..MP_HALF). */
export const MP_HALF = 26;
const MP_WALL_H = 6;

/** Zone ids. 0 hall, 1 yard, 2 depot, 3 reactor, 4 corridor, 5 hydroponics, 6 archive, 7 garden. */
export const ZONE_COUNT = 8;
export const ZONE_NAMES = [
  "hall",
  "yard",
  "depot",
  "reactor",
  "corridor",
  "hydroponics",
  "archive",
  "garden",
];

const _up = new THREE.Vector3(0, 1, 0);

/** Walkable bounds per zone: [x0, x1, z0, z1]. */
const ZONE_RECTS: Array<[number, number, number, number]> = [
  [-42, 42, -42, 42], // hall (rooms overlap; walls keep agents honest)
  [-42, 42, -68, -46], // yard
  [14, 42, -42, -24], // depot
  [-42, -16, 26, 42], // reactor
  [47, 53, -24, 24], // corridor
  [56, 77, -25, 2], // hydroponics
  [56, 77, 6, 25], // archive
  [-29, 29, 47, 69], // garden
];

/**
 * Box whose UVs are scaled by the face's world size so a repeating texture
 * keeps constant texel density: rivets and circles stay round on any wall
 * segment instead of stretching with the box. `tile` = meters per texture
 * repeat.
 */
function worldUVBox(w: number, h: number, d: number, tile: number): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 verts each).
  const dims: Array<[number, number]> = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    const [du, dv] = dims[f];
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * du) / tile, (uv.getY(i) * dv) / tile);
    }
  }
  return g;
}

/**
 * Box whose UVs crop the texture to each face's aspect ratio ("cover" fit,
 * centered). Every face shows the middle of the design undistorted —
 * emblems stay circular on non-square crate faces.
 */
function coverUVBox(w: number, h: number, d: number): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const dims: Array<[number, number]> = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    const [du, dv] = dims[f];
    const m = Math.max(du, dv);
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, 0.5 + (uv.getX(i) - 0.5) * (du / m), 0.5 + (uv.getY(i) - 0.5) * (dv / m));
    }
  }
  return g;
}

export interface Obstacle {
  box: THREE.Box3;
  /** Doors toggle this; undefined/true means solid. */
  enabled?: boolean;
}

export interface StairWay {
  bottom: THREE.Vector3;
  top: THREE.Vector3;
}

/**
 * Static arena: floor, perimeter walls, cover blocks and pillars.
 * All static geometry is merged into instanced meshes; collision uses
 * a flat list of AABBs tested manually (no physics engine needed).
 */
export interface Pickup {
  kind: "keycard" | "core";
  mesh: THREE.Group;
  /**
   * Glow light, deliberately NOT part of `mesh`: toggling a light's
   * presence changes the scene's light count and forces three.js to
   * recompile every shader program mid-frame (a visible hitch). Taking
   * a pickup dims the light to zero instead.
   */
  light: THREE.PointLight;
  lightIntensity: number;
  x: number;
  y: number;
  z: number;
  taken: boolean;
}

export class World {
  readonly scene: THREE.Scene;
  readonly obstacles: Obstacle[] = [];
  /** True when this world is the compact multiplayer arena. */
  readonly arenaMode: boolean;
  /** Outer clamp for the player, set per map. */
  readonly bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  /** Multiplayer spawn points: [x, z, yaw]. */
  readonly mpSpawns: Array<[number, number, number]> = [];
  /** Stair entry/exit waypoints used by enemy navigation. */
  readonly stairWays: StairWay[] = [];
  /** Set by Game; doors play their hiss/thunk through it. */
  audio: AudioFX | null = null;
  /** Powered objects that emit a localized hum (registered by Game). */
  readonly humSpots: Array<{ x: number; y: number; z: number; kind: "reactor" | "console" }> = [];
  /** Plot items lying in the world; Game collects them. */
  readonly pickups: Pickup[] = [];
  /** Center of the extraction gate in the garden's south wall. */
  readonly gatePos = new THREE.Vector3(0, 0, GARDEN_OUTER - 1);
  /** Enemy spawn spots, grouped by zone id. */
  readonly spawnSpots: Array<Array<[number, number]>> = [];
  private doors: Door[] = [];
  /** nextHop[a][b]: first zone to move to when travelling a -> b. */
  private nextHop: number[][] = [];
  private alarm = false;
  private time = 0;
  private flickerLight!: THREE.PointLight;
  private beaconLight!: THREE.PointLight;
  private hemi!: THREE.HemisphereLight;
  private fog!: THREE.FogExp2;

  constructor(arenaMode = false) {
    this.arenaMode = arenaMode;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05080f);
    this.fog = new THREE.FogExp2(0x070d18, 0.013);
    this.scene.fog = this.fog;

    if (arenaMode) {
      this.bounds.minX = -MP_HALF + 1.2;
      this.bounds.maxX = MP_HALF - 1.2;
      this.bounds.minZ = -MP_HALF + 1.2;
      this.bounds.maxZ = MP_HALF - 1.2;
      this.buildSky();
      this.buildArenaMap();
      return;
    }

    this.bounds.minX = -ARENA_HALF + 1.5;
    this.bounds.maxX = EAST_OUTER - 2.5;
    this.bounds.minZ = -ARENA_HALF - YARD_DEPTH + 1.5;
    this.bounds.maxZ = GARDEN_OUTER - 2.5;
    this.buildLights();
    this.buildSky();
    this.buildFloor();
    this.buildCeiling();
    this.buildWalls();
    this.buildDoors();
    this.buildCover();
    this.buildProps();
    this.buildPlatforms();
    this.buildGallery();
    this.buildReactor();
    this.buildHydroponics();
    this.buildArchive();
    this.buildGarden();
    this.buildPickups();
    this.buildSpawnSpots();
  }

  // ------------------------------------------------------- multiplayer arena

  /**
   * Compact symmetric deathmatch arena under an open sky: a raised
   * central platform with two staircases, mirrored crate clusters for
   * cover, and a glowing perimeter. Spawns ring the outer edge.
   */
  private buildArenaMap(): void {
    const geo = new THREE.BoxGeometry(1, 1, 1);

    // Lighting: night sky mood with four colored corner beacons.
    this.hemi = new THREE.HemisphereLight(0x8fb3e6, 0x2a3346, 1.45);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xcfe2ff, 1.8);
    sun.position.set(24, 42, 16);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -MP_HALF - 4;
    sun.shadow.camera.right = MP_HALF + 4;
    sun.shadow.camera.top = MP_HALF + 4;
    sun.shadow.camera.bottom = -MP_HALF - 4;
    sun.shadow.camera.far = 150;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    const cornerColors = [0x2a9fd6, 0xffa040, 0x35e08a, 0xff5fd0];
    [
      [-MP_HALF + 6, -MP_HALF + 6],
      [MP_HALF - 6, -MP_HALF + 6],
      [-MP_HALF + 6, MP_HALF - 6],
      [MP_HALF - 6, MP_HALF - 6],
    ].forEach(([x, z], i) => {
      const p = new THREE.PointLight(cornerColors[i], 70, 45, 1.6);
      p.position.set(x, 5, z);
      this.scene.add(p);
    });
    const centerLight = new THREE.PointLight(0x4fd9ff, 60, 40, 1.5);
    centerLight.position.set(0, 9, 0);
    this.scene.add(centerLight);

    // These two animate in update(); park them far below the arena.
    this.flickerLight = new THREE.PointLight(0x6f9fff, 0, 1);
    this.beaconLight = new THREE.PointLight(0xff3030, 0, 1);
    this.flickerLight.position.y = -50;
    this.beaconLight.position.y = -50;
    this.scene.add(this.flickerLight, this.beaconLight);

    // Floor + grid.
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTexture(10),
      roughness: 0.85,
      metalness: 0.35,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(MP_HALF * 2, MP_HALF * 2), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(MP_HALF * 2, 26, 0x2a9fd6, 0x1a2a40);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    grid.position.y = 0.01;
    this.scene.add(grid);

    // Perimeter walls with a glowing trim line.
    const wallMat = new THREE.MeshStandardMaterial({
      map: wallTexture(1, 1),
      roughness: 0.7,
      metalness: 0.4,
    });
    const trimMat = new THREE.MeshBasicMaterial({ color: 0x37c4f0 });
    const W = MP_HALF * 2 + 2;
    const wallDefs: Array<[number, number, number, number]> = [
      [0, -MP_HALF - 0.5, W, 1], // north
      [0, MP_HALF + 0.5, W, 1], // south
      [-MP_HALF - 0.5, 0, 1, W], // west
      [MP_HALF + 0.5, 0, 1, W], // east
    ];
    for (const [cx, cz, sx, sz] of wallDefs) {
      const wall = new THREE.Mesh(worldUVBox(sx, MP_WALL_H, sz, 6), wallMat);
      wall.position.set(cx, MP_WALL_H / 2, cz);
      wall.castShadow = true;
      wall.receiveShadow = true;
      this.scene.add(wall);
      this.addObstacleBox(cx, cz, sx, MP_WALL_H, sz);
      const trim = new THREE.Mesh(geo, trimMat);
      trim.scale.set(sx === 1 ? 1.06 : sx, 0.14, sz === 1 ? 1.06 : sz);
      trim.position.set(cx, MP_WALL_H + 0.07, cz);
      this.scene.add(trim);
    }
    // Corner pillars.
    const pillarMat = new THREE.MeshStandardMaterial({
      map: pillarTexture(2),
      roughness: 0.5,
      metalness: 0.6,
      emissive: 0x9cc6f2,
      emissiveMap: pillarTexture(2),
      emissiveIntensity: 0.3,
    });
    for (const [x, z] of [
      [-MP_HALF, -MP_HALF],
      [MP_HALF, -MP_HALF],
      [-MP_HALF, MP_HALF],
      [MP_HALF, MP_HALF],
    ]) {
      const pillar = new THREE.Mesh(worldUVBox(2.2, MP_WALL_H + 1.6, 2.2, 3), pillarMat);
      pillar.position.set(x, (MP_WALL_H + 1.6) / 2, z);
      pillar.castShadow = true;
      this.scene.add(pillar);
      this.addObstacleBox(x, z, 2.2, MP_WALL_H + 1.6, 2.2);
    }

    // Central raised platform on corner supports (walkable underneath).
    const deckMap = floorTexture(2);
    const deckMat = new THREE.MeshStandardMaterial({
      map: deckMap,
      roughness: 0.7,
      metalness: 0.5,
      emissive: 0x8fb6e0,
      emissiveMap: deckMap,
      emissiveIntensity: 0.28,
    });
    const PH = 3.2; // platform height
    const PW = 13; // platform width/depth
    const slab = new THREE.Mesh(geo, deckMat);
    slab.scale.set(PW, 0.5, PW);
    slab.position.set(0, PH - 0.25, 0);
    slab.castShadow = true;
    slab.receiveShadow = true;
    this.scene.add(slab);
    this.obstacles.push({
      box: new THREE.Box3(
        new THREE.Vector3(-PW / 2, PH - 0.5, -PW / 2),
        new THREE.Vector3(PW / 2, PH, PW / 2)
      ),
    });
    const inset = PW / 2 - 1.2;
    for (const [sx, sz] of [
      [-inset, -inset],
      [inset, -inset],
      [-inset, inset],
      [inset, inset],
    ]) {
      const sup = new THREE.Mesh(geo, pillarMat);
      sup.scale.set(0.7, PH - 0.5, 0.7);
      sup.position.set(sx, (PH - 0.5) / 2, sz);
      sup.castShadow = true;
      this.scene.add(sup);
      this.addObstacleBox(sx, sz, 0.7, PH - 0.5, 0.7);
    }
    // Glowing edge trim around the deck.
    const edges: Array<[number, number, number, number]> = [
      [0, -PW / 2, PW + 0.16, 0.16],
      [0, PW / 2, PW + 0.16, 0.16],
      [-PW / 2, 0, 0.16, PW + 0.16],
      [PW / 2, 0, 0.16, PW + 0.16],
    ];
    for (const [ex, ez, sx, sz] of edges) {
      const t = new THREE.Mesh(geo, trimMat);
      t.scale.set(sx, 0.1, sz);
      t.position.set(ex, PH + 0.05, ez);
      this.scene.add(t);
    }

    // Two staircases up to the platform (east + west).
    const STEPS = 8;
    const RUN = 0.85;
    const SW = 4;
    const stairs: Array<{ px: number; dx: number }> = [
      { px: PW / 2, dx: 1 },
      { px: -PW / 2, dx: -1 },
    ];
    for (const { px, dx } of stairs) {
      for (let k = 0; k < STEPS; k++) {
        const top = (PH * (STEPS - k)) / STEPS;
        const cx = px + dx * (k + 0.5) * RUN;
        const step = new THREE.Mesh(geo, deckMat);
        step.scale.set(RUN, top, SW);
        step.position.set(cx, top / 2, 0);
        step.castShadow = true;
        step.receiveShadow = true;
        this.scene.add(step);
        this.addObstacleBox(cx, 0, RUN, top, SW);
      }
      const len = STEPS * RUN;
      this.stairWays.push({
        bottom: new THREE.Vector3(px + dx * (len + 1), 0, 0),
        top: new THREE.Vector3(px - dx * 1.5, PH, 0),
      });
    }

    // Mirrored crate clusters for cover.
    const crateMat = new THREE.MeshStandardMaterial({
      map: crateTexture(0),
      roughness: 0.75,
      metalness: 0.25,
    });
    const crate = (cx: number, cz: number, s: number, y = 0, rot = 0): void => {
      const c = new THREE.Mesh(coverUVBox(s, s, s), crateMat);
      c.position.set(cx, y + s / 2, cz);
      c.rotation.y = rot;
      c.castShadow = true;
      c.receiveShadow = true;
      this.scene.add(c);
      this.addObstacleBoxAt(cx, cz, s + 0.12, s + 0.12, y, y + s);
    };
    // L-shaped clusters near each corner, mirrored for fairness.
    for (const [mx, mz] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]) {
      const bx = 13 * mx;
      const bz = 13 * mz;
      crate(bx, bz, 2.2);
      crate(bx, bz, 1.7, 2.2, 0.4); // stacked
      crate(bx - 2.3 * mx, bz, 2.2);
      crate(bx, bz - 2.3 * mz, 2.2);
    }
    // Single mid-wall crates to break long sightlines.
    for (const [cx, cz] of [
      [0, -19],
      [0, 19],
      [-19, 0],
      [19, 0],
    ]) {
      crate(cx, cz, 2.4, 0, 0.3);
      crate(cx + 1.2, cz + 1.4, 1.5, 0, 0.9);
    }

    // Spawn ring: eight points hugging the perimeter, facing the center.
    const S = MP_HALF - 4;
    const spawnXZ: Array<[number, number]> = [
      [-S, -S],
      [0, -S],
      [S, -S],
      [S, 0],
      [S, S],
      [0, S],
      [-S, S],
      [-S, 0],
    ];
    for (const [x, z] of spawnXZ) {
      // forward = (-sin yaw, -cos yaw): atan2(x, z) faces the center.
      this.mpSpawns.push([x, z, Math.atan2(x, z)]);
    }
  }

  /**
   * Centerpiece of the reactor room (SW): a glowing green core column
   * on a walkable plinth. The depot room (NE) gets crate towers instead
   * (see buildCover), so the two rooms read very differently.
   */
  private buildReactor(): void {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const cx = -29;
    const cz = 35;

    const columnMap = metalTexture();
    const columnMat = new THREE.MeshStandardMaterial({
      map: columnMap,
      color: 0x55706a,
      roughness: 0.35,
      metalness: 0.7,
      emissive: 0x1d4536,
      emissiveMap: columnMap,
      emissiveIntensity: 0.8,
    });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x57ff9a });

    // Walkable plinth (below STEP_HEIGHT) with a glow ring straddling
    // its top edge, then the core column up to the ceiling.
    const plinth = new THREE.Mesh(geo, columnMat);
    plinth.scale.set(5, 0.5, 5);
    plinth.position.set(cx, 0.25, cz);
    plinth.receiveShadow = true;
    this.scene.add(plinth);
    this.addObstacleBox(cx, cz, 5, 0.5, 5);

    const ring = new THREE.Mesh(geo, glowMat);
    ring.scale.set(5.2, 0.12, 5.2);
    ring.position.set(cx, 0.47, cz);
    this.scene.add(ring);

    const column = new THREE.Mesh(geo, columnMat);
    column.scale.set(2.6, CEILING_HEIGHT, 2.6);
    column.position.set(cx, CEILING_HEIGHT / 2, cz);
    column.castShadow = true;
    column.receiveShadow = true;
    this.scene.add(column);
    // 2.9, not 2.6: the corner conduits stick 0.14 past the column faces
    // (1.3 + half their 0.28 thickness), so the box must cover them too.
    this.addObstacleBox(cx, cz, 2.9, CEILING_HEIGHT, 2.9);
    this.humSpots.push({ x: cx, y: 3, z: cz, kind: "reactor" });

    // Vertical energy conduits on the column corners.
    for (const [ox, oz] of [
      [1.3, 1.3],
      [-1.3, 1.3],
      [1.3, -1.3],
      [-1.3, -1.3],
    ]) {
      const conduit = new THREE.Mesh(geo, glowMat);
      conduit.scale.set(0.28, CEILING_HEIGHT - 0.4, 0.28);
      conduit.position.set(cx + ox, (CEILING_HEIGHT - 0.4) / 2 + 0.2, cz + oz);
      this.scene.add(conduit);
    }
  }

  // ---------------------------------------------------------------- flora

  /** Merged-cone shrub geometry (single leaf material). */
  private makeBushGeo(spread: number, height: number): THREE.BufferGeometry {
    const cones: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 7; i++) {
      const c = new THREE.CylinderGeometry(0, 0.34 * spread, height * (0.7 + Math.random() * 0.5), 6);
      const a = (i / 7) * Math.PI * 2;
      const tilt = i === 0 ? 0 : 0.55 + Math.random() * 0.25;
      c.rotateX(Math.sin(a) * tilt);
      c.rotateZ(Math.cos(a) * tilt);
      c.translate(
        Math.cos(a) * 0.16 * spread * (i === 0 ? 0 : 1),
        height * 0.42,
        Math.sin(a) * 0.16 * spread * (i === 0 ? 0 : 1)
      );
      cones.push(c);
    }
    const merged = mergeGeometries(cones);
    for (const c of cones) c.dispose();
    return merged;
  }

  /** Scatter bushes on the ground as one InstancedMesh. Spots: x, z, scale. */
  private plantBushes(
    spots: Array<[number, number, number]>,
    color: number,
    emissive: number
  ): void {
    this.plantBushesAtHeight(spots, color, emissive, 0);
  }

  // ------------------------------------------------------------ east wing

  /** Gallery deck above the east corridor, reached by a staircase. */
  private buildGallery(): void {
    const deckMap = floorTexture(2);
    const deckMat = new THREE.MeshStandardMaterial({
      map: deckMap,
      roughness: 0.7,
      metalness: 0.5,
      emissive: 0x8fb6e0,
      emissiveMap: deckMap,
      emissiveIntensity: 0.28,
    });
    const geo = new THREE.BoxGeometry(1, 1, 1);

    // Slab: x 46..54, z -8..26, walkway at GALLERY_Y.
    const slab = new THREE.Mesh(geo, deckMat);
    slab.scale.set(8, 0.4, 34);
    slab.position.set(50, GALLERY_Y - 0.2, 9);
    slab.castShadow = true;
    slab.receiveShadow = true;
    this.scene.add(slab);
    this.addObstacleBoxAt(50, 9, 8, 34, GALLERY_Y - 0.4, GALLERY_Y);

    // Staircase down to the corridor floor (north end).
    const stepMat = new THREE.MeshStandardMaterial({
      map: pillarTexture(2),
      roughness: 0.5,
      metalness: 0.6,
      emissive: 0x9cc6f2,
      emissiveIntensity: 0.3,
    });
    const STEPS = 11;
    const RISE = GALLERY_Y / STEPS;
    const RUN = 0.8;
    const steps = new THREE.InstancedMesh(geo, stepMat, STEPS);
    steps.castShadow = true;
    steps.receiveShadow = true;
    const m = new THREE.Matrix4();
    for (let k = 0; k < STEPS; k++) {
      const top = GALLERY_Y - k * RISE;
      const cz = -8 - (k + 0.5) * RUN;
      m.makeScale(4, top, RUN);
      m.setPosition(50, top / 2, cz);
      steps.setMatrixAt(k, m);
      this.addObstacleBox(50, cz, 4, top, RUN);
    }
    steps.instanceMatrix.needsUpdate = true;
    this.scene.add(steps);
    this.stairWays.push({
      bottom: new THREE.Vector3(50, 0, -18.5),
      top: new THREE.Vector3(50, GALLERY_Y, -6),
    });

    // Railing along the west edge and the stair gap corners.
    const railMat = new THREE.MeshBasicMaterial({ color: 0x37c4f0 });
    const rails: Array<[number, number, number, number]> = [
      [46.2, 9, 0.12, 34], // west edge
      [47, -7.9, 1.6, 0.12], // north edge, west of the stair gap
      [53, -7.9, 2, 0.12], // north edge, east of the stair gap
    ];
    for (const [x, z, sx, sz] of rails) {
      const rail = new THREE.Mesh(geo, railMat);
      rail.scale.set(sx, 0.08, sz);
      rail.position.set(x, GALLERY_Y + 0.95, z);
      this.scene.add(rail);
      const post = new THREE.Mesh(geo, railMat);
      post.scale.set(0.08, 0.95, 0.08);
      post.position.set(x, GALLERY_Y + 0.48, z + sz / 2 - 0.05);
      this.scene.add(post);
    }

    // A bit of cover up top.
    const crateMat = new THREE.MeshStandardMaterial({
      map: crateTexture(1),
      roughness: 0.6,
      metalness: 0.45,
      emissive: 0xe0c890,
      emissiveIntensity: 0.3,
    });
    for (const [x, z, s] of [
      [52.6, 20, 1.5],
      [52.2, 22, 1.1],
    ] as Array<[number, number, number]>) {
      const c = new THREE.Mesh(coverUVBox(s, s, s), crateMat);
      c.position.set(x, GALLERY_Y + s / 2, z);
      c.castShadow = true;
      c.receiveShadow = true;
      this.scene.add(c);
      this.addObstacleBoxAt(x, z, s, s, GALLERY_Y, GALLERY_Y + s);
    }
  }

  /** Hydroponics bay: planter troughs, grow lights, water tank, flora. */
  private buildHydroponics(): void {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const steelMat = new THREE.MeshStandardMaterial({
      map: metalTexture(),
      color: 0x7f9e8a,
      roughness: 0.5,
      metalness: 0.55,
      emissive: 0x2a4636,
      emissiveIntensity: 0.4,
    });
    const soilMat = new THREE.MeshStandardMaterial({
      map: soilTexture(2),
      roughness: 1,
      metalness: 0,
    });

    // Three long troughs with soil beds and bushes growing out of them.
    const troughs: Array<[number, number]> = [
      [61, -19],
      [67, -19],
      [73, -19],
    ];
    const bushSpots: Array<[number, number, number]> = [];
    for (const [x, z0] of troughs) {
      const trough = new THREE.Mesh(coverUVBox(2.2, 0.9, 16), steelMat);
      trough.position.set(x, 0.45, z0 + 8);
      trough.castShadow = true;
      trough.receiveShadow = true;
      this.scene.add(trough);
      this.addObstacleBox(x, z0 + 8, 2.2, 0.9, 16);
      const bed = new THREE.Mesh(geo, soilMat);
      bed.scale.set(1.9, 0.1, 15.7);
      bed.position.set(x, 0.92, z0 + 8);
      this.scene.add(bed);
      for (let i = 0; i < 5; i++) {
        bushSpots.push([x + (Math.random() - 0.5) * 0.9, z0 + 1.8 + i * 3.1, 0.8 + Math.random() * 0.5]);
      }
    }
    // Lush, slightly alien crop — bright green with a faint glow.
    this.plantBushesAtHeight(bushSpots, 0x3da84e, 0x10401c, 0.95);

    // Grow-light bars hanging over each trough.
    const barMat = new THREE.MeshBasicMaterial({ color: 0xff79d9 });
    for (const [x, z0] of troughs) {
      const bar = new THREE.Mesh(geo, barMat);
      bar.scale.set(0.5, 0.08, 15);
      bar.position.set(x, 3.6, z0 + 8);
      this.scene.add(bar);
      for (const dz of [2, 14]) {
        const rod = new THREE.Mesh(geo, steelMat);
        rod.scale.set(0.06, CEILING_HEIGHT - 3.6, 0.06);
        rod.position.set(x, (CEILING_HEIGHT + 3.6) / 2, z0 + dz);
        this.scene.add(rod);
      }
    }

    // Water tank in the NE corner with a glowing fill band.
    const tank = new THREE.Mesh(
      new THREE.CylinderGeometry(1.7, 1.7, 3.6, 16),
      new THREE.MeshStandardMaterial({
        map: metalTexture(),
        color: 0x5f8ea8,
        roughness: 0.35,
        metalness: 0.7,
        emissive: 0x1d3c50,
        emissiveIntensity: 0.5,
      })
    );
    tank.position.set(75.5, 1.8, -23.5);
    tank.castShadow = true;
    tank.receiveShadow = true;
    this.scene.add(tank);
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(1.74, 1.74, 0.18, 16),
      new THREE.MeshBasicMaterial({ color: 0x57d9ff })
    );
    band.position.set(75.5, 2.6, -23.5);
    this.scene.add(band);
    this.addObstacleBox(75.5, -23.5, 3.5, 3.6, 3.5);
    this.humSpots.push({ x: 75.5, y: 1.8, z: -23.5, kind: "console" });

    // Freestanding pots near the door.
    this.plantPots([
      [57.5, -2.5, 1],
      [76.5, -5, 1.2],
      [57, -23, 0.9],
    ]);
  }

  /** Bushes whose bases sit at a given height (trough beds vs ground). */
  private plantBushesAtHeight(
    spots: Array<[number, number, number]>,
    color: number,
    emissive: number,
    baseY: number
  ): void {
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.95,
      metalness: 0,
      emissive,
      emissiveIntensity: 0.5,
      flatShading: true,
    });
    const mesh = new THREE.InstancedMesh(this.makeBushGeo(1, 1.1), mat, spots.length);
    mesh.castShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    spots.forEach(([x, z, s], i) => {
      q.setFromAxisAngle(_up, Math.random() * Math.PI * 2);
      pos.set(x, baseY, z);
      scl.setScalar(s);
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  /** Potted plants: steel pot + bush. */
  private plantPots(spots: Array<[number, number, number]>): void {
    const potMat = new THREE.MeshStandardMaterial({
      map: metalTexture(),
      color: 0x6a7f9e,
      roughness: 0.5,
      metalness: 0.6,
      emissive: 0x33486a,
      emissiveIntensity: 0.3,
    });
    const potGeo = new THREE.CylinderGeometry(0.55, 0.42, 0.7, 10);
    const pots = new THREE.InstancedMesh(potGeo, potMat, spots.length);
    pots.castShadow = true;
    pots.receiveShadow = true;
    const m = new THREE.Matrix4();
    spots.forEach(([x, z, s], i) => {
      m.makeScale(s, s, s);
      m.setPosition(x, 0.35 * s, z);
      pots.setMatrixAt(i, m);
      this.addObstacleBox(x, z, 1.1 * s, 0.7 * s, 1.1 * s);
    });
    pots.instanceMatrix.needsUpdate = true;
    this.scene.add(pots);
    this.plantBushesAtHeight(
      spots.map(([x, z, s]) => [x, z, 0.75 * s] as [number, number, number]),
      0x35914a,
      0x0e3318,
      0.55
    );
  }

  /** Archive: rows of server racks, a reading desk, cold blue light. */
  private buildArchive(): void {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const rackMat = new THREE.MeshStandardMaterial({
      map: metalTexture(),
      color: 0x3f4f70,
      roughness: 0.45,
      metalness: 0.6,
      emissive: 0x24365c,
      emissiveIntensity: 0.5,
    });
    const ledMat = new THREE.MeshBasicMaterial({ color: 0x6f9fff });

    // Two rows of racks with an aisle between them.
    const racks: Array<[number, number]> = [];
    for (let i = 0; i < 5; i++) {
      racks.push([59 + i * 3.4, 11.5]);
      racks.push([59 + i * 3.4, 21]);
    }
    const rackMesh = new THREE.InstancedMesh(coverUVBox(1.4, 2.6, 0.8), rackMat, racks.length);
    rackMesh.castShadow = true;
    rackMesh.receiveShadow = true;
    const leds = new THREE.InstancedMesh(geo, ledMat, racks.length * 3);
    const m = new THREE.Matrix4();
    racks.forEach(([x, z], i) => {
      m.identity();
      m.setPosition(x, 1.3, z);
      rackMesh.setMatrixAt(i, m);
      this.addObstacleBox(x, z, 1.4, 2.6, 0.8);
      for (let l = 0; l < 3; l++) {
        m.makeScale(0.5, 0.05, 0.03);
        m.setPosition(x + (l - 1) * 0.1, 0.7 + l * 0.7, z + (z < 16 ? 0.42 : -0.42));
        leds.setMatrixAt(i * 3 + l, m);
      }
    });
    rackMesh.instanceMatrix.needsUpdate = true;
    leds.instanceMatrix.needsUpdate = true;
    this.scene.add(rackMesh, leds);

    // Reading desk with a lit terminal by the door.
    const desk = new THREE.Mesh(coverUVBox(2.4, 0.9, 1.1), rackMat);
    desk.position.set(58.5, 0.45, 7.6);
    desk.castShadow = true;
    desk.receiveShadow = true;
    this.scene.add(desk);
    this.addObstacleBox(58.5, 7.6, 2.4, 0.9, 1.1);
    const term = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.55, 0.06),
      new THREE.MeshBasicMaterial({ map: screenTexture() })
    );
    term.position.set(58.5, 1.25, 7.7);
    term.rotation.x = -0.35;
    this.scene.add(term);
    this.humSpots.push({ x: 58.5, y: 1.1, z: 7.6, kind: "console" });
  }

  /** Outdoor garden: trees, rocks, lanterns and the extraction gate. */
  private buildGarden(): void {
    const geo = new THREE.BoxGeometry(1, 1, 1);

    // Trees: instanced trunks + instanced foliage clumps.
    const trees: Array<[number, number, number]> = [
      [-22, 52, 1.2],
      [-14, 64, 1.0],
      [22, 53, 1.1],
      [16, 65, 1.3],
      [-25, 67, 0.9],
      [26, 60, 0.95],
    ];
    const barkMat = new THREE.MeshStandardMaterial({
      color: 0x4a3a2c,
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
    });
    const leafMat = new THREE.MeshStandardMaterial({
      color: 0x2e6b3c,
      roughness: 0.9,
      metalness: 0,
      emissive: 0x0a2412,
      emissiveIntensity: 0.45,
      flatShading: true,
    });
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.28, 2.6, 7);
    const clumps: THREE.BufferGeometry[] = [];
    for (const [ox, oy, oz, r] of [
      [0, 3.1, 0, 1.35],
      [0.9, 2.5, 0.3, 0.9],
      [-0.8, 2.6, -0.4, 0.85],
      [0.1, 2.4, 0.9, 0.8],
    ] as Array<[number, number, number, number]>) {
      const s = new THREE.IcosahedronGeometry(r, 1);
      s.translate(ox, oy, oz);
      clumps.push(s);
    }
    const crownGeo = mergeGeometries(clumps);
    for (const c of clumps) c.dispose();
    const trunks = new THREE.InstancedMesh(trunkGeo, barkMat, trees.length);
    const crowns = new THREE.InstancedMesh(crownGeo, leafMat, trees.length);
    trunks.castShadow = true;
    crowns.castShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    trees.forEach(([x, z, s], i) => {
      q.setFromAxisAngle(_up, Math.random() * Math.PI * 2);
      pos.set(x, 1.3 * s, z);
      scl.setScalar(s);
      m.compose(pos, q, scl);
      trunks.setMatrixAt(i, m);
      pos.y = 0;
      m.compose(pos, q, scl);
      crowns.setMatrixAt(i, m);
      this.addObstacleBox(x, z, 0.6 * s, 2.6 * s, 0.6 * s);
    });
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    this.scene.add(trunks, crowns);

    // Shrubs and rocks scattered around the beds.
    this.plantBushes(
      [
        [-18, 49, 1.2],
        [-10, 55, 0.9],
        [-20, 60, 1.4],
        [9, 52, 1.1],
        [20, 58, 1.3],
        [12, 67, 1.0],
        [-6, 66, 1.2],
        [26, 49, 0.8],
        [-27, 55, 1.0],
        [5, 60, 0.7],
      ],
      0x356e41,
      0x0c2814
    );
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x6f7682,
      roughness: 0.95,
      metalness: 0.05,
      flatShading: true,
    });
    const rocks: Array<[number, number, number, number]> = [
      [-8, 50, 1.3, 0.8],
      [18, 62, 1.7, 1.0],
      [-23, 63, 1.1, 0.7],
      [7, 68, 1.4, 0.9],
      [27, 53, 0.9, 0.6],
    ];
    const rockMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), rockMat, rocks.length);
    rockMesh.castShadow = true;
    rockMesh.receiveShadow = true;
    rocks.forEach(([x, z, sx, sy], i) => {
      q.setFromAxisAngle(_up, Math.random() * Math.PI * 2);
      pos.set(x, sy * 0.45, z);
      scl.set(sx, sy, sx * (0.8 + Math.random() * 0.4));
      m.compose(pos, q, scl);
      rockMesh.setMatrixAt(i, m);
      this.addObstacleBox(x, z, sx * 1.4, sy, sx * 1.4);
    });
    rockMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(rockMesh);

    // Lantern posts: dark pole, warm glowing head.
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x2c3442,
      roughness: 0.6,
      metalness: 0.6,
    });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffc98a });
    for (const [x, z] of [
      [-14, 52],
      [14, 52],
      [-14, 64],
      [14, 64],
    ] as Array<[number, number]>) {
      const pole = new THREE.Mesh(geo, poleMat);
      pole.scale.set(0.14, 3.2, 0.14);
      pole.position.set(x, 1.6, z);
      pole.castShadow = true;
      this.scene.add(pole);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), glowMat);
      head.position.set(x, 3.3, z);
      this.scene.add(head);
      this.addObstacleBox(x, z, 0.3, 3.2, 0.3);
    }

    // Raised planter beds flanking the path.
    const bedMat = new THREE.MeshStandardMaterial({
      map: metalTexture(),
      color: 0x5d6c84,
      roughness: 0.6,
      metalness: 0.5,
      emissive: 0x2c3c54,
      emissiveIntensity: 0.3,
    });
    for (const [x, z] of [
      [-6, 57],
      [6, 57],
    ] as Array<[number, number]>) {
      const bed = new THREE.Mesh(coverUVBox(3.2, 0.6, 1.6), bedMat);
      bed.position.set(x, 0.3, z);
      bed.castShadow = true;
      bed.receiveShadow = true;
      this.scene.add(bed);
      this.addObstacleBox(x, z, 3.2, 0.6, 1.6);
      this.plantBushesAtHeight(
        [
          [x - 0.8, z, 0.6],
          [x + 0.7, z + 0.2, 0.7],
        ],
        0x3da84e,
        0x10401c,
        0.55
      );
    }
  }

  // ------------------------------------------------------------ plot items

  private buildPickups(): void {
    // Keycard: amber chip floating in the depot.
    const card = new THREE.Group();
    const cardBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.34, 0.06),
      new THREE.MeshBasicMaterial({ color: 0xffb050 })
    );
    const cardStripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.09, 0.07),
      new THREE.MeshBasicMaterial({ color: 0x1a1006 })
    );
    cardStripe.position.y = 0.06;
    card.add(cardBody, cardStripe);
    const cardGlow = new THREE.PointLight(0xffb050, 8, 7, 1.8);
    cardGlow.position.set(27.5, 1.2, -36);
    this.scene.add(cardGlow);
    // Open aisle between the depot crate towers — visible from the door.
    card.position.set(27.5, 1.2, -36);
    this.scene.add(card);
    this.pickups.push({
      kind: "keycard",
      mesh: card,
      light: cardGlow,
      lightIntensity: cardGlow.intensity,
      x: 27.5,
      y: 1.2,
      z: -36,
      taken: false,
    });

    // Reactor core cell: green canister on the reactor plinth.
    const core = new THREE.Group();
    const cell = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 0.5, 10),
      new THREE.MeshBasicMaterial({ color: 0x57ff9a })
    );
    const capMat = new THREE.MeshStandardMaterial({
      color: 0x44525f,
      roughness: 0.4,
      metalness: 0.8,
    });
    for (const dy of [0.3, -0.3]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 10), capMat);
      cap.position.y = dy;
      core.add(cap);
    }
    core.add(cell);
    const coreGlow = new THREE.PointLight(0x57ff9a, 10, 8, 1.8);
    coreGlow.position.set(-27.2, 1.4, 33.2);
    this.scene.add(coreGlow);
    core.position.set(-27.2, 1.4, 33.2);
    this.scene.add(core);
    this.pickups.push({
      kind: "core",
      mesh: core,
      light: coreGlow,
      lightIntensity: coreGlow.intensity,
      x: -27.2,
      y: 1.4,
      z: 33.2,
      taken: false,
    });
  }

  /** Hide/show plot pickups (restart). */
  resetPlot(): void {
    for (const p of this.pickups) {
      p.taken = false;
      p.mesh.visible = true;
      p.light.intensity = p.lightIntensity;
    }
    for (const d of this.doors) d.relock();
    this.setAlarm(false);
  }

  /** Mark a pickup taken (Game decides when). */
  takePickup(p: Pickup): void {
    p.taken = true;
    p.mesh.visible = false;
    // Dim, don't remove: see the Pickup.light comment.
    p.light.intensity = 0;
  }

  private buildSpawnSpots(): void {
    this.spawnSpots[0] = [
      [-38, -38],
      [38, -6],
      [-6, -38],
      [-38, 16],
      [20, 38],
      [-24, 6],
    ];
    this.spawnSpots[1] = [
      [-30, -60],
      [0, -64],
      [30, -58],
    ];
    this.spawnSpots[2] = [
      [36, -36],
      [20, -28],
      [40, -26],
    ];
    this.spawnSpots[3] = [
      [-36, 30],
      [-20, 38],
      [-38, 40],
    ];
    this.spawnSpots[4] = [
      [50, -20],
      [50, 20],
      [50, 6],
    ];
    this.spawnSpots[5] = [
      [70, -10],
      [59, -8],
      [64, -1],
    ];
    this.spawnSpots[6] = [
      [64, 16.5],
      [73, 16.5],
      [60, 24],
    ];
    this.spawnSpots[7] = [
      [-20, 56],
      [20, 60],
      [0, 66],
      [-26, 50],
    ];
  }

  /** Star field, visible through the north doors and out in the yard. */
  private buildSky(): void {
    const N = 400;
    const positions = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random());
      const r = 170;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi) + 4;
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta) - 30;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xcfe2ff,
      size: 1.5,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      fog: false,
    });
    const stars = new THREE.Points(geo, mat);
    stars.frustumCulled = false;
    this.scene.add(stars);
  }

  private buildLights(): void {
    this.hemi = new THREE.HemisphereLight(0x8fb3e6, 0x2a3346, 1.55);
    this.scene.add(this.hemi);

    const sun = new THREE.DirectionalLight(0xcfe2ff, 2.0);
    sun.position.set(30, 50, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -ARENA_HALF - YARD_DEPTH - 5;
    sun.shadow.camera.right = EAST_OUTER + 5;
    sun.shadow.camera.top = ARENA_HALF + YARD_DEPTH + 5;
    sun.shadow.camera.bottom = -GARDEN_OUTER - 5;
    sun.shadow.camera.far = 200;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    // Accent point lights, one mood per area: blue hall/yard, amber
    // depot, green reactor, cyan corridor, magenta grow-lights in the
    // hydroponics bay, cold blue archive (flickering), warm garden.
    const accents: Array<[number, number, number, number, number?]> = [
      [-30, 4, -30, 0x2a9fd6],
      [30, 4, -30, 0xffa040], // depot
      [-30, 4, 30, 0x35e08a], // reactor
      [30, 4, 30, 0x2a9fd6],
      [-20, 4, -58, 0x2a9fd6], // yard
      [20, 4, -58, 0x2a9fd6],
      [50, 4.5, 4, 0x37c4f0, 45], // corridor
      [66, 4.5, -12, 0xff5fd0, 50], // hydroponics grow lights
      [-14, 3.5, 58, 0xffb36b, 40], // garden lanterns
      [14, 3.5, 58, 0xffb36b, 40],
    ];
    for (const [x, y, z, color, range] of accents) {
      const p = new THREE.PointLight(color, 60, range ?? 55, 1.6);
      p.position.set(x, y, z);
      this.scene.add(p);
    }

    // Archive: a failing cold-blue tube that flickers (animated in update).
    this.flickerLight = new THREE.PointLight(0x6f9fff, 50, 40, 1.6);
    this.flickerLight.position.set(66, 4.5, 16);
    this.scene.add(this.flickerLight);

    // Extraction-gate beacon: dim red while locked, strobes on alarm.
    this.beaconLight = new THREE.PointLight(0xff3030, 25, 30, 1.6);
    this.beaconLight.position.set(0, 4.5, GARDEN_OUTER - 3);
    this.scene.add(this.beaconLight);
  }

  private buildFloor(): void {
    const mat = new THREE.MeshStandardMaterial({
      map: floorTexture(12),
      roughness: 0.85,
      metalness: 0.35,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2), mat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(ARENA_HALF * 2, 44, 0x2a9fd6, 0x1a2a40);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    grid.position.y = 0.01;
    this.scene.add(grid);

    // Outdoor yard ground: same deck plates, tinted colder.
    const yardMap = floorTexture(12);
    yardMap.repeat.set(12, 4);
    const yardMat = new THREE.MeshStandardMaterial({
      map: yardMap,
      color: 0x96a4ba,
      roughness: 0.9,
      metalness: 0.2,
    });
    const yard = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_HALF * 2 + 4, YARD_DEPTH + 1), yardMat);
    yard.rotation.x = -Math.PI / 2;
    yard.position.set(0, 0, -ARENA_HALF - (YARD_DEPTH + 1) / 2);
    yard.receiveShadow = true;
    this.scene.add(yard);

    // East wing deck: same plates, slightly warmer tint.
    const wingMap = floorTexture(9);
    wingMap.repeat.set(9, 14);
    const wingMat = new THREE.MeshStandardMaterial({
      map: wingMap,
      color: 0xb6b09e,
      roughness: 0.85,
      metalness: 0.3,
    });
    const wing = new THREE.Mesh(new THREE.PlaneGeometry(EAST_OUTER - ARENA_HALF, 56), wingMat);
    wing.rotation.x = -Math.PI / 2;
    wing.position.set((ARENA_HALF + EAST_OUTER) / 2, 0, 0);
    wing.receiveShadow = true;
    this.scene.add(wing);

    // Garden: open soil under the stars.
    const soilMat = new THREE.MeshStandardMaterial({
      map: soilTexture(10),
      roughness: 1,
      metalness: 0,
    });
    // Starts at z 45: the arena floor reaches z 44, so an overlap would
    // put two coplanar floor planes along the hall's south wall.
    const garden = new THREE.Mesh(
      new THREE.PlaneGeometry(64, GARDEN_OUTER - ARENA_HALF - 1),
      soilMat
    );
    garden.rotation.x = -Math.PI / 2;
    garden.position.set(0, 0, (ARENA_HALF + 1 + GARDEN_OUTER) / 2);
    garden.receiveShadow = true;
    this.scene.add(garden);

    // Stepping-stone path from the south door to the gate.
    const paveMat = new THREE.MeshStandardMaterial({
      map: pavingTexture(),
      roughness: 0.95,
      metalness: 0,
      transparent: true,
      alphaTest: 0.01,
    });
    const paveGeo = new THREE.PlaneGeometry(1.7, 1.7);
    const paving = new THREE.InstancedMesh(paveGeo, paveMat, 12);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < 12; i++) {
      const wobble = Math.sin(i * 2.4) * 1.1;
      pos.set(wobble, 0.02, 47.5 + i * 2.05);
      const qq = q.clone().multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, i * 1.3))
      );
      m.compose(pos, qq, scl);
      paving.setMatrixAt(i, m);
    }
    paving.instanceMatrix.needsUpdate = true;
    this.scene.add(paving);
  }

  private buildCeiling(): void {
    const map = ceilingTexture(12);
    const mat = new THREE.MeshStandardMaterial({
      map,
      roughness: 0.8,
      metalness: 0.4,
      emissive: 0xbfe2ff,
      emissiveMap: map,
      emissiveIntensity: 0.55,
    });
    const size = ARENA_HALF * 2 + 4;
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    ceiling.rotation.x = Math.PI / 2; // face downward
    ceiling.position.y = CEILING_HEIGHT;
    this.scene.add(ceiling);

    // East wing ceiling (same panels; the wing is fully indoors).
    const wingMap = ceilingTexture(5);
    wingMap.repeat.set(5, 8);
    const wingMat = new THREE.MeshStandardMaterial({
      map: wingMap,
      roughness: 0.8,
      metalness: 0.4,
      emissive: 0xbfe2ff,
      emissiveMap: wingMap,
      emissiveIntensity: 0.55,
    });
    // Starts at x 46: the arena ceiling already covers up to x 46, and
    // two coplanar ceiling planes would z-fight over the doorways.
    const wing = new THREE.Mesh(
      new THREE.PlaneGeometry(EAST_OUTER - ARENA_HALF - 2, 58),
      wingMat
    );
    wing.rotation.x = Math.PI / 2;
    wing.position.set((ARENA_HALF + 2 + EAST_OUTER) / 2, CEILING_HEIGHT, 0);
    this.scene.add(wing);

    // Support beams running across, just below the ceiling.
    const beamMat = new THREE.MeshStandardMaterial({
      color: 0x3a4c6e,
      map: metalTexture(),
      roughness: 0.5,
      metalness: 0.5,
      emissive: 0x4c6694,
      emissiveIntensity: 0.3,
    });
    const beams = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), beamMat, 5);
    const m = new THREE.Matrix4();
    const positions = [-29.3, -14.7, 0, 14.7, 29.3];
    positions.forEach((z, i) => {
      m.makeScale(ARENA_HALF * 2 + 2, 0.4, 1.3);
      m.setPosition(0, CEILING_HEIGHT - 0.2, z);
      beams.setMatrixAt(i, m);
    });
    beams.instanceMatrix.needsUpdate = true;
    this.scene.add(beams);
  }

  private addObstacleBox(cx: number, cz: number, sx: number, sy: number, sz: number): void {
    this.addObstacleBoxAt(cx, cz, sx, sz, 0, sy);
  }

  private addObstacleBoxAt(
    cx: number,
    cz: number,
    sx: number,
    sz: number,
    y0: number,
    y1: number
  ): Obstacle {
    const o: Obstacle = {
      box: new THREE.Box3(
        new THREE.Vector3(cx - sx / 2, y0, cz - sz / 2),
        new THREE.Vector3(cx + sx / 2, y1, cz + sz / 2)
      ),
    };
    this.obstacles.push(o);
    return o;
  }

  private buildWalls(): void {
    const wallMap = wallTexture(1, 1);
    const mat = new THREE.MeshStandardMaterial({
      map: wallMap,
      roughness: 0.7,
      metalness: 0.5,
      emissive: 0x9fc4ee,
      emissiveMap: wallMap,
      emissiveIntensity: 0.4,
    });
    const m = new THREE.Matrix4();

    const H = WALL_HEIGHT;
    const DH = DOOR_HEIGHT;
    const span = ARENA_HALF * 2 + 2;
    const yardZ = -ARENA_HALF - YARD_DEPTH; // outer yard wall line

    // cx, cz, sx, sz, y0, y1
    const segs: Array<[number, number, number, number, number, number]> = [
      // West perimeter (full run).
      [-ARENA_HALF - 1, 0, 2, span, 0, H],
      // South wall with a doorway to the garden at x = 0.
      [-23.75, ARENA_HALF + 1, 42.5, 2, 0, H],
      [23.75, ARENA_HALF + 1, 42.5, 2, 0, H],
      [0, ARENA_HALF + 1, DOOR_WIDTH, 2, DH, H],
      // East wall with two doorways into the east corridor.
      [ARENA_HALF + 1, -27.75, 2, 34.5, 0, H],
      [ARENA_HALF + 1, 4, 2, 19, 0, H],
      [ARENA_HALF + 1, 31.75, 2, 26.5, 0, H],
      [ARENA_HALF + 1, -8, 2, DOOR_WIDTH, DH, H],
      [ARENA_HALF + 1, 16, 2, DOOR_WIDTH, DH, H],
      // East wing shell. Outer runs start at x 46 (the hall's east wall
      // already fills 44..46) so no two wall boxes share the x=44 plane.
      [63, -27, 34, 2, 0, H], // north outer
      [63, 27, 34, 2, 0, H], // south outer
      [EAST_OUTER - 1, 0, 2, 56, 0, H], // east outer
      // Corridor/rooms divider (x = 54.5) with doors to both rooms.
      [54.5, -20.25, 1, 11.5, 0, H],
      [54.5, 2, 1, 23, 0, H],
      [54.5, 22.25, 1, 7.5, 0, H],
      [54.5, -12, 1, DOOR_WIDTH, DH, H],
      [54.5, 16, 1, DOOR_WIDTH, DH, H],
      // Hydroponics/archive divider (z = 4).
      [67, 4, 24, 1, 0, H],
      // Garden perimeter (open sky) with the extraction gate at x = 0.
      [-31, 58, 2, 26, 0, H],
      [31, 58, 2, 26, 0, H],
      [-17.5, GARDEN_OUTER - 1, 29, 2, 0, H],
      [17.5, GARDEN_OUTER - 1, 29, 2, 0, H],
      [0, GARDEN_OUTER - 1, 6, 2, 4, H], // gate lintel
      // North wall with two doorways to the yard (at x = -20 and x = 20).
      [-33.75, -ARENA_HALF - 1, 22.5, 2, 0, H],
      [0, -ARENA_HALF - 1, 35, 2, 0, H],
      [33.75, -ARENA_HALF - 1, 22.5, 2, 0, H],
      [-20, -ARENA_HALF - 1, DOOR_WIDTH, 2, DH, H], // lintels
      [20, -ARENA_HALF - 1, DOOR_WIDTH, 2, DH, H],
      // Yard perimeter (open sky beyond the north wall).
      [-ARENA_HALF - 1, -ARENA_HALF - YARD_DEPTH / 2, 2, YARD_DEPTH, 0, H],
      [ARENA_HALF + 1, -ARENA_HALF - YARD_DEPTH / 2, 2, YARD_DEPTH, 0, H],
      [0, yardZ, ARENA_HALF * 2 + 4, 2, 0, H],
      // Room 1 (north-east): wall along x = 12 with a door at z = -33.
      [12, -39.75, 1, 8.5, 0, H],
      [12, -26, 1, 9, 0, H],
      [12, -33, 1, DOOR_WIDTH, DH, H],
      // Room 1: wall along z = -22 with a door at x = 28.
      [18.5, -22, 14, 1, 0, H],
      [37.75, -22, 14.5, 1, 0, H],
      [28, -22, DOOR_WIDTH, 1, DH, H],
      // Room 2 (south-west): wall along x = -14 with a door at z = 34.
      [-14, 27.5, 1, 8, 0, H],
      [-14, 40.75, 1, 8.5, 0, H],
      [-14, 34, 1, DOOR_WIDTH, DH, H],
      // Room 2: wall along z = 24 with a door at x = -30.
      [-38.75, 24, 12.5, 1, 0, H],
      [-20.5, 24, 14, 1, 0, H],
      [-30, 24, DOOR_WIDTH, 1, DH, H],
    ];

    // One merged mesh with world-scaled UVs per segment: every panel and
    // rivet renders square no matter how long or short the wall run is.
    const wallGeos = segs.map(([cx, cz, sx, sz, y0, y1]) => {
      const g = worldUVBox(sx, y1 - y0, sz, WALL_HEIGHT);
      g.translate(cx, (y0 + y1) / 2, cz);
      this.addObstacleBoxAt(cx, cz, sx, sz, y0, y1);
      return g;
    });
    const walls = new THREE.Mesh(mergeGeometries(wallGeos), mat);
    for (const g of wallGeos) g.dispose();
    walls.castShadow = true;
    walls.receiveShadow = true;
    this.scene.add(walls);

    // Glowing trim strip along the top of full-height wall runs.
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const tops = segs.filter(([, , , , y0, y1]) => y0 === 0 && y1 === H);
    const trimMat = new THREE.MeshBasicMaterial({ color: 0x4fd9ff });
    const trim = new THREE.InstancedMesh(geo, trimMat, tops.length);
    tops.forEach(([cx, cz, sx, sz], i) => {
      m.makeScale(sx + 0.1, 0.15, sz + 0.1);
      m.setPosition(cx, H + 0.07, cz);
      trim.setMatrixAt(i, m);
    });
    trim.instanceMatrix.needsUpdate = true;
    this.scene.add(trim);
  }

  private buildCover(): void {
    // Three crate liveries, each on its own merged mesh. Faces use a
    // centered aspect-preserving crop so emblems stay round on flat crates.
    const crateEmissive = [0x90b6e0, 0xe0c890, 0x90e0b8];
    const crateMats = [0, 1, 2].map((v) => {
      const map = crateTexture(v);
      return new THREE.MeshStandardMaterial({
        map,
        roughness: 0.6,
        metalness: 0.45,
        emissive: crateEmissive[v],
        emissiveMap: map,
        emissiveIntensity: 0.34,
      });
    });
    const pillarMap = pillarTexture(3);
    const pillarMat = new THREE.MeshStandardMaterial({
      map: pillarMap,
      roughness: 0.5,
      metalness: 0.6,
      emissive: 0x9cc6f2,
      emissiveMap: pillarMap,
      emissiveIntensity: 0.38,
    });
    const geo = new THREE.BoxGeometry(1, 1, 1);

    // cx, cz, sx, sy, sz, y0 (stacked crates sit on top of others)
    const crates: Array<[number, number, number, number, number, number?]> = [
      [-12, -8, 3, 2.2, 3],
      [-9, -8, 2, 1.4, 2],
      [14, -14, 4, 2.6, 3],
      [10, 12, 3, 2.0, 4],
      [-16, 14, 3.5, 2.4, 3],
      [22, 2, 3, 1.8, 5],
      [-24, -18, 4, 2.2, 3],
      [-2, 22, 5, 2.0, 3],
      [4, -24, 3, 2.4, 3],
      [-30, 4, 3, 1.6, 6],
      [30, -26, 4, 2.2, 3],
      [-22, 30, 3, 2.0, 3],
      [26, 24, 3.5, 2.6, 3.5],
      [-34, -32, 3, 1.8, 3],
      [36, 10, 2.5, 2.0, 5],
      [-8, -34, 5, 2.2, 2.5],
      // Outdoor yard cover.
      [-12, -54, 3, 2.2, 3],
      [14, -60, 4, 2.4, 3],
      [-2, -66, 5, 2.0, 2.5],
      [-32, -62, 3, 1.8, 3],
      [32, -52, 3, 2.2, 4],
      // Depot room (NE): towers of stacked crates.
      [38, -38, 4, 2.4, 4],
      [38, -38, 3, 2.0, 3, 2.4],
      [21, -40, 3, 2.2, 3],
      [21, -40, 2.4, 1.8, 2.4, 2.2],
      [33, -32, 3, 2.0, 3],
      [40, -27, 2.5, 2.2, 2.5],
      [16, -26, 2.5, 1.8, 2.5],
    ];
    const crateGeos: THREE.BoxGeometry[][] = [[], [], []];
    crates.forEach(([cx, cz, sx, sy, sz, y0 = 0], i) => {
      // Deterministic variant mix, with the depot biased toward olive.
      const variant = cx > 12 && cz < -22 ? (i % 3 === 0 ? 0 : 1) : i % 3;
      const g = coverUVBox(sx, sy, sz);
      g.translate(cx, y0 + sy / 2, cz);
      crateGeos[variant].push(g);
      this.addObstacleBoxAt(cx, cz, sx, sz, y0, y0 + sy);
    });
    for (let v = 0; v < 3; v++) {
      if (crateGeos[v].length === 0) continue;
      const mesh = new THREE.Mesh(mergeGeometries(crateGeos[v]), crateMats[v]);
      for (const g of crateGeos[v]) g.dispose();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
    const m = new THREE.Matrix4();

    const pillars: Array<[number, number]> = [
      [-20, 0],
      [20, -20],
      [0, -14],
      [16, 20],
      [-14, -24],
      [-32, 22],
      [34, -8],
      [8, 34],
    ];
    const pillarMesh = new THREE.InstancedMesh(geo, pillarMat, pillars.length);
    pillarMesh.castShadow = true;
    pillarMesh.receiveShadow = true;
    pillars.forEach(([cx, cz], i) => {
      m.makeScale(2, 6, 2);
      m.setPosition(cx, 3, cz);
      pillarMesh.setMatrixAt(i, m);
      this.addObstacleBox(cx, cz, 2, 6, 2);
    });
    pillarMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(pillarMesh);

    // Glow caps on pillars.
    const capMat = new THREE.MeshBasicMaterial({ color: 0x37c4f0 });
    const caps = new THREE.InstancedMesh(geo, capMat, pillars.length);
    pillars.forEach(([cx, cz], i) => {
      m.makeScale(2.15, 0.12, 2.15);
      m.setPosition(cx, 6.06, cz);
      caps.setMatrixAt(i, m);
    });
    caps.instanceMatrix.needsUpdate = true;
    this.scene.add(caps);
  }

  /**
   * Rounded set dressing: barrel clusters, cable drums, holo consoles and
   * overhead pipe runs. Cylinders and spheres break up the box-only look;
   * lids get their own circular texture so caps are never stretched.
   */
  private buildProps(): void {
    const lidMap = barrelLidTexture();
    const lidMat = new THREE.MeshStandardMaterial({
      map: lidMap,
      roughness: 0.55,
      metalness: 0.5,
      emissive: 0x8aa6cc,
      emissiveMap: lidMap,
      emissiveIntensity: 0.25,
    });
    const sideMats = [0, 1, 2].map((v) => {
      const map = barrelTexture(v);
      return new THREE.MeshStandardMaterial({
        map,
        roughness: 0.55,
        metalness: 0.5,
        emissive: [0x90b6e0, 0xe0b070, 0x70e0a0][v],
        emissiveMap: map,
        emissiveIntensity: 0.3,
      });
    });

    // x, z, variant, radius scale, height scale
    const barrels: Array<[number, number, number, number, number]> = [
      // Hall clusters.
      [-7.6, -8.4, 0, 1.0, 1.0],
      [-6.4, -9.5, 0, 0.92, 0.94],
      [-7.2, -10.5, 1, 1.0, 1.05],
      [23.6, 5.6, 0, 1.0, 1.0],
      [24.7, 4.5, 1, 0.9, 0.92],
      [-26.5, -20.5, 0, 1.05, 1.0],
      [5.8, 19.8, 1, 0.95, 1.0],
      // Depot (NE room): fuel drums.
      [34.6, -39.4, 1, 1.0, 1.0],
      [35.8, -38.3, 1, 0.95, 1.05],
      [33.6, -37.4, 0, 0.9, 0.9],
      [17.8, -30.2, 1, 1.0, 1.0],
      // Reactor (SW room): toxic green cells.
      [-22.8, 30.6, 2, 1.0, 1.0],
      [-21.6, 31.8, 2, 0.92, 1.08],
      [-35.5, 39.5, 2, 1.0, 0.95],
      // Yard.
      [-9.2, -51.6, 0, 1.0, 1.0],
      [-10.4, -50.7, 1, 0.92, 0.95],
      [28.8, -55.2, 0, 1.0, 1.0],
      [30.0, -54.2, 1, 1.0, 1.05],
      [29.4, -56.5, 0, 0.9, 0.9],
    ];
    const barrelGeo = new THREE.CylinderGeometry(0.55, 0.55, 1.5, 14);
    const byVariant: number[][] = [[], [], []];
    barrels.forEach(([, , v], i) => byVariant[v].push(i));
    const m = new THREE.Matrix4();
    for (let v = 0; v < 3; v++) {
      const idx = byVariant[v];
      if (idx.length === 0) continue;
      const mesh = new THREE.InstancedMesh(barrelGeo, [sideMats[v], lidMat, lidMat], idx.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      idx.forEach((bi, i) => {
        const [x, z, , s, sy] = barrels[bi];
        m.makeScale(s, sy, s);
        m.setPosition(x, (1.5 * sy) / 2, z);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
    }
    // One collision box per cluster (they hug each other anyway).
    const clusters: Array<[number, number, number, number]> = [
      [-7, -9.5, 2.8, 3.4],
      [24.1, 5, 2.4, 2.4],
      [-26.5, -20.5, 1.3, 1.3],
      [5.8, 19.8, 1.2, 1.2],
      [34.7, -38.4, 3.4, 3.2],
      [17.8, -30.2, 1.3, 1.3],
      [-22.2, 31.2, 2.6, 2.6],
      [-35.5, 39.5, 1.3, 1.3],
      [-9.8, -51.1, 2.4, 2.2],
      [29.4, -55.35, 2.6, 3.4],
    ];
    for (const [cx, cz, sx, sz] of clusters) this.addObstacleBoxAt(cx, cz, sx, sz, 0, 1.55);

    // A couple of tipped-over barrels (lying on their side).
    const tipped: Array<[number, number, number, number]> = [
      [-29.5, -55.8, 0.5, 1],
      [15, 8, 2.2, 0],
    ];
    for (const [x, z, yaw, v] of tipped) {
      const b = new THREE.Mesh(barrelGeo, [sideMats[v], lidMat, lidMat]);
      b.rotation.set(Math.PI / 2, 0, yaw);
      b.position.set(x, 0.55, z);
      b.castShadow = true;
      b.receiveShadow = true;
      this.scene.add(b);
      // A yawed lying cylinder reaches up to 0.75·|sin| + 0.55·|cos| ≈ 0.93
      // from center on the world axes, so the box is 1.9 wide, not 1.5.
      this.addObstacleBoxAt(x, z, 1.9, 1.9, 0, 1.1);
    }

    // Cable drums: two big flanged spools lying on their sides.
    const steelMap = metalTexture();
    const steelMat = new THREE.MeshStandardMaterial({
      map: steelMap,
      color: 0x6a7f9e,
      roughness: 0.45,
      metalness: 0.6,
      emissive: 0x33486a,
      emissiveMap: steelMap,
      emissiveIntensity: 0.35,
    });
    const flangeGeo = new THREE.CylinderGeometry(1.15, 1.15, 0.18, 18);
    const coreGeo = new THREE.CylinderGeometry(0.55, 0.55, 1.5, 14);
    const drums: Array<[number, number, number]> = [
      [12.5, -64.5, 0.4],
      [-36.5, -13.5, 1.2],
    ];
    for (const [x, z, yaw] of drums) {
      const drum = new THREE.Group();
      for (const off of [-0.84, 0.84]) {
        const f = new THREE.Mesh(flangeGeo, [steelMat, lidMat, lidMat]);
        f.rotation.z = Math.PI / 2;
        f.position.x = off;
        f.castShadow = true;
        f.receiveShadow = true;
        drum.add(f);
      }
      const core = new THREE.Mesh(coreGeo, steelMat);
      core.rotation.z = Math.PI / 2;
      core.castShadow = true;
      drum.add(core);
      drum.position.set(x, 1.15, z);
      drum.rotation.y = yaw;
      this.scene.add(drum);
      // Yawed flanges (radius 1.15 at ±0.84 along the axis) reach ~1.42
      // from center on both world axes, so the AABB needs to be 2.9 wide.
      this.addObstacleBoxAt(x, z, 2.9, 2.9, 0, 2.3);
    }

    // Holo consoles: angled screens on pedestals, glowing in the dark.
    const screenMat = new THREE.MeshBasicMaterial({ map: screenTexture() });
    const consoleDark = new THREE.MeshStandardMaterial({
      map: steelMap,
      color: 0x3c4c68,
      roughness: 0.5,
      metalness: 0.5,
      emissive: 0x22324c,
      emissiveMap: steelMap,
      emissiveIntensity: 0.4,
    });
    const blinkMat = new THREE.MeshBasicMaterial({ color: 0x57ff9a });
    const baseGeo = coverUVBox(1.5, 0.95, 0.7);
    const screenGeo = new THREE.BoxGeometry(1.3, 0.65, 0.07);
    const blinkGeo = new THREE.BoxGeometry(0.07, 0.07, 0.02);
    const consoles: Array<[number, number, number]> = [
      [1.8, -12.4, Math.PI],
      [-33.6, 30.6, 0.8],
      [33.5, -26, -2.4],
      [-18, -68.4, 0],
    ];
    for (const [x, z, yaw] of consoles) {
      const c = new THREE.Group();
      const base = new THREE.Mesh(baseGeo, consoleDark);
      base.position.y = 0.475;
      base.castShadow = true;
      base.receiveShadow = true;
      const screen = new THREE.Mesh(screenGeo, [
        consoleDark,
        consoleDark,
        consoleDark,
        consoleDark,
        screenMat,
        consoleDark,
      ]);
      screen.position.set(0, 1.18, 0.12);
      screen.rotation.x = -0.42;
      const blink1 = new THREE.Mesh(blinkGeo, blinkMat);
      blink1.position.set(-0.55, 0.78, 0.36);
      const blink2 = new THREE.Mesh(blinkGeo, new THREE.MeshBasicMaterial({ color: 0xffb050 }));
      blink2.position.set(-0.42, 0.78, 0.36);
      c.add(base, screen, blink1, blink2);
      c.position.set(x, 0, z);
      c.rotation.y = yaw;
      this.scene.add(c);
      // Rotated base corners reach sqrt(0.75² + 0.35²) ≈ 0.83 from center.
      this.addObstacleBoxAt(x, z, 1.7, 1.7, 0, 1.4);
      this.humSpots.push({ x, y: 1.1, z, kind: "console" });
    }

    // Overhead pipe runs hugging the hall's perimeter walls, with collar
    // rings and a few vertical drops down to floor junctions.
    const pipeGeo = new THREE.CylinderGeometry(0.16, 0.16, 1, 10);
    const collarGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.22, 10);
    const elbowGeo = new THREE.SphereGeometry(0.24, 10, 8);
    const RUN = 84;
    // x, y, z, axis ("x"/"y"/"z"), length
    const pipes: Array<[number, number, number, string, number]> = [
      [0, 5.5, 43.62, "x", RUN],
      [0, 5.95, 43.7, "x", RUN],
      [-43.62, 5.5, 0, "z", RUN],
      [-43.7, 5.95, 0, "z", RUN],
      [43.62, 5.5, 0, "z", RUN],
      [43.7, 5.95, 0, "z", RUN],
      // Vertical drops into floor junction boxes.
      [-36, 2.75, 43.62, "y", 5.5],
      [36, 2.75, 43.62, "y", 5.5],
      [-43.62, 2.75, 30, "y", 5.5],
      [43.62, 2.75, -24, "y", 5.5],
    ];
    const pipeMesh = new THREE.InstancedMesh(pipeGeo, steelMat, pipes.length);
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    pipes.forEach(([x, y, z, axis, len], i) => {
      eul.set(axis === "z" ? Math.PI / 2 : 0, 0, axis === "x" ? Math.PI / 2 : 0);
      q.setFromEuler(eul);
      pos.set(x, y, z);
      scl.set(1, len, 1);
      m.compose(pos, q, scl);
      pipeMesh.setMatrixAt(i, m);
    });
    pipeMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(pipeMesh);

    // Collars along the horizontal runs + elbows atop the drops.
    const collarXs = [-31.5, -10.5, 10.5, 31.5];
    const collars: Array<[number, number, number, string]> = [];
    for (const t of collarXs) {
      collars.push([t, 5.5, 43.62, "x"]);
      collars.push([-43.62, 5.5, t, "z"]);
      collars.push([43.62, 5.5, t, "z"]);
    }
    const collarMesh = new THREE.InstancedMesh(collarGeo, steelMat, collars.length);
    collars.forEach(([x, y, z, axis], i) => {
      eul.set(axis === "z" ? Math.PI / 2 : 0, 0, axis === "x" ? Math.PI / 2 : 0);
      q.setFromEuler(eul);
      pos.set(x, y, z);
      scl.set(1, 1, 1);
      m.compose(pos, q, scl);
      collarMesh.setMatrixAt(i, m);
    });
    collarMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(collarMesh);

    const elbows: Array<[number, number]> = [
      [-36, 43.62],
      [36, 43.62],
    ];
    const elbowMesh = new THREE.InstancedMesh(elbowGeo, steelMat, elbows.length + 2);
    elbows.forEach(([x, z], i) => {
      m.makeScale(1, 1, 1);
      m.setPosition(x, 5.5, z);
      elbowMesh.setMatrixAt(i, m);
    });
    m.setPosition(-43.62, 5.5, 30);
    elbowMesh.setMatrixAt(elbows.length, m);
    m.setPosition(43.62, 5.5, -24);
    elbowMesh.setMatrixAt(elbows.length + 1, m);
    elbowMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(elbowMesh);

    // Floor junction boxes where the drops land.
    const junctionGeo = coverUVBox(0.8, 1.0, 0.5);
    const junctions: Array<[number, number, number]> = [
      [-36, 43.85, 0],
      [36, 43.85, 0],
      [-43.85, 30, Math.PI / 2],
      [43.85, -24, Math.PI / 2],
    ];
    for (const [x, z, yaw] of junctions) {
      const j = new THREE.Mesh(junctionGeo, consoleDark);
      j.position.set(x, 0.5, z);
      j.rotation.y = yaw;
      j.castShadow = true;
      this.scene.add(j);
      const flat = yaw === 0;
      this.addObstacleBoxAt(x, z, flat ? 0.8 : 0.5, flat ? 0.5 : 0.8, 0, 1.0);
    }
  }

  /**
   * Sliding doors connecting the hall to the two rooms and the yard.
   * Each door is a dynamic obstacle that opens for anyone nearby.
   */
  private buildDoors(): void {
    const panelMap = metalTexture();
    const panelMat = new THREE.MeshStandardMaterial({
      map: panelMap,
      color: 0x52688c,
      roughness: 0.4,
      metalness: 0.5,
      emissive: 0x2a3c5c,
      emissiveMap: panelMap,
      emissiveIntensity: 0.55,
    });
    // Door accents are color-coded by destination zone.
    const stripeColor = [0x4fd9ff, 0x4fd9ff, 0xffb050, 0x57ff9a, 0x4fd9ff, 0xff5fd0, 0x6f9fff, 0xcfe8a0];
    const frameColor = [0x37c4f0, 0x37c4f0, 0xe89638, 0x3fd47e, 0x37c4f0, 0xd64fb0, 0x4f7fff, 0xa0c878];
    const geo = new THREE.BoxGeometry(1, 1, 1);

    // x, z, axis the wall runs along, zones on either side, frame depth
    // (perimeter walls are 2 thick, interior 1), optional lock tag/width.
    const defs: Array<{
      x: number;
      z: number;
      axis: "x" | "z";
      a: number;
      b: number;
      deep?: boolean;
      tag?: string;
      w?: number;
      h?: number;
    }> = [
      { x: -20, z: -ARENA_HALF - 1, axis: "x", a: 0, b: 1, deep: true }, // hall ↔ yard
      { x: 20, z: -ARENA_HALF - 1, axis: "x", a: 0, b: 1, deep: true },
      { x: 12, z: -33, axis: "z", a: 0, b: 2 }, // hall ↔ depot
      { x: 28, z: -22, axis: "x", a: 0, b: 2 },
      { x: -14, z: 34, axis: "z", a: 0, b: 3, tag: "reactor" }, // hall ↔ reactor (locked)
      { x: -30, z: 24, axis: "x", a: 0, b: 3, tag: "reactor" },
      { x: ARENA_HALF + 1, z: -8, axis: "z", a: 0, b: 4, deep: true }, // hall ↔ corridor
      { x: ARENA_HALF + 1, z: 16, axis: "z", a: 0, b: 4, deep: true },
      { x: 54.5, z: -12, axis: "z", a: 4, b: 5 }, // corridor ↔ hydroponics
      { x: 54.5, z: 16, axis: "z", a: 4, b: 6 }, // corridor ↔ archive
      { x: 0, z: ARENA_HALF + 1, axis: "x", a: 0, b: 7, deep: true }, // hall ↔ garden
      // Extraction gate: leads out of the map, locked until the finale.
      { x: 0, z: GARDEN_OUTER - 1, axis: "x", a: 7, b: 7, deep: true, tag: "gate", w: 6, h: 4 },
    ];
    for (const d of defs) {
      const w = d.w ?? DOOR_WIDTH;
      const h = d.h ?? DOOR_HEIGHT;
      const sx = d.axis === "x" ? w : 1.2;
      const sz = d.axis === "x" ? 1.2 : w;
      const depth = d.deep ? 2.4 : 1.4;
      const obstacle = this.addObstacleBoxAt(d.x, d.z, sx, sz, 0, h);
      this.doors.push(
        new Door(
          this.scene,
          d.x,
          d.z,
          d.axis,
          d.a,
          d.b,
          obstacle,
          geo,
          panelMat,
          new THREE.MeshBasicMaterial({ color: stripeColor[d.b] }),
          new THREE.MeshBasicMaterial({ color: frameColor[d.b] }),
          depth,
          w,
          h,
          d.tag ?? null,
          d.tag !== undefined // tagged doors start locked
        )
      );
    }

    // Precompute zone routing (BFS over the door graph) so navigation
    // can cross multiple rooms: nextHop[a][b] = first zone after `a`.
    const adj: number[][] = Array.from({ length: ZONE_COUNT }, () => []);
    for (const d of this.doors) {
      if (d.zoneA === d.zoneB) continue;
      adj[d.zoneA].push(d.zoneB);
      adj[d.zoneB].push(d.zoneA);
    }
    this.nextHop = Array.from({ length: ZONE_COUNT }, () => new Array(ZONE_COUNT).fill(-1));
    for (let src = 0; src < ZONE_COUNT; src++) {
      const prev = new Array(ZONE_COUNT).fill(-1);
      const queue = [src];
      const seen = new Array(ZONE_COUNT).fill(false);
      seen[src] = true;
      while (queue.length) {
        const z = queue.shift()!;
        for (const n of adj[z]) {
          if (seen[n]) continue;
          seen[n] = true;
          prev[n] = z;
          queue.push(n);
        }
      }
      for (let dst = 0; dst < ZONE_COUNT; dst++) {
        if (dst === src || !seen[dst]) continue;
        let step = dst;
        while (prev[step] !== src) step = prev[step];
        this.nextHop[src][dst] = step;
      }
    }
  }

  /** Unlock all doors carrying `tag` (keycard used, finale triggered). */
  unlockTag(tag: string): void {
    for (const d of this.doors) {
      if (d.tag === tag && d.locked) d.unlock(this.audio);
    }
  }

  /** Tag of a locked door within `radius` of `pos`, or null. */
  lockedDoorNear(pos: THREE.Vector3, radius: number): string | null {
    for (const d of this.doors) {
      if (!d.locked) continue;
      const dx = d.center.x - pos.x;
      const dz = d.center.z - pos.z;
      if (dx * dx + dz * dz < radius * radius) return d.tag;
    }
    return null;
  }

  /** Per-frame world animation: doors, pickups, light flicker, alarm. */
  update(dt: number, isAgentNear: (x: number, z: number, radius: number) => boolean): void {
    this.time += dt;
    for (const door of this.doors) {
      door.update(dt, isAgentNear(door.center.x, door.center.z, 4.5), this.audio);
    }

    // Floating plot items: bob and spin until collected.
    for (const p of this.pickups) {
      if (p.taken) continue;
      p.mesh.position.y = p.y + Math.sin(this.time * 2.2) * 0.12;
      p.mesh.rotation.y += dt * 1.8;
    }

    // Archive tube on its last legs: mostly on, occasional dropouts.
    const f = Math.sin(this.time * 31) + Math.sin(this.time * 17.3);
    this.flickerLight.intensity = f > -1.2 ? 50 : 6;

    // Gate beacon: slow breathing while locked, hard strobe on alarm.
    if (this.alarm) {
      this.beaconLight.intensity = Math.sin(this.time * 9) > 0 ? 90 : 5;
      // Throbbing red ambience so the whole facility feels on alert.
      this.hemi.intensity = 1.5 + Math.sin(this.time * 5.2) * 0.55;
    } else {
      this.beaconLight.intensity = 18 + Math.sin(this.time * 2.4) * 10;
    }
  }

  /** Facility-wide alert: red wash, strobing gate beacon. */
  setAlarm(on: boolean): void {
    this.alarm = on;
    if (on) {
      this.hemi.color.setHex(0xff5a40);
      this.hemi.groundColor.setHex(0x4a1410);
      this.hemi.intensity = 1.9;
      this.fog.color.setHex(0x1c0a0a);
      (this.scene.background as THREE.Color).setHex(0x0c0406);
    } else {
      this.hemi.color.setHex(0x8fb3e6);
      this.hemi.groundColor.setHex(0x2a3346);
      this.hemi.intensity = 1.55;
      this.fog.color.setHex(0x070d18);
      (this.scene.background as THREE.Color).setHex(0x05080f);
    }
  }

  /**
   * Which zone a point is in: 0 hall, 1 yard, 2 depot, 3 reactor,
   * 4 east corridor, 5 hydroponics, 6 archive, 7 garden.
   */
  zoneOf(p: THREE.Vector3): number {
    if (p.x > ARENA_HALF + 2) {
      if (p.x < 54.5) return 4;
      return p.z < 4 ? 5 : 6;
    }
    if (p.z > ARENA_HALF + 2) return 7;
    if (p.z < -ARENA_HALF - 1) return 1;
    if (p.x > 12 && p.z < -22) return 2;
    if (p.x < -14 && p.z > 24) return 3;
    return 0;
  }

  /**
   * Rough walkable bounds per zone; used to keep patrol targets inside
   * an enemy's assigned area.
   */
  zoneRect(zone: number): [number, number, number, number] {
    return ZONE_RECTS[zone];
  }

  /**
   * If `from` and `target` are in different zones, returns the waypoint
   * of the best door leading toward the next zone on the route (multi-
   * hop routes are precomputed over the door graph).
   */
  doorTarget(from: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 | null {
    const za = this.zoneOf(from);
    const zb = this.zoneOf(target);
    if (za === zb) return null;
    const next = this.nextHop[za][zb];
    if (next < 0) return null;
    let best: Door | null = null;
    let bestCost = Infinity;
    for (const d of this.doors) {
      const connects =
        (d.zoneA === za && d.zoneB === next) || (d.zoneB === za && d.zoneA === next);
      if (!connects) continue;
      const cost =
        Math.hypot(d.center.x - from.x, d.center.z - from.z) +
        Math.hypot(d.center.x - target.x, d.center.z - target.z);
      if (cost < bestCost) {
        bestCost = cost;
        best = d;
      }
    }
    return best ? best.center : null;
  }

  /**
   * Two elevated platforms reachable via staircases. Slabs, steps and
   * supports are all solid AABBs, so collision/raycasts work everywhere
   * and the step-up logic lets anything walk the stairs.
   */
  private buildPlatforms(): void {
    const deckMap = floorTexture(2);
    const deckMat = new THREE.MeshStandardMaterial({
      map: deckMap,
      roughness: 0.7,
      metalness: 0.5,
      emissive: 0x8fb6e0,
      emissiveMap: deckMap,
      emissiveIntensity: 0.28,
    });
    const supportMap = pillarTexture(2);
    const supportMat = new THREE.MeshStandardMaterial({
      map: supportMap,
      roughness: 0.5,
      metalness: 0.6,
      emissive: 0x9cc6f2,
      emissiveMap: supportMap,
      emissiveIntensity: 0.35,
    });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const m = new THREE.Matrix4();

    // cx, cz, width, depth, height
    const platforms: Array<[number, number, number, number, number]> = [
      [-28, -26, 16, 12, 3.2],
      [28, 20, 14, 12, 3.2],
    ];

    const slabs = new THREE.InstancedMesh(geo, deckMat, platforms.length);
    slabs.castShadow = true;
    slabs.receiveShadow = true;
    const supports = new THREE.InstancedMesh(geo, supportMat, platforms.length * 4);
    supports.castShadow = true;
    const trimMat = new THREE.MeshBasicMaterial({ color: 0x37c4f0 });
    const trims = new THREE.InstancedMesh(geo, trimMat, platforms.length * 4);

    platforms.forEach(([cx, cz, w, d, h], i) => {
      m.makeScale(w, 0.5, d);
      m.setPosition(cx, h - 0.25, cz);
      slabs.setMatrixAt(i, m);
      this.obstacles.push({
        box: new THREE.Box3(
          new THREE.Vector3(cx - w / 2, h - 0.5, cz - d / 2),
          new THREE.Vector3(cx + w / 2, h, cz + d / 2)
        ),
      });

      // Corner support columns (solid).
      const ix = w / 2 - 1.2;
      const iz = d / 2 - 1.2;
      const corners: Array<[number, number]> = [
        [cx - ix, cz - iz],
        [cx + ix, cz - iz],
        [cx - ix, cz + iz],
        [cx + ix, cz + iz],
      ];
      corners.forEach(([sx, sz], j) => {
        m.makeScale(0.7, h - 0.5, 0.7);
        m.setPosition(sx, (h - 0.5) / 2, sz);
        supports.setMatrixAt(i * 4 + j, m);
        this.addObstacleBox(sx, sz, 0.7, h - 0.5, 0.7);
      });

      // Glowing edge trim around the deck.
      const edges: Array<[number, number, number, number]> = [
        [cx, cz - d / 2, w + 0.16, 0.16],
        [cx, cz + d / 2, w + 0.16, 0.16],
        [cx - w / 2, cz, 0.16, d + 0.16],
        [cx + w / 2, cz, 0.16, d + 0.16],
      ];
      edges.forEach(([ex, ez, sx, sz], j) => {
        m.makeScale(sx, 0.1, sz);
        m.setPosition(ex, h + 0.05, ez);
        trims.setMatrixAt(i * 4 + j, m);
      });
    });
    slabs.instanceMatrix.needsUpdate = true;
    supports.instanceMatrix.needsUpdate = true;
    trims.instanceMatrix.needsUpdate = true;
    this.scene.add(slabs, supports, trims);

    // Staircases: edge point, descent direction, width, total height.
    const stairDefs: Array<{ px: number; pz: number; dx: number; dz: number; h: number }> = [
      { px: -20, pz: -29, dx: 1, dz: 0, h: 3.2 }, // platform A, east side
      { px: -28, pz: -20, dx: 0, dz: 1, h: 3.2 }, // platform A, north side
      { px: 28, pz: 14, dx: 0, dz: -1, h: 3.2 }, // platform B, south side
    ];
    const STEPS = 8;
    const RUN = 0.85;
    const WIDTH = 4;
    const steps = new THREE.InstancedMesh(geo, deckMat, stairDefs.length * STEPS);
    steps.castShadow = true;
    steps.receiveShadow = true;

    stairDefs.forEach(({ px, pz, dx, dz, h }, s) => {
      for (let k = 0; k < STEPS; k++) {
        const top = (h * (STEPS - k)) / STEPS;
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
        top: new THREE.Vector3(px - dx * 1.5, h, pz - dz * 1.5),
      });
    });
    steps.instanceMatrix.needsUpdate = true;
    this.scene.add(steps);
  }

  /**
   * Highest walkable surface under a point: the tallest obstacle top
   * that lies within step-up reach below/at the entity's feet.
   * Returns 0 (arena floor) when nothing is underneath.
   */
  groundHeight(pos: THREE.Vector3, radius: number): number {
    let ground = 0;
    for (const o of this.obstacles) {
      if (o.enabled === false) continue;
      const b = o.box;
      const top = b.max.y;
      if (top <= ground || top > pos.y + STEP_HEIGHT) continue;
      if (pos.x + radius < b.min.x || pos.x - radius > b.max.x) continue;
      if (pos.z + radius < b.min.z || pos.z - radius > b.max.z) continue;
      ground = top;
    }
    return ground;
  }

  /**
   * Waypoint an enemy should walk toward to reach an elevated player:
   * the bottom of the best staircase, or its top once the climb began.
   */
  nearestStairTarget(from: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 | null {
    let best: StairWay | null = null;
    let bestCost = Infinity;
    for (const w of this.stairWays) {
      const cost =
        Math.hypot(w.bottom.x - from.x, w.bottom.z - from.z) +
        Math.hypot(w.top.x - target.x, w.top.z - target.z);
      if (cost < bestCost) {
        bestCost = cost;
        best = w;
      }
    }
    if (!best) return null;
    const dBottom = Math.hypot(best.bottom.x - from.x, best.bottom.z - from.z);
    return from.y < 0.3 && dBottom > 1.4 ? best.bottom : best.top;
  }

  /**
   * Raycast against obstacle AABBs. Returns distance to nearest hit or
   * Infinity. Far cheaper than three.js Raycaster against meshes.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
    let nearest = Infinity;
    for (const o of this.obstacles) {
      if (o.enabled === false) continue;
      const d = rayBoxDistance(origin, dir, o.box);
      if (d >= 0 && d < maxDist && d < nearest) nearest = d;
    }
    // Floor everywhere; ceiling only over the arena (the yard is open sky).
    if (dir.y < -1e-6) {
      const d = -origin.y / dir.y;
      if (d >= 0 && d < maxDist && d < nearest) nearest = d;
    } else if (dir.y > 1e-6 && !this.arenaMode) {
      const d = (CEILING_HEIGHT - origin.y) / dir.y;
      if (d >= 0 && d < maxDist && d < nearest) {
        const hx = origin.x + dir.x * d;
        const hz = origin.z + dir.z * d;
        // Indoors only: the arena proper and the east wing have ceilings;
        // the yard and the garden are open sky.
        const inArena =
          hx > -ARENA_HALF - 2 && hx < ARENA_HALF + 2 && hz > -ARENA_HALF - 2 && hz < ARENA_HALF + 2;
        const inWing = hx >= ARENA_HALF + 2 && hx < EAST_OUTER && hz > -28 && hz < 28;
        if (inArena || inWing) nearest = d;
      }
    }
    return nearest;
  }

  /** True if the segment between two points is blocked by an obstacle. */
  blocksLine(a: THREE.Vector3, b: THREE.Vector3): boolean {
    _dir.subVectors(b, a);
    const len = _dir.length();
    if (len < 1e-6) return false;
    _dir.multiplyScalar(1 / len);
    return this.raycast(a, _dir, len) < len;
  }

  /**
   * Resolve a sphere (XZ circle + height range) against all obstacles,
   * pushing `pos` out horizontally. Used by player and enemies.
   * Boxes whose top is within STEP_HEIGHT of the feet are walkable
   * surfaces, not walls, and are skipped (the ground query handles them).
   */
  collide(pos: THREE.Vector3, radius: number, height: number): void {
    for (const o of this.obstacles) {
      if (o.enabled === false) continue;
      const b = o.box;
      if (b.max.y - pos.y <= STEP_HEIGHT || pos.y + height < b.min.y) continue;
      const cx = Math.max(b.min.x, Math.min(pos.x, b.max.x));
      const cz = Math.max(b.min.z, Math.min(pos.z, b.max.z));
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const distSq = dx * dx + dz * dz;
      if (distSq < radius * radius) {
        if (distSq > 1e-9) {
          const dist = Math.sqrt(distSq);
          const push = radius - dist;
          pos.x += (dx / dist) * push;
          pos.z += (dz / dist) * push;
        } else {
          // Center inside the box: push out along smallest penetration axis.
          const left = pos.x - b.min.x;
          const right = b.max.x - pos.x;
          const front = pos.z - b.min.z;
          const back = b.max.z - pos.z;
          const min = Math.min(left, right, front, back);
          if (min === left) pos.x = b.min.x - radius;
          else if (min === right) pos.x = b.max.x + radius;
          else if (min === front) pos.z = b.min.z - radius;
          else pos.z = b.max.z + radius;
        }
      }
    }
  }
}

/**
 * Proximity-triggered sliding door: two panels that retract into the
 * wall pockets. While closed its obstacle blocks movement, bullets and
 * line of sight.
 */
class Door {
  readonly center = new THREE.Vector3();
  readonly zoneA: number;
  readonly zoneB: number;
  /** Lock group ("reactor", "gate") or null for plain doors. */
  readonly tag: string | null;
  locked: boolean;
  private startsLocked: boolean;
  private axis: "x" | "z";
  private width: number;
  private openAmount = 0;
  private wasOpen = false;
  private obstacle: Obstacle;
  private slideA: THREE.Group;
  private slideB: THREE.Group;
  private lampMat: THREE.MeshBasicMaterial;

  constructor(
    scene: THREE.Scene,
    x: number,
    z: number,
    axis: "x" | "z",
    zoneA: number,
    zoneB: number,
    obstacle: Obstacle,
    geo: THREE.BufferGeometry,
    panelMat: THREE.Material,
    stripeMat: THREE.Material,
    frameMat: THREE.Material,
    frameDepth: number,
    width: number,
    height: number,
    tag: string | null,
    locked: boolean
  ) {
    this.center.set(x, 0, z);
    this.axis = axis;
    this.zoneA = zoneA;
    this.zoneB = zoneB;
    this.tag = tag;
    this.locked = locked;
    this.startsLocked = locked;
    this.width = width;
    this.obstacle = obstacle;
    obstacle.enabled = true;

    const half = width / 2;
    const H = height;
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x232c3e,
      roughness: 0.55,
      metalness: 0.6,
    });
    // Place a panel-local part: `a` runs along the wall, `d` across it.
    const put = (
      g: THREE.Group,
      mesh: THREE.Mesh,
      a: number,
      y: number,
      d: number,
      sa: number,
      sy: number,
      sd: number
    ): void => {
      if (axis === "x") {
        mesh.scale.set(sa, sy, sd);
        mesh.position.set(a, y, d);
      } else {
        mesh.scale.set(sd, sy, sa);
        mesh.position.set(d, y, a);
      }
      g.add(mesh);
    };
    const makePanel = (dir: number): THREE.Group => {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      // Main slab with a smaller recessed plate on both faces.
      put(g, new THREE.Mesh(geo, panelMat), dir * (half / 2), H / 2, 0, half, H, 0.5);
      for (const side of [0.27, -0.27]) {
        put(
          g,
          new THREE.Mesh(geo, darkMat),
          dir * (half / 2),
          H * 0.58,
          side,
          half - 0.9,
          H * 0.42,
          0.06
        );
      }
      // Center-edge warning stripe (the two stripes meet when closed).
      put(g, new THREE.Mesh(geo, stripeMat), dir * 0.09, H / 2, 0, 0.12, H - 0.25, 0.58);
      // Eye-level viewport slit, proud of the recessed plates.
      put(
        g,
        new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xbfe8ff })),
        dir * (half / 2),
        H * 0.62,
        0,
        half * 0.4,
        0.12,
        0.66
      );
      // Kick plate with a thin glow strip above it.
      put(g, new THREE.Mesh(geo, darkMat), dir * (half / 2), 0.3, 0, half - 0.2, 0.6, 0.62);
      put(g, new THREE.Mesh(geo, stripeMat), dir * (half / 2), 0.66, 0, half - 0.2, 0.07, 0.6);
      scene.add(g);
      return g;
    };
    this.slideA = makePanel(1);
    this.slideB = makePanel(-1);

    // Static glowing frame: two jambs and a header. Each piece straddles
    // the cut edge of the opening (half embedded, half proud) so no frame
    // face is coplanar with a wall face — coplanar faces z-fight.
    for (const along of [half, -half]) {
      const jamb = new THREE.Mesh(geo, frameMat);
      if (axis === "x") {
        jamb.scale.set(0.3, H + 0.2, frameDepth);
        jamb.position.set(x + along, (H + 0.2) / 2, z);
      } else {
        jamb.scale.set(frameDepth, H + 0.2, 0.3);
        jamb.position.set(x, (H + 0.2) / 2, z + along);
      }
      scene.add(jamb);
    }
    const header = new THREE.Mesh(geo, frameMat);
    if (axis === "x") {
      header.scale.set(width + 0.2, 0.25, frameDepth);
      header.position.set(x, H, z);
    } else {
      header.scale.set(frameDepth, 0.25, width + 0.2);
      header.position.set(x, H, z);
    }
    scene.add(header);

    // Status lamp above the header: green = unlocked, red = locked.
    this.lampMat = new THREE.MeshBasicMaterial({
      color: locked ? 0xff3030 : 0x4fff7a,
    });
    const lamp = new THREE.Mesh(geo, this.lampMat);
    if (axis === "x") {
      lamp.scale.set(0.5, 0.16, frameDepth + 0.08);
    } else {
      lamp.scale.set(frameDepth + 0.08, 0.16, 0.5);
    }
    lamp.position.set(x, H + 0.3, z);
    scene.add(lamp);
  }

  unlock(audio: AudioFX | null): void {
    this.locked = false;
    this.lampMat.color.setHex(0x4fff7a);
    audio?.unlock(this.center.x, this.center.z);
  }

  relock(): void {
    this.locked = this.startsLocked;
    this.lampMat.color.setHex(this.locked ? 0xff3030 : 0x4fff7a);
  }

  update(dt: number, agentNear: boolean, audio: AudioFX | null): void {
    const open = agentNear && !this.locked;
    if (open !== this.wasOpen) {
      this.wasOpen = open;
      audio?.doorMove(this.center.x, this.center.z, open);
    }
    const target = open ? 1 : 0;
    if (this.openAmount < target) {
      this.openAmount = Math.min(target, this.openAmount + dt * 2.4);
    } else if (this.openAmount > target) {
      this.openAmount = Math.max(target, this.openAmount - dt * 1.6);
    }
    // Retract fully past the jamb (its outer face sits at half + 0.15).
    const slide = this.openAmount * (this.width / 2 + 0.3);
    if (this.axis === "x") {
      this.slideA.position.x = this.center.x + slide;
      this.slideB.position.x = this.center.x - slide;
    } else {
      this.slideA.position.z = this.center.z + slide;
      this.slideB.position.z = this.center.z - slide;
    }
    this.obstacle.enabled = this.openAmount < 0.5;
  }
}

const _dir = new THREE.Vector3();

/** Slab-method ray vs AABB. Returns entry distance or -1 if no hit. */
export function rayBoxDistance(origin: THREE.Vector3, dir: THREE.Vector3, box: THREE.Box3): number {
  let tmin = 0;
  let tmax = Infinity;

  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? origin.x : axis === 1 ? origin.y : origin.z;
    const d = axis === 0 ? dir.x : axis === 1 ? dir.y : dir.z;
    const lo = axis === 0 ? box.min.x : axis === 1 ? box.min.y : box.min.z;
    const hi = axis === 0 ? box.max.x : axis === 1 ? box.max.y : box.max.z;

    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return -1;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}
