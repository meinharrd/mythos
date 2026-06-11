import * as THREE from "three";
import { buildHuman, HumanRig, HIP_Y } from "./Human";
import type { PeerState } from "./Net";

const LERP_RATE = 14; // exponential smoothing toward the network pose
const SNAP_DIST = 6; // teleport instead of gliding across the map

const SKIN_TONES = [0xf6cdb2, 0xeab48f, 0xd29a6c, 0xa9714b, 0x7c4f33, 0x5d3a26];
const HAIR_COLORS = [0x241d18, 0x4a3220, 0x7a5230, 0xa8835a, 0xb5b2ad, 0x732f1d];

/** Stable hash from a peer id so everyone sees the same person. */
function hashOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

function makeTag(name: string): {
  sprite: THREE.Sprite;
  setHealth: (frac: number) => void;
} {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const tex = new THREE.CanvasTexture(canvas);
  let lastFrac = -1;

  const draw = (frac: number): void => {
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = "bold 26px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(8, 20, 35, 0.65)";
    const tw = Math.min(240, ctx.measureText(name).width + 24);
    ctx.fillRect(128 - tw / 2, 2, tw, 34);
    ctx.fillStyle = "#e8f4ff";
    ctx.fillText(name, 128, 28, 232);
    // Health bar.
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.fillRect(48, 44, 160, 10);
    ctx.fillStyle = frac > 0.35 ? "#4fd9ff" : "#ff4f6d";
    ctx.fillRect(48, 44, 160 * Math.max(0, frac), 10);
    tex.needsUpdate = true;
  };
  draw(1);

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(1.9, 0.475, 1);
  return {
    sprite,
    setHealth: (frac: number) => {
      const q = Math.round(frac * 32) / 32;
      if (q === lastFrac) return;
      lastFrac = q;
      draw(q);
    },
  };
}

/**
 * Visual stand-in for another player: a human pilot whose outfit color,
 * skin tone and hair derive from the peer id, smoothed toward the latest
 * network pose, with a floating name tag + health bar.
 */
export class RemoteAvatar {
  readonly group: THREE.Group;
  /** Latest known feet position straight from the network. */
  readonly target = new THREE.Vector3();
  targetYaw = 0;
  targetPitch = 0;
  health = 300;
  maxHealth = 300;
  name = "";
  /** performance.now() of the last received update (local clock). */
  lastSeen = 0;
  /** Sender wall-clock of the last update (their clock, monotonic per peer). */
  lastT = 0;
  /** Last applied shot sequence number. */
  shotSeq = -1;
  /** Last applied death sequence number. */
  deathSeq = -1;
  kills = 0;
  deaths = 0;

  private rig: HumanRig;
  private tag: ReturnType<typeof makeTag> | null = null;
  private scene: THREE.Scene;
  private walkPhase = 0;
  private idlePhase = Math.random() * 10; // desync breathing between avatars
  private prevPos = new THREE.Vector3();
  private dead = false;

