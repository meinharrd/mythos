import * as THREE from "three";
import { World } from "./World";
import { AudioFX } from "./AudioFX";
import type { TouchControls } from "./Touch";

const EYE_HEIGHT = 1.7;
const RADIUS = 0.45;
const GRAVITY = -30;
const WALK_SPEED = 8.5;
const SPRINT_MULT = 1.55;
const JUMP_SPEED = 10.5;
const ACCEL_GROUND = 80;
const ACCEL_AIR = 18;
const FRICTION = 10;
const MOUSE_SENS = 0.0021;
const TOUCH_SENS = 0.0045; // look radians per drag pixel
const TURN_SPEED = 2.4; // arrow-key yaw rate (rad/s)

export class Player {
  readonly position = new THREE.Vector3(0, 0, 18); // feet position
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  onGround = true;
  health = 300;
  maxHealth = 300;
  alive = true;
  /** Set on mobile; merged into the input below. */
  touch: TouchControls | null = null;

  private keys = new Set<string>();
  private camera: THREE.PerspectiveCamera;
  private world: World;
  private audio: AudioFX;
  private bobPhase = 0;
  private stepTimer = 0;
  private landImpulse = 0;
  recoilPitch = 0;

  constructor(camera: THREE.PerspectiveCamera, world: World, audio: AudioFX) {
    this.camera = camera;
    this.world = world;
    this.audio = audio;

    document.addEventListener("keydown", (e) => {
      // Arrow keys move/turn; don't let them scroll the page.
      if (e.code.startsWith("Arrow")) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
    });
    document.addEventListener("keyup", (e) => this.keys.delete(e.code));
    document.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement === null) return;
      this.yaw -= e.movementX * MOUSE_SENS;
      this.pitch -= e.movementY * MOUSE_SENS;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
    });
  }

  /**
   * Default spawn is outside in the garden, on the stone path, facing
   * the south door into the facility (yaw 0 looks north, toward -z).
   * Multiplayer passes its own spawn points.
   */
  reset(x = 0, z = 62, yaw = 0): void {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.health = this.maxHealth;
    this.alive = true;
    this.onGround = true;
    this.recoilPitch = 0;
  }

  get eyePosition(): THREE.Vector3 {
    return _eye.set(this.position.x, this.position.y + EYE_HEIGHT, this.position.z);
  }

  takeDamage(amount: number): void {
    if (!this.alive) return;
    this.health -= amount;
    this.audio.hurt();
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
    }
  }

  heal(amount: number): void {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  isSprinting(): boolean {
    return (
      this.keys.has("ShiftLeft") ||
      this.keys.has("ShiftRight") ||
      (this.touch?.sprint ?? false)
    );
  }

  update(dt: number): void {
    // Touch look: drag deltas accumulated since the last frame. Applied
    // even while dead, matching mouse-look behavior.
    if (this.touch) {
      const look = this.touch.consumeLook();
      this.yaw -= look.dx * TOUCH_SENS;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - look.dy * TOUCH_SENS));
    }

    if (!this.alive) {
      this.updateCamera(dt);
      return;
    }

    // Arrow keys: up/down move, left/right turn (no strafing).
    if (this.keys.has("ArrowLeft")) this.yaw += TURN_SPEED * dt;
    if (this.keys.has("ArrowRight")) this.yaw -= TURN_SPEED * dt;

    // Wish direction in world space from input.
    let ix = 0;
    let iz = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) iz += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) iz -= 1;
    if (this.keys.has("KeyA")) ix -= 1;
    if (this.keys.has("KeyD")) ix += 1;
    if (this.touch) {
      ix += this.touch.moveX;
      iz += this.touch.moveY;
    }

    // forward = (-sin, 0, -cos), right = (cos, 0, -sin)
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    _wish.set(-sin * iz + cos * ix, 0, -cos * iz - sin * ix);
    // Clamp instead of normalize: partial joystick deflection walks.
    const mag = _wish.length();
    if (mag > 1) _wish.multiplyScalar(1 / mag);
    const moving = mag > 0.05;
    if (!moving) _wish.set(0, 0, 0);

    // Sprint must scale acceleration too: ground friction balances
    // acceleration at accel/FRICTION, which sits below the sprint speed
    // cap — scaling only the cap would make sprint a no-op.
    const sprint = this.isSprinting() ? SPRINT_MULT : 1;
    const maxSpeed = WALK_SPEED * sprint;
    const accel = (this.onGround ? ACCEL_GROUND : ACCEL_AIR) * sprint;

    // Horizontal friction on ground.
    if (this.onGround) {
      const f = Math.max(0, 1 - FRICTION * dt);
      this.velocity.x *= f;
      this.velocity.z *= f;
    }

    this.velocity.x += _wish.x * accel * dt;
    this.velocity.z += _wish.z * accel * dt;

    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (hSpeed > maxSpeed) {
      const s = maxSpeed / hSpeed;
      this.velocity.x *= s;
      this.velocity.z *= s;
    }

    // Touch jumps stay queued while airborne and trigger on landing.
    const wantJump =
      this.keys.has("Space") || (this.onGround && (this.touch?.consumeJump() ?? false));
    if (wantJump && this.onGround) {
      this.velocity.y = JUMP_SPEED;
      this.onGround = false;
      this.audio.jump();
    }

    this.velocity.y += GRAVITY * dt;
    const wasAirborne = !this.onGround;

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.position.y += this.velocity.y * dt;

    this.world.collide(this.position, RADIUS, EYE_HEIGHT);
    // Outer safety clamp around the whole map; the perimeter walls are
    // the real bounds.
    const b = this.world.bounds;
    this.position.x = Math.max(b.minX, Math.min(b.maxX, this.position.x));
    this.position.z = Math.max(b.minZ, Math.min(b.maxZ, this.position.z));

    // Land on whatever walkable surface is underneath (floor, stairs,
    // platforms) — but never while still moving upward from a jump.
    const ground = this.world.groundHeight(this.position, RADIUS * 0.6);
    if (this.velocity.y <= 0 && this.position.y <= ground + 1e-3) {
      if (wasAirborne && this.velocity.y < -8) {
        this.landImpulse = Math.min(0.2, -this.velocity.y * 0.012);
        this.audio.step();
      }
      this.position.y = ground;
      this.velocity.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    // Footsteps.
    if (this.onGround && hSpeed > 2) {
      this.stepTimer -= dt * hSpeed;
      if (this.stepTimer <= 0) {
        this.stepTimer = 3.4;
        this.audio.step();
      }
    }

    this.updateCamera(dt, hSpeed);
  }

  private updateCamera(dt: number, hSpeed = 0): void {
    // Recoil recovery and landing dip decay.
    this.recoilPitch = Math.max(0, this.recoilPitch - dt * 1.6);
    this.landImpulse = Math.max(0, this.landImpulse - dt * 0.8);

    let bobY = 0;
    let bobX = 0;
    if (this.onGround && hSpeed > 0.5) {
      this.bobPhase += dt * hSpeed * 1.35;
      bobY = Math.sin(this.bobPhase * 2) * 0.035;
      bobX = Math.cos(this.bobPhase) * 0.025;
    }

    this.camera.position.set(
      this.position.x + bobX * Math.cos(this.yaw),
      this.position.y + EYE_HEIGHT + bobY - this.landImpulse,
      this.position.z - bobX * Math.sin(this.yaw)
    );
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch + this.recoilPitch;
    this.camera.rotation.z = 0;
  }
}

const _wish = new THREE.Vector3();
const _eye = new THREE.Vector3();
