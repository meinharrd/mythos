import type { Player } from "./Player";
import type { WeaponSystem } from "./Weapons";

/** Coarse pointer = phone/tablet. ?touch forces it for desktop testing. */
export const IS_TOUCH =
  window.matchMedia("(pointer: coarse)").matches ||
  new URLSearchParams(location.search).has("touch");

/** Joystick deflection (px) that maps to full speed. */
const JOY_RADIUS = 52;
const SPRINT_DEFLECTION = 0.94;

/**
 * Mobile input layer. The left part of the screen spawns a floating
 * joystick (move); dragging anywhere else aims. Fire/jump/reload/weapon
 * are dedicated buttons. Game shows/hides the whole layer via setActive.
 */
export class TouchControls {
  /** Analog move input, both in [-1, 1]; y is forward. */
  moveX = 0;
  moveY = 0;
  sprint = false;

  private jumpQueued = false;
  private lookDX = 0;
  private lookDY = 0;
  private moveId: number | null = null;
  private lookId: number | null = null;
  private lookLastX = 0;
  private lookLastY = 0;
  private joyX = 0;
  private joyY = 0;

  private root = document.getElementById("touch-ui")!;
  private joyBase = document.getElementById("joy-base") as HTMLElement;
  private joyNub = document.getElementById("joy-nub") as HTMLElement;
  private weapons: WeaponSystem;

  constructor(player: Player, weapons: WeaponSystem, onPause: () => void) {
    this.weapons = weapons;
    player.touch = this;

    const btn = (id: string, down: () => void, up?: () => void): void => {
      const el = document.getElementById(id)!;
      el.addEventListener(
        "touchstart",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          el.classList.add("pressed");
          down();
        },
        { passive: false }
      );
      const end = (e: TouchEvent): void => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove("pressed");
        up?.();
      };
      el.addEventListener("touchend", end, { passive: false });
      el.addEventListener("touchcancel", end, { passive: false });
    };
    btn("fire-btn", () => weapons.setTrigger(true), () => weapons.setTrigger(false));
    btn("jump-btn", () => {
      this.jumpQueued = true;
    });
    btn("reload-btn", () => weapons.startReload());
    btn("weapon-btn", () => weapons.cycleWeapon());
    btn("pause-btn", onPause);

    this.root.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        for (const t of Array.from(e.changedTouches)) {
          if (t.clientX < window.innerWidth * 0.45 && this.moveId === null) {
            this.moveId = t.identifier;
            this.joyX = t.clientX;
            this.joyY = t.clientY;
            this.joyBase.style.left = `${t.clientX}px`;
            this.joyBase.style.top = `${t.clientY}px`;
            this.joyBase.style.display = "block";
            this.setNub(0, 0);
          } else if (this.lookId === null) {
            this.lookId = t.identifier;
            this.lookLastX = t.clientX;
            this.lookLastY = t.clientY;
          }
        }
      },
      { passive: false }
    );

    this.root.addEventListener(
      "touchmove",
      (e) => {
        e.preventDefault();
        for (const t of Array.from(e.changedTouches)) {
          if (t.identifier === this.moveId) {
            let dx = t.clientX - this.joyX;
            let dy = t.clientY - this.joyY;
            const len = Math.hypot(dx, dy);
            if (len > JOY_RADIUS) {
              dx *= JOY_RADIUS / len;
              dy *= JOY_RADIUS / len;
            }
            this.setNub(dx, dy);
            this.moveX = dx / JOY_RADIUS;
            this.moveY = -dy / JOY_RADIUS; // screen-up = forward
            this.sprint = Math.hypot(this.moveX, this.moveY) > SPRINT_DEFLECTION;
          } else if (t.identifier === this.lookId) {
            this.lookDX += t.clientX - this.lookLastX;
            this.lookDY += t.clientY - this.lookLastY;
            this.lookLastX = t.clientX;
            this.lookLastY = t.clientY;
          }
        }
      },
      { passive: false }
    );

    const release = (e: TouchEvent): void => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.moveId) this.releaseMove();
        else if (t.identifier === this.lookId) this.lookId = null;
      }
    };
    this.root.addEventListener("touchend", release);
    this.root.addEventListener("touchcancel", release);
  }

  private setNub(dx: number, dy: number): void {
    this.joyNub.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  private releaseMove(): void {
    this.moveId = null;
    this.moveX = 0;
    this.moveY = 0;
    this.sprint = false;
    this.joyBase.style.display = "none";
  }

  /** Accumulated look delta (px) since the last call. */
  consumeLook(): { dx: number; dy: number } {
    const r = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = 0;
    this.lookDY = 0;
    return r;
  }

  /** One queued jump press; stays queued while airborne. */
  consumeJump(): boolean {
    const j = this.jumpQueued;
    this.jumpQueued = false;
    return j;
  }

  /** Shown while playing, hidden behind menus and end screens. */
  setActive(on: boolean): void {
    this.root.classList.toggle("active", on);
    if (!on) {
      this.releaseMove();
      this.lookId = null;
      this.jumpQueued = false;
      this.weapons.setTrigger(false);
    }
  }
}