  constructor(scene: THREE.Scene, id: string, envMap: THREE.Texture) {
    this.scene = scene;
    const h = hashOf(id);
    // Outfit hue skips the 10°-60° flesh-tone band so jackets never
    // read as bare skin next to the actual skin material.
    let hueDeg = h % 310;
    if (hueDeg >= 10) hueDeg += 50;
    const hue = hueDeg / 360;
    this.rig = buildHuman({
      outfit: new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(hue, 0.55, 0.38),
        roughness: 0.75,
        metalness: 0.15,
        envMap,
        envMapIntensity: 0.35,
      }),
      pants: new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(hue, 0.3, 0.2),
        roughness: 0.85,
        metalness: 0.08,
        envMap,
        envMapIntensity: 0.35,
      }),
      skin: new THREE.MeshStandardMaterial({
        color: SKIN_TONES[(h >>> 9) % SKIN_TONES.length],
        roughness: 0.7,
        metalness: 0,
      }),
      hair: new THREE.MeshStandardMaterial({
        color: HAIR_COLORS[(h >>> 17) % HAIR_COLORS.length],
        roughness: 0.9,
        metalness: 0,
      }),
      gear: new THREE.MeshStandardMaterial({
        color: 0x33383f,
        roughness: 0.55,
        metalness: 0.5,
        envMap,
        envMapIntensity: 0.6,
      }),
      visor: new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHSL((hue + 0.5) % 1, 1, 0.62),
      }),
    });
    this.group = this.rig.group;
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    scene.add(this.group);
  }

  applyState(state: PeerState, now: number): void {
    this.lastSeen = now;
    this.lastT = state.t ?? 0;
    if (state.n && state.n !== this.name) {
      this.name = state.n;
      if (this.tag) this.group.remove(this.tag.sprite);
      this.tag = makeTag(this.name);
      this.tag.sprite.position.y = 2.25;
      this.group.add(this.tag.sprite);
    }
    this.target.set(state.x, state.y, state.z);
    if (this.target.distanceTo(this.group.position) > SNAP_DIST) {
      this.group.position.copy(this.target);
      this.prevPos.copy(this.target);
    }
    // Camera yaw 0 looks toward -z, but the model is built facing +z.
    this.targetYaw = state.yaw + Math.PI;
    this.targetPitch = state.pitch;
    this.health = state.h;
    this.kills = state.k ?? 0;
    this.deaths = state.d ?? 0;
    this.tag?.setHealth(state.h / this.maxHealth);

    const nowDead = state.h <= 0;
    if (nowDead !== this.dead) {
      this.dead = nowDead;
      this.group.visible = !nowDead;
    }
  }

  /** Eye position for shot replication (tracer origin). */
  get muzzle(): THREE.Vector3 {
    return _muzzle.set(
      this.group.position.x,
      this.group.position.y + 1.55,
      this.group.position.z
    );
  }

  /** Center of the hittable capsule. */
  get hitCenter(): THREE.Vector3 {
    return _hit.set(this.group.position.x, this.group.position.y + 1.0, this.group.position.z);
  }

  get alive(): boolean {
    return !this.dead;
  }

  update(dt: number): void {
    const p = this.group.position;
    const a = 1 - Math.exp(-LERP_RATE * dt);
    p.lerp(this.target, a);

    // Shortest-arc yaw smoothing.
    let dy = this.targetYaw - this.group.rotation.y;
    dy = ((dy + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (dy < -Math.PI) dy += Math.PI * 2;
    this.group.rotation.y += dy * a;
    this.rig.head.rotation.x = -this.targetPitch * 0.8;

    // Gait driven by actual displacement.
    const speed = _vel.subVectors(p, this.prevPos).length() / Math.max(dt, 1e-4);
    this.prevPos.copy(p);
    this.idlePhase += dt;
    const r = this.rig;
    if (speed > 0.6) {
      const frac = Math.min(speed / 9, 1); // walk → run intensity
      this.walkPhase += dt * Math.min(speed, 11) * 1.7;
      const s = Math.sin(this.walkPhase);
      const c = Math.cos(this.walkPhase);
      const amp = 0.35 + 0.35 * frac;

      // Thighs counter-swing; each knee folds while its leg swings
      // forward (ground clearance) and lands straight at heel strike.
      r.legL.rotation.x = s * amp;
      r.legR.rotation.x = -s * amp;
      r.kneeL.rotation.x = Math.max(0, -c) * (0.5 + 0.7 * frac);
      r.kneeR.rotation.x = Math.max(0, c) * (0.5 + 0.7 * frac);

      // Free arm swings opposite the legs; the elbow pumps with it.
      r.armL.rotation.x = -s * amp * 0.7;
      r.elbowL.rotation.x = -0.4 - Math.max(0, -s) * 0.5;

      // Weight shift: forward lean, hip sway, the head holds level,
      // and the torso dips at mid-stride.
      r.torso.rotation.x = 0.05 + 0.07 * frac;
      r.torso.rotation.z = s * 0.05;
      r.head.rotation.z = -s * 0.05;
      r.torso.position.y = HIP_Y - Math.abs(c) * 0.045 * frac;
    } else {
      // Settle into an idle stance with a slow breathing cycle.
      r.legL.rotation.x *= 0.85;
      r.legR.rotation.x *= 0.85;
      r.kneeL.rotation.x += (0.08 - r.kneeL.rotation.x) * 0.15;
      r.kneeR.rotation.x += (0.08 - r.kneeR.rotation.x) * 0.15;
      r.armL.rotation.x *= 0.85;
      r.torso.rotation.x *= 0.85;
      r.torso.rotation.z *= 0.85;
      r.head.rotation.z *= 0.85;
      const breath = Math.sin(this.idlePhase * 1.7);
      r.torso.position.y = HIP_Y + breath * 0.008;
      r.elbowL.rotation.x = -0.45 + breath * 0.03;
    }
    // Right arm permanently raised: that's the gun arm. A touch of
    // elbow bend keeps it from looking like a rigid pole.
    r.armR.rotation.x = -1.2 - this.targetPitch * 0.7;
    r.elbowR.rotation.x = -0.25;
  }

  dispose(): void {
    this.scene.remove(this.group);
  }
}

const _muzzle = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _vel = new THREE.Vector3();
