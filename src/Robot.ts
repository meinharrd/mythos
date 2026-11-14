import * as THREE from "three";

export type EnemyKind = "stalker" | "sentinel" | "brute" | "warden";

/**
 * A procedurally built, fully rigged robot. All parts share one unit box
 * geometry (scaled per part); joints are Groups so limbs rotate around
 * their anatomical pivots (shoulders, hips).
 */
export interface RobotRig {
  group: THREE.Group;
  torso: THREE.Group; // pivot at the hip, used for running lean
  head: THREE.Group; // pivot at the neck; skull, visor and antenna inside
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  core: THREE.Mesh;
  /** Warden only: chest shield plate, pivoting up at its top edge. */
  shield?: THREE.Group;
}

const BOX = new THREE.BoxGeometry(1, 1, 1);
// Shared rounded primitives for joints and greebles. Low-poly on purpose:
// at robot scale 10 segments read as smooth.
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
const SPH = new THREE.SphereGeometry(0.5, 10, 8);

/**
 * Parts never move relative to their joint group (animation rotates the
 * groups), so their local matrices are composed once at build time instead
 * of every frame — with ~25 parts per robot across a full pool plus
 * corpses, the per-frame recompose was real frame time.
 */
function freeze(m: THREE.Mesh): THREE.Mesh {
  m.matrixAutoUpdate = false;
  m.updateMatrix();
  return m;
}

