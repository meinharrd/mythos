import * as THREE from "three";

const MAX_PARTICLES = 2048;
const MAX_TRACERS = 48;
const GRAVITY = -22;

/**
 * Zero-allocation effects: one Points cloud drives all particles via
 * preallocated typed arrays; tracers are a fixed pool of stretched boxes.
 */
export class Effects {
  private positions = new Float32Array(MAX_PARTICLES * 3);
  private velocities = new Float32Array(MAX_PARTICLES * 3);
  private colors = new Float32Array(MAX_PARTICLES * 3);
  private life = new Float32Array(MAX_PARTICLES);
  private maxLife = new Float32Array(MAX_PARTICLES);
  private gravityOn = new Uint8Array(MAX_PARTICLES);
  private cursor = 0;
  private points: THREE.Points;
  private geometry: THREE.BufferGeometry;

  private tracers: Array<{ mesh: THREE.Mesh; life: number }> = [];
  private tracerCursor = 0;

  constructor(scene: THREE.Scene) {
    this.geometry = new THREE.BufferGeometry();
    // Park dead particles far below the floor.
    for (let i = 0; i < MAX_PARTICLES; i++) this.positions[i * 3 + 1] = -1000;
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));

    const mat = new THREE.PointsMaterial({
      size: 0.14,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geometry, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);

    const tracerGeo = new THREE.BoxGeometry(0.025, 0.025, 1);
    for (let i = 0; i < MAX_TRACERS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x9fe8ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(tracerGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }
  }

  private emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    r: number,
    g: number,
    b: number,
    life: number,
    gravity: boolean
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.velocities[i * 3] = vx;
    this.velocities[i * 3 + 1] = vy;
    this.velocities[i * 3 + 2] = vz;
    this.colors[i * 3] = r;
    this.colors[i * 3 + 1] = g;
    this.colors[i * 3 + 2] = b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.gravityOn[i] = gravity ? 1 : 0;
  }

  burst(
    point: THREE.Vector3,
    count: number,
    color: THREE.Color,
    speed: number,
    life: number,
    gravity = true
  ): void {
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      const s = speed * (0.4 + Math.random() * 0.6);
      this.emit(
        point.x,
        point.y,
        point.z,
        Math.sin(phi) * Math.cos(theta) * s,
        Math.cos(phi) * s,
        Math.sin(phi) * Math.sin(theta) * s,
        color.r,
        color.g,
        color.b,
        life * (0.5 + Math.random() * 0.5),
        gravity
      );
    }
  }

  impact(point: THREE.Vector3, normalHint: THREE.Vector3): void {
    for (let i = 0; i < 10; i++) {
      const s = 3 + Math.random() * 5;
      this.emit(
        point.x,
        point.y,
        point.z,
        (normalHint.x + (Math.random() - 0.5) * 1.4) * s,
        (normalHint.y + Math.random() * 0.9) * s,
        (normalHint.z + (Math.random() - 0.5) * 1.4) * s,
        1.0,
        0.85,
        0.4,
        0.25 + Math.random() * 0.25,
        true
      );
    }
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const t = this.tracers[this.tracerCursor];
    this.tracerCursor = (this.tracerCursor + 1) % MAX_TRACERS;
    const mesh = t.mesh;
    _mid.addVectors(from, to).multiplyScalar(0.5);
    const len = from.distanceTo(to);
    mesh.position.copy(_mid);
    mesh.scale.set(1, 1, Math.max(0.1, len));
    mesh.lookAt(to);
    mesh.visible = true;
    (mesh.material as THREE.MeshBasicMaterial).opacity = 0.85;
    t.life = 0.07;
  }

  update(dt: number): void {
    const pos = this.positions;
    const vel = this.velocities;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        pos[i * 3 + 1] = -1000;
        continue;
      }
      if (this.gravityOn[i]) vel[i * 3 + 1] += GRAVITY * dt;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (pos[i * 3 + 1] < 0.02 && this.gravityOn[i]) {
        pos[i * 3 + 1] = 0.02;
        vel[i * 3 + 1] *= -0.4;
        vel[i * 3] *= 0.7;
        vel[i * 3 + 2] *= 0.7;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    // Colors are written on emit; without this flag they stay black on
    // the GPU and additive-blended black is invisible.
    this.geometry.attributes.color.needsUpdate = true;

    for (const t of this.tracers) {
      if (!t.mesh.visible) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.mesh.visible = false;
      } else {
        (t.mesh.material as THREE.MeshBasicMaterial).opacity = (t.life / 0.07) * 0.85;
      }
    }
  }
}

const _mid = new THREE.Vector3();
