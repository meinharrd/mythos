import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { World } from "./World";
import { Player } from "./Player";
import { WeaponSystem } from "./Weapons";
import { EnemyManager, EnemyKind } from "./Enemies";
import { Effects } from "./Effects";
import { AudioFX } from "./AudioFX";
import { HUD } from "./HUD";
import { Multiplayer } from "./Multiplayer";
import { TouchControls, IS_TOUCH } from "./Touch";

const MAX_DT = 1 / 30; // clamp delta so tab-switches don't explode physics

const PARAMS = new URLSearchParams(location.search);
// Debug aid: ?nolock runs the simulation without pointer lock (useful in
// embedded browsers that refuse lock requests).
const NO_LOCK = PARAMS.has("nolock");
/** The one shared arena everybody plays in (for now). */
const ARENA_CHANNEL = "arena";
const RESPAWN_DELAY = 3.5;

function randomName(): string {
  return `Pilot-${Math.floor(Math.random() * 900 + 100)}`;
}

type GameState = "menu" | "playing" | "dead" | "won";

/** Plot beats: find the keycard, pull the core, run for the gate. */
const OBJECTIVES = [
  "Find the keycard in the supply depot [NE]",
  "Extract the core cell from the reactor room [SW]",
  "ALARM! Reach the extraction gate in the garden [S]",
];

export class Game {
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private vmScene: THREE.Scene;
  private vmCamera: THREE.PerspectiveCamera;
  private envMap: THREE.Texture;
  private audio: AudioFX;
  private hud: HUD;

  // World and everything in it are built on the menu's single/multi
  // choice (the arena and the campaign are different maps).
  private ready = false;
  private world!: World;
  private player!: Player;
  private weapons!: WeaponSystem;
  private enemies!: EnemyManager;
  private effects!: Effects;

  private mp: Multiplayer | null = null;
  private touch: TouchControls | null = null;
  private respawnTimer = 0;
  private boardTimer = 0;

  private state: GameState = "menu";
  private score = 0;
  private kills = 0;
  private wave = 0;
  private waveCooldown = 0;
  /** Current plot stage (index into OBJECTIVES; done when past the end). */
  private stage = 0;
  private lockedMsgCooldown = 0;
  private lastTime = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fpsTimer = 0;

  private menuEl = document.getElementById("menu")!;
  private gameoverEl = document.getElementById("gameover")!;
  private deathStatsEl = document.getElementById("death-stats")!;
  private startBtnEl = document.getElementById("start-btn")!;
  private mpBtnEl = document.getElementById("mp-btn")!;
  private menuRestartEl = document.getElementById("menu-restart-btn")!;
  private leaveBtnEl = document.getElementById("leave-btn")!;
  private nameInputEl = document.getElementById("mp-name") as HTMLInputElement;
  private nameRowEl = document.getElementById("mp-setup")!;
  private victoryEl = document.getElementById("victory")!;
  private victoryStatsEl = document.getElementById("victory-stats")!;

  constructor(container: HTMLElement) {
    // Touch trim: virtual controls, no keyboard hints, no pointer lock.
    document.body.classList.toggle("touch", IS_TOUCH);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Static scene: render the shadow map once, then freeze it.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      300
    );