export function part(
  parent: THREE.Object3D,
  mat: THREE.Material,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number
): THREE.Mesh {
  const m = new THREE.Mesh(BOX, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  parent.add(m);
  return freeze(m);
}

/** Cylinder of diameter `d` and length `len`, oriented along `axis`. */
export function cyl(
  parent: THREE.Object3D,
  mat: THREE.Material,
  d: number,
  len: number,
  x: number,
  y: number,
  z: number,
  axis: "x" | "y" | "z" = "y"
): THREE.Mesh {
  const m = new THREE.Mesh(CYL, mat);
  m.scale.set(d, len, d);
  if (axis === "x") m.rotation.z = Math.PI / 2;
  else if (axis === "z") m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return freeze(m);
}

export function ball(
  parent: THREE.Object3D,
  mat: THREE.Material,
  d: number,
  x: number,
  y: number,
  z: number
): THREE.Mesh {
  const m = new THREE.Mesh(SPH, mat);
  m.scale.setScalar(d);
  m.position.set(x, y, z);
  parent.add(m);
  return freeze(m);
}

/** Build a humanoid robot, feet at the group origin, ~1.9 units tall. */
export function buildRobot(
  kind: EnemyKind,
  bodyMat: THREE.Material,
  accentMat: THREE.Material,
  coreMat: THREE.Material
): RobotRig {
  // Width multiplier: brutes are bulky, stalkers are slim runners.
  const w = kind === "warden" ? 1.7 : kind === "brute" ? 1.45 : kind === "stalker" ? 0.85 : 1;
  const group = new THREE.Group();
  const hipY = 0.95;

  // Legs: pivot groups at the hip so they swing from the right joint.
  const makeLeg = (side: number): THREE.Group => {
    const leg = new THREE.Group();
    leg.position.set(0.18 * w * side, hipY, 0);
    part(leg, bodyMat, 0.17 * w, 0.5, 0.2, 0, -0.25, 0); // thigh
    part(leg, accentMat, 0.14 * w, 0.45, 0.17, 0, -0.68, 0.02); // shin
    part(leg, accentMat, 0.18 * w, 0.1, 0.32, 0, -0.92, 0.06); // foot
    ball(leg, bodyMat, 0.17 * w, 0, -0.47, 0.04); // knee joint
    cyl(leg, accentMat, 0.13, 0.16 * w, 0, -0.86, 0.02, "x"); // ankle servo
    part(leg, bodyMat, 0.05 * w, 0.3, 0.04, 0.08 * w * side, -0.62, -0.07); // piston rod
    group.add(leg);
    return leg;
  };
  const legL = makeLeg(1);
  const legR = makeLeg(-1);

  // Torso pivots at the hip.
  const torso = new THREE.Group();
  torso.position.y = hipY;
  group.add(torso);
  part(torso, accentMat, 0.42 * w, 0.24, 0.3, 0, 0.06, 0); // pelvis
  part(torso, accentMat, 0.34 * w, 0.14, 0.26, 0, 0.24, 0); // waist
  cyl(torso, bodyMat, 0.4 * w, 0.06, 0, 0.17, 0); // waist gimbal ring
  part(torso, bodyMat, 0.58 * w, 0.52, 0.34, 0, 0.48, 0); // chest
  const core = part(torso, coreMat, 0.16, 0.16, 0.06, 0, 0.5, 0.18 * 1); // chest core
  cyl(torso, accentMat, 0.22, 0.05, 0, 0.5, 0.18, "z"); // core bezel ring
  // Chest vents and hip actuators.
  part(torso, accentMat, 0.16 * w, 0.035, 0.02, 0.16 * w, 0.32, 0.18);
  part(torso, accentMat, 0.16 * w, 0.035, 0.02, -0.16 * w, 0.32, 0.18);
  cyl(torso, bodyMat, 0.16, 0.12, 0.26 * w, 0, 0, "x"); // hip joints
  cyl(torso, bodyMat, 0.16, 0.12, -0.26 * w, 0, 0, "x");
  // Backpack power cell with a glowing cap.
  cyl(torso, accentMat, 0.2, 0.36, 0, 0.5, -0.22);
  ball(torso, coreMat, 0.1, 0, 0.7, -0.22);

  // Head is a pivot group so the visor (and antenna) turn with it.
  const head = new THREE.Group();
  head.position.set(0, 0.9, 0);
  torso.add(head);
  part(head, bodyMat, 0.27, 0.24, 0.27, 0, 0, 0); // skull
  part(head, coreMat, 0.2, 0.055, 0.05, 0, 0.02, 0.15); // visor
  cyl(head, accentMat, 0.1, 0.05, 0.16, 0.02, 0, "x"); // ear sensors
  cyl(head, accentMat, 0.1, 0.05, -0.16, 0.02, 0, "x");
  cyl(head, bodyMat, 0.16, 0.08, 0, -0.16, 0); // neck collar
  if (kind === "stalker") {
    part(head, accentMat, 0.03, 0.26, 0.03, 0.1, 0.22, -0.05); // antenna
    ball(head, coreMat, 0.07, 0.1, 0.36, -0.05); // antenna beacon
  }
  if (kind === "sentinel") {
    // Sensor dish + whip antenna on the free shoulder.
    cyl(torso, accentMat, 0.3, 0.05, 0.42 * w, 0.78, 0);
    cyl(torso, accentMat, 0.03, 0.24, 0.42 * w, 0.92, 0);
    ball(torso, coreMat, 0.06, 0.42 * w, 1.05, 0);
  }
  if (kind === "brute") {
    part(torso, accentMat, 0.3, 0.22, 0.34, 0.42 * w, 0.74, 0); // shoulder pads
    part(torso, accentMat, 0.3, 0.22, 0.34, -0.42 * w, 0.74, 0);
    // Exhaust stacks with hot tips.
    cyl(torso, accentMat, 0.12, 0.45, 0.28 * w, 0.88, -0.18);
    cyl(torso, accentMat, 0.12, 0.45, -0.28 * w, 0.88, -0.18);
    ball(torso, coreMat, 0.08, 0.28 * w, 1.12, -0.18);
    ball(torso, coreMat, 0.08, -0.28 * w, 1.12, -0.18);
  }

  let shield: THREE.Group | undefined;
  if (kind === "warden") {
    // Heavy pauldrons, a sensor crown and a tower shield bolted to the
    // chest. The shield hinges at its top edge: it swings up to vent,
    // exposing the core behind it.
    part(torso, accentMat, 0.34, 0.26, 0.4, 0.44 * w, 0.76, 0);
    part(torso, accentMat, 0.34, 0.26, 0.4, -0.44 * w, 0.76, 0);
    for (const sx of [-0.09, 0, 0.09]) part(head, accentMat, 0.04, 0.14, 0.04, sx, 0.18, -0.02);
    ball(head, coreMat, 0.06, 0, 0.27, -0.02);
    // Twin power cells on the back: the weak spot.
    cyl(torso, coreMat, 0.12, 0.3, 0.14, 0.52, -0.3);
    cyl(torso, coreMat, 0.12, 0.3, -0.14, 0.52, -0.3);
    shield = new THREE.Group();
    shield.position.set(0, 0.86, 0.24);
    torso.add(shield);
    part(shield, accentMat, 0.86, 0.78, 0.07, 0, -0.38, 0.04); // plate
    part(shield, bodyMat, 0.94, 0.08, 0.1, 0, -0.02, 0.04); // top rim
    part(shield, bodyMat, 0.94, 0.08, 0.1, 0, -0.76, 0.04); // bottom rim
    part(shield, coreMat, 0.5, 0.04, 0.03, 0, -0.38, 0.09); // glowing slit
  }

  // Arms: pivot at the shoulder.
  const makeArm = (side: number): THREE.Group => {
    const arm = new THREE.Group();
    arm.position.set(0.38 * w * side, hipY + 0.62, 0);
    const isCannon = kind === "sentinel" && side < 0;
    cyl(arm, bodyMat, 0.18, 0.14, 0, 0, 0, "x"); // shoulder joint
    if (isCannon) {
      part(arm, bodyMat, 0.16, 0.32, 0.18, 0, -0.16, 0); // upper arm
      part(arm, accentMat, 0.22, 0.5, 0.22, 0, -0.55, 0); // cannon housing
      cyl(arm, bodyMat, 0.27, 0.1, 0, -0.78, 0); // muzzle brake ring
      part(arm, coreMat, 0.09, 0.16, 0.09, 0, -0.84, 0); // glowing muzzle
      cyl(arm, accentMat, 0.06, 0.4, 0.12, -0.5, 0.1); // coolant tube
    } else {
      part(arm, bodyMat, 0.14, 0.42, 0.16, 0, -0.2, 0); // upper arm
      part(arm, accentMat, 0.12, 0.38, 0.14, 0, -0.58, 0.03); // forearm
      part(arm, accentMat, 0.16, 0.15, 0.17, 0, -0.84, 0.05); // fist
      ball(arm, bodyMat, 0.14, 0, -0.41, 0.02); // elbow joint
      cyl(arm, bodyMat, 0.12, 0.06, 0, -0.76, 0.04); // wrist collar
    }
    group.add(arm);
    return arm;
  };
  const armL = makeArm(1);
  const armR = makeArm(-1);

  return { group, torso, head, armL, armR, legL, legR, core, shield };
}
