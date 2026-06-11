import * as THREE from "three";
import { RobotRig, part, cyl, ball } from "./Robot";

export const HIP_Y = 0.95;

export interface HumanMats {
  outfit: THREE.Material; // jacket, in the player's color
  pants: THREE.Material;
  skin: THREE.Material;
  hair: THREE.Material;
  gear: THREE.Material; // boots, straps, backpack, rifle
  visor: THREE.Material; // glowing goggles + comm light
}

/**
 * Superset of the robot rig: knees and elbows articulate so the walk
 * reads as a human gait instead of stiff robot leg-swings.
 */
export interface HumanRig extends RobotRig {
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
}

/**
 * A human pilot, feet at the group origin, ~2 units tall. Limbs are
 * rounded (cylinders/spheres) and two-segmented; the right arm is the
 * gun arm and carries a rifle along the forearm. Curved surfaces meet
 * boxes at angles everywhere, so nothing shares a coplanar face.
 */
export function buildHuman(m: HumanMats): HumanRig {
  const group = new THREE.Group();

  // Legs: hip pivot + knee pivot. Thigh and shin are cylinders capped
  // with joint balls; the knee group folds backward during the swing.
  const makeLeg = (side: number): { hip: THREE.Group; knee: THREE.Group } => {
    const hip = new THREE.Group();
    hip.position.set(0.15 * side, HIP_Y, 0);
    group.add(hip);
    cyl(hip, m.pants, 0.18, 0.42, 0, -0.22, 0); // thigh
    ball(hip, m.pants, 0.17, 0, -0.45, 0); // knee cap

    const knee = new THREE.Group();
    knee.position.set(0, -0.45, 0);
    hip.add(knee);
    cyl(knee, m.pants, 0.145, 0.32, 0, -0.16, 0); // shin
    part(knee, m.gear, 0.16, 0.16, 0.18, 0, -0.4, 0.01); // boot shaft
    part(knee, m.gear, 0.17, 0.09, 0.3, 0, -0.46, 0.06); // boot
    return { hip, knee };
  };
  const legL = makeLeg(1);
  const legR = makeLeg(-1);

  // Torso: pelvis, tapered jacket (wider chest over narrower abdomen),
  // belt, strap and backpack. Pivots at the hip for the running lean.
  const torso = new THREE.Group();
  torso.position.y = HIP_Y;
  group.add(torso);
  part(torso, m.pants, 0.34, 0.16, 0.23, 0, 0.05, 0); // pelvis
  part(torso, m.gear, 0.36, 0.06, 0.25, 0, 0.155, 0); // belt
  part(torso, m.gear, 0.08, 0.05, 0.06, 0.1, 0.155, 0.14); // belt pouch
  part(torso, m.outfit, 0.36, 0.24, 0.24, 0, 0.32, 0); // abdomen
  part(torso, m.outfit, 0.42, 0.32, 0.27, 0, 0.58, 0); // chest
  ball(torso, m.outfit, 0.2, 0.17, 0.72, 0); // shoulder caps round the silhouette
  ball(torso, m.outfit, 0.2, -0.17, 0.72, 0);
  part(torso, m.gear, 0.09, 0.56, 0.02, -0.1, 0.46, 0.14); // chest strap
  const core = part(torso, m.visor, 0.06, 0.05, 0.025, -0.1, 0.62, 0.15); // comm light
  part(torso, m.gear, 0.28, 0.36, 0.12, 0, 0.5, -0.19); // backpack
  cyl(torso, m.outfit, 0.2, 0.06, 0, 0.76, 0); // collar

  // Head: sphere skull with a hair cap (larger sphere, offset up/back),
  // goggle band and a glowing visor that stands proud of everything.
  const head = new THREE.Group();
  head.position.set(0, 0.8, 0);
  torso.add(head);
  cyl(head, m.skin, 0.12, 0.1, 0, -0.02, 0); // neck
  ball(head, m.skin, 0.27, 0, 0.13, 0.005); // skull
  ball(head, m.hair, 0.285, 0, 0.165, -0.03); // hair cap
  cyl(head, m.gear, 0.272, 0.05, 0, 0.16, 0.002); // goggle strap
  part(head, m.visor, 0.15, 0.05, 0.045, 0, 0.16, 0.125); // goggles
  part(head, m.skin, 0.045, 0.05, 0.04, 0, 0.07, 0.125); // nose
  ball(head, m.gear, 0.09, 0.135, 0.13, 0.01); // headset cans
  ball(head, m.gear, 0.09, -0.135, 0.13, 0.01);

  // Arms: shoulder pivot + elbow pivot. Sleeves end at the elbow,
  // forearms and hands are bare skin.
  const makeArm = (side: number): { shoulder: THREE.Group; elbow: THREE.Group } => {
    const shoulder = new THREE.Group();
    shoulder.position.set(0.26 * side, HIP_Y + 0.66, 0);
    group.add(shoulder);
    cyl(shoulder, m.outfit, 0.13, 0.3, 0, -0.17, 0); // upper arm sleeve

    const elbow = new THREE.Group();
    elbow.position.set(0, -0.33, 0);
    shoulder.add(elbow);
    ball(elbow, m.skin, 0.115, 0, 0, 0); // elbow joint
    cyl(elbow, m.skin, 0.095, 0.24, 0, -0.13, 0); // forearm
    ball(elbow, m.skin, 0.11, 0, -0.28, 0); // fist
    return { shoulder, elbow };
  };
  const armL = makeArm(1);
  const armR = makeArm(-1);

  // Rifle rides the right forearm so it follows the aim.
  part(armR.elbow, m.gear, 0.055, 0.38, 0.1, 0, -0.36, 0.05); // receiver
  part(armR.elbow, m.gear, 0.045, 0.15, 0.13, 0, -0.16, -0.01); // stock
  cyl(armR.elbow, m.gear, 0.04, 0.3, 0, -0.62, 0.05); // barrel
  part(armR.elbow, m.gear, 0.035, 0.07, 0.05, 0, -0.5, 0.1); // front grip

  return {
    group,
    torso,
    head,
    armL: armL.shoulder,
    armR: armR.shoulder,
    legL: legL.hip,
    legR: legR.hip,
    kneeL: legL.knee,
    kneeR: legR.knee,
    elbowL: armL.elbow,
    elbowR: armR.elbow,
    core,
  };
}