    // The gun viewmodel lives in its own scene, rendered in a second
    // pass with the depth buffer cleared, so it can never poke into
    // walls or pillars. Its camera sits at the origin: the viewmodel's
    // offsets are camera-local anyway.
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.05,
      10
    );
    this.renderer.autoClear = false; // we clear manually per pass

    // One-time PMREM environment for the robots' chrome reflections.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment()).texture;
    pmrem.dispose();
    this.vmScene.environment = this.envMap; // IBL so the gun isn't pitch black

    this.audio = new AudioFX();
    this.hud = new HUD();

    // Pilot name: assigned randomly, editable in the menu at any time.
    if (!localStorage.getItem("mythos-name")) {
      localStorage.setItem("mythos-name", randomName());
    }
    this.nameInputEl.value = localStorage.getItem("mythos-name")!;
    this.nameInputEl.addEventListener("change", () => this.applyName());

    // Sound toggle, persisted across sessions.
    const soundBtn = document.getElementById("sound-btn")!;
    const setSound = (on: boolean): void => {
      this.audio.setMuted(!on);
      localStorage.setItem("mythos-sound", on ? "on" : "off");
      soundBtn.textContent = on ? "Sound: On" : "Sound: Off";
      soundBtn.classList.toggle("off", !on);
    };
    setSound(localStorage.getItem("mythos-sound") !== "off");
    soundBtn.addEventListener("click", () => {
      setSound(localStorage.getItem("mythos-sound") === "off");
    });

    // Debug handle for the ?nolock harness.
    if (NO_LOCK) (window as unknown as { __game: Game }).__game = this;

    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.vmCamera.aspect = this.camera.aspect;
      this.vmCamera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // Esc pauses (drops pointer lock) — the primary button then resumes
    // the run; only the explicit restart buttons reset it.
    this.startBtnEl.addEventListener("click", () => {
      if (this.state === "playing") return this.resumeGame();
      if (!this.ready) this.initWorld(false);
      this.startGame();
    });
    this.mpBtnEl.addEventListener("click", () => {
      this.initWorld(true);
      this.startGame();
    });
    this.leaveBtnEl.addEventListener("click", () => {
      this.mp?.leave();
      location.reload();
    });
    this.menuRestartEl.addEventListener("click", () => this.startGame());
    document.getElementById("restart-btn")!.addEventListener("click", () => this.startGame());
    document.getElementById("victory-btn")!.addEventListener("click", () => this.startGame());
    for (const id of ["gameover-menu-btn", "victory-menu-btn"]) {
      document.getElementById(id)!.addEventListener("click", () => location.reload());
    }

    // Show the pause menu when pointer lock drops mid-game.
    document.addEventListener("pointerlockchange", () => {
      if (NO_LOCK) return;
      if (document.pointerLockElement === null && this.state === "playing") {
        this.showMenu(true);
      } else if (document.pointerLockElement !== null && this.state === "playing") {
        this.menuEl.classList.add("hidden");
        this.audio.resume();
      }
    });

    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(() => this.tick());

    // Expose internals for debugging when running without pointer lock.
    if (NO_LOCK) (window as unknown as { __game: Game }).__game = this;
  }

  /**
   * Builds the world and everything living in it. Called exactly once,
   * when the player picks single or multi player in the menu.
   */
  private initWorld(mp: boolean): void {
    this.world = new World(mp);
    this.world.audio = this.audio; // doors hiss when they move
    // Localized ambience: the reactor core throbs, consoles whine.
    for (const h of this.world.humSpots) this.audio.addHum(h.x, h.y, h.z, h.kind);
    this.world.scene.add(this.camera); // camera must be in scene for viewmodel
    this.effects = new Effects(this.world.scene);
    this.player = new Player(this.camera, this.world, this.audio);
    this.enemies = new EnemyManager(
      this.world.scene,
      this.world,
      this.effects,
      this.audio,
      this.envMap
    );
    this.weapons = new WeaponSystem(
      this.camera,
      this.vmScene,
      this.world,
      this.enemies,
      this.player,
      this.effects,
      this.audio
    );

    this.enemies.onKill = (_kind, score) => {
      this.kills++;
      this.score += score + this.wave * 10;
    };
    this.weapons.onHit = () => this.hud.hitmark();

    if (IS_TOUCH) {
      this.touch = new TouchControls(this.player, this.weapons, () => {
        if (this.state === "playing") this.showMenu(true);
      });
    }

    if (mp) {
      this.setupMultiplayer();
    } else {
      document.querySelector("#menu .tagline")!.textContent =
        "Facility Raid // Find the keycard, steal the core, get out";
    }

    // The mode is locked in for this session.
    this.mpBtnEl.classList.add("hidden");
    this.nameRowEl.classList.toggle("hidden", !mp);
    this.ready = true;
  }

  /** Menu in "fresh start" or "paused run" trim. */
  private showMenu(paused: boolean): void {
    this.startBtnEl.textContent = paused ? "Resume" : this.mp ? "Deploy" : "Single Player";
    this.menuRestartEl.classList.toggle("hidden", !paused || this.mp !== null);
    // Way back to the single/multi choice (a clean reload).
    this.leaveBtnEl.textContent = this.mp ? "Leave Arena" : "Main Menu";
    this.leaveBtnEl.classList.toggle("hidden", !this.ready || !paused);
    this.menuEl.classList.remove("hidden");
    this.touch?.setActive(false);
  }

  /** Persist the edited pilot name and push it to the live session. */
  private applyName(): void {
    const name = this.nameInputEl.value.trim().slice(0, 14) || randomName();
    this.nameInputEl.value = name;
    localStorage.setItem("mythos-name", name);
    if (this.mp) this.mp.playerName = name;
  }

  // ------------------------------------------------------------ multiplayer

  private setupMultiplayer(): void {
    const name = this.nameInputEl.value.trim() || randomName();
    this.mp = new Multiplayer(
      ARENA_CHANNEL,
      name,
      this.player,
      this.world,
      this.effects,
      this.audio,
      this.envMap
    );
    this.weapons.mp = this.mp;

    const feed = document.getElementById("killfeed")!;
    this.mp.onKillFeed = (attacker, victim, attackerIsMe) => {
      const row = document.createElement("div");
      row.className = "feed-row";
      row.innerHTML = `<b>${esc(attacker)}</b> &#9658; <span class="victim">${esc(victim)}</span>`;
      feed.prepend(row);
      while (feed.children.length > 5) feed.lastChild!.remove();
      setTimeout(() => row.remove(), 6100);
      if (attackerIsMe) {
        this.score += 100;
        this.hud.announce(`ELIMINATED ${victim.toUpperCase()}`);
        this.audio.kill();
      }
    };

    this.mp.onLocalDeath = (killerName) => {
      this.respawnTimer = RESPAWN_DELAY;
      this.audio.death();
      document.getElementById("respawn-text")!.textContent =
        `Taken down by ${killerName} // redeploying...`;
      document.getElementById("respawn-overlay")!.classList.remove("hidden");
    };

    // Arena trim for the menu and HUD.
    document.querySelector("#menu .tagline")!.textContent =
      "Arena Deathmatch // Eliminate all rival pilots";
    document.getElementById("score-panel")!.classList.add("hidden");
    document.getElementById("mp-board")!.classList.remove("hidden");
  }

  /** Multiplayer respawn: pick a spawn away from opponents and reset. */
  private respawn(): void {
    const [x, z, yaw] = this.mp!.pickSpawn();
    this.player.reset(x, z, yaw);
    this.weapons.reset();
    document.getElementById("respawn-overlay")!.classList.add("hidden");
  }

  private updateScoreboard(): void {
    const rows = this.mp!.scoreboard();
    const html = rows
      .map(
        (r) =>
          `<tr class="${r.id === this.mp!.net.id ? "me" : ""}${r.alive ? "" : " dead"}">` +
          `<td>${esc(r.name || "...")}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`
      )
      .join("");
    document.getElementById("mp-board-rows")!.innerHTML = html;
  }

  private startGame(): void {
    this.audio.init();
    this.audio.resume();
    this.state = "playing";
    this.score = 0;
    this.kills = 0;

    if (this.mp) {
      const [x, z, yaw] = this.mp.pickSpawn();
      this.player.reset(x, z, yaw);
      this.weapons.reset();
      this.hud.setObjective("Eliminate all rival pilots");
    } else {
      this.wave = 0;
      this.waveCooldown = 1.5;
      this.stage = 0;
      this.world.resetPlot();
      document.getElementById("alarm-vignette")!.classList.remove("on");
      this.hud.setObjective(OBJECTIVES[0]);
      this.player.reset();
      this.weapons.reset();
      this.enemies.reset();
    }

    this.menuEl.classList.add("hidden");
    this.gameoverEl.classList.add("hidden");
    this.victoryEl.classList.add("hidden");
    this.touch?.setActive(true);
    this.lockPointer();
  }

  /** Continue a paused run without touching any game state. */
  private resumeGame(): void {
    this.audio.resume();
    this.menuEl.classList.add("hidden");
    this.touch?.setActive(true);
    this.lockPointer();
  }

  private lockPointer(): void {
    if (IS_TOUCH) {
      // Best effort: fullscreen + landscape make for a far better fit.
      // Both calls are allowed to fail (iOS Safari has neither).
      const el = document.documentElement;
      el.requestFullscreen?.().catch(() => {});
      const orientation = screen.orientation as unknown as {
        lock?: (o: string) => Promise<void>;
      };
      orientation.lock?.("landscape").catch(() => {});
      return;
    }
    if (NO_LOCK) return;
    const lock = this.renderer.domElement.requestPointerLock() as unknown;
    // Re-show the menu if the browser refuses the lock, instead of
    // leaving the game silently paused behind a hidden menu. A run is
    // in progress at this point, so show the paused trim.
    if (lock instanceof Promise) {
      lock.catch(() => this.showMenu(true));
    }
  }

  private startNextWave(): void {
    this.wave++;
    this.hud.announce(`WAVE ${this.wave}`);
    this.audio.wave();

    const kinds: EnemyKind[] = [];
    const stalkers = 3 + this.wave * 2;
    const sentinels = Math.floor(this.wave / 2) + (this.wave > 1 ? 1 : 0);
    const brutes = this.wave >= 4 ? Math.floor((this.wave - 2) / 2) : 0;
    for (let i = 0; i < stalkers; i++) kinds.push("stalker");
    for (let i = 0; i < sentinels; i++) kinds.push("sentinel");
    for (let i = 0; i < brutes; i++) kinds.push("brute");
    this.enemies.spawnWave(kinds, this.player);
  }

  private die(): void {
    this.state = "dead";
    if (!NO_LOCK && !IS_TOUCH) document.exitPointerLock();
    this.touch?.setActive(false);
    this.audio.death();
    this.deathStatsEl.innerHTML = `Survived to wave <b>${this.wave}</b><br>Hostiles destroyed: <b>${this.kills}</b><br>Final score: <b>${this.score}</b>`;
    this.gameoverEl.classList.remove("hidden");
  }

  private win(): void {
    this.state = "won";
    if (!NO_LOCK && !IS_TOUCH) document.exitPointerLock();
    this.touch?.setActive(false);
    this.audio.wave();
    this.score += 2500;
    this.victoryStatsEl.innerHTML = `Core recovered on wave <b>${this.wave}</b><br>Hostiles destroyed: <b>${this.kills}</b><br>Final score: <b>${this.score}</b>`;
    this.victoryEl.classList.remove("hidden");
  }

  /** Advance the keycard → core → extraction chain. */
  private updatePlot(dt: number): void {
    this.lockedMsgCooldown -= dt;
    const p = this.player.position;

    // Walking up to any locked door says so (with a hint when we know
    // what opens it).
    const lockedTag = this.world.lockedDoorNear(p, 5);
    if (lockedTag !== null && this.lockedMsgCooldown <= 0) {
      this.lockedMsgCooldown = 5;
      this.hud.announce(
        "DOOR LOCKED",
        lockedTag === "reactor" ? "Keycard required" : "Opens when the core is extracted"
      );
    }

    if (this.stage === 0) {
      const card = this.world.pickups[0];
      if (!card.taken && Math.hypot(card.x - p.x, card.z - p.z) < 1.7) {
        this.world.takePickup(card);
        this.audio.pickup();
        this.world.unlockTag("reactor");
        this.score += 500;
        this.stage = 1;
        this.hud.setObjective(OBJECTIVES[1]);
        this.hud.announce("KEYCARD ACQUIRED", `New objective: ${OBJECTIVES[1]}`);
      }
    } else if (this.stage === 1) {
      const core = this.world.pickups[1];
      if (!core.taken && Math.hypot(core.x - p.x, core.z - p.z) < 1.7) {
        this.world.takePickup(core);
        this.audio.pickup();
        this.audio.alarm();
        this.world.setAlarm(true);
        document.getElementById("alarm-vignette")!.classList.add("on");
        this.world.unlockTag("gate");
        this.enemies.alertAll(this.player.position);
        this.score += 1000;
        this.stage = 2;
        this.hud.setObjective(OBJECTIVES[2]);
        this.hud.announce("CORE EXTRACTED", `New objective: ${OBJECTIVES[2]}`);
      }
    } else if (this.stage === 2) {
      const g = this.world.gatePos;
      if (Math.hypot(g.x - p.x, g.z - p.z) < 3.2) this.win();
    }
  }

  /** Doors open for the player and for enemies. */
  private agentNear = (x: number, z: number, radius: number): boolean => {
    const p = this.player.position;
    const dx = p.x - x;
    const dz = p.z - z;
    if (dx * dx + dz * dz < radius * radius) return true;
    return this.enemies.anyActiveNear(x, z, radius);
  };

  private tick(): void {
    const now = performance.now();
    const dt = Math.min(MAX_DT, (now - this.lastTime) / 1000);
    this.lastTime = now;

    // Nothing exists until the player picks a mode in the menu.
    if (!this.ready) return;

    // FPS counter (updated twice a second to avoid DOM churn).
    this.fpsAccum += dt;
    this.fpsFrames++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 0.5) {
      this.hud.setFps(Math.round(this.fpsFrames / this.fpsAccum));
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      this.fpsTimer = 0;
    }

    if (this.state === "playing") {
      // Desktop pauses when pointer lock drops; touch pauses while the
      // menu is up; the ?nolock harness never pauses.
      const paused = NO_LOCK
        ? false
        : IS_TOUCH
          ? !this.menuEl.classList.contains("hidden")
          : document.pointerLockElement === null;

      // The arena keeps networking alive even while the menu is up, so
      // the local avatar doesn't freeze or time out for other players.
      if (this.mp) {
        this.mp.update(dt, this.weapons.current);
        this.boardTimer -= dt;
        if (this.boardTimer <= 0) {
          this.boardTimer = 0.5;
          this.updateScoreboard();
        }
      }

      if (!paused) {
        const eye = this.player.eyePosition;
        this.audio.setListener(eye.x, eye.y, eye.z, this.player.yaw);
        this.player.update(dt);
        this.weapons.update(dt);
        this.world.update(dt, this.agentNear);

        // Passive regen out of combat pressure.
        if (this.player.alive && this.player.health < this.player.maxHealth) {
          this.player.heal(dt * 2);
        }

        if (this.mp) {
          if (!this.player.alive) {
            this.respawnTimer -= dt;
            if (this.respawnTimer <= 0) this.respawn();
          }
        } else {
          this.enemies.update(dt, this.player);
          this.updatePlot(dt);

          if (this.enemies.aliveCount === 0) {
            this.waveCooldown -= dt;
            if (this.waveCooldown <= 0) {
              this.startNextWave();
              this.waveCooldown = 3;
            }
          }

          if (!this.player.alive) this.die();
        }
      }
    }

    this.effects.update(dt);
    this.hud.update(dt);
    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.setAmmo(
      this.weapons.ammo[this.weapons.current],
      this.weapons.def.name,
      this.weapons.reloading
    );
    this.hud.setScore(this.score);
    this.hud.setWave(Math.max(1, this.wave));
    this.hud.setEnemies(this.enemies.aliveCount);

    // World pass, then the viewmodel on a cleared depth buffer so the
    // gun never clips into nearby geometry.
    this.renderer.clear();
    this.renderer.render(this.world.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.vmScene, this.vmCamera);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
