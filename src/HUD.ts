/** Thin DOM layer; values are only written when they change. */
export class HUD {
  private healthNum = document.getElementById("health-num")!;
  private healthBar = document.getElementById("health-bar")!;
  private ammoNum = document.getElementById("ammo-num")!;
  private weaponName = document.getElementById("weapon-name")!;
  private reloadHint = document.getElementById("reload-hint")!;
  private scoreNum = document.getElementById("score-num")!;
  private waveNum = document.getElementById("wave-num")!;
  private enemiesNum = document.getElementById("enemies-num")!;
  private fpsPanel = document.getElementById("fps-panel")!;
  private crosshair = document.getElementById("crosshair")!;
  private hitmarker = document.getElementById("hitmarker")!;
  private vignette = document.getElementById("damage-vignette")!;
  private announceEl = document.getElementById("announce")!;
  private announceMainEl = document.getElementById("announce-main")!;
  private announceSubEl = document.getElementById("announce-sub")!;
  private objectiveEl = document.getElementById("objective-text")!;
  private objectivePanel = document.getElementById("objective-panel")!;

  private lastObjective = "";
  private lastHealth = -1;
  private lastAmmo = -1;
  private lastScore = -1;
  private lastWave = -1;
  private lastEnemies = -1;
  private lastWeapon = "";
  private lastReloading = false;
  private vignetteTimer = 0;

  setHealth(health: number, max: number): void {
    const h = Math.ceil(health);
    if (h === this.lastHealth) return;
    if (h < this.lastHealth) {
      this.vignette.style.opacity = "1";
      this.vignetteTimer = 0.4;
    }
    this.lastHealth = h;
    this.healthNum.textContent = String(h);
    this.healthBar.style.width = `${(health / max) * 100}%`;
    this.healthBar.classList.toggle("low", health / max < 0.35);
  }

  setAmmo(ammo: number, weaponName: string, reloading: boolean): void {
    if (ammo !== this.lastAmmo) {
      this.lastAmmo = ammo;
      this.ammoNum.innerHTML = `${ammo} <small>/ &#8734;</small>`;
    }
    if (weaponName !== this.lastWeapon) {
      this.lastWeapon = weaponName;
      this.weaponName.textContent = weaponName;
    }
    if (reloading !== this.lastReloading) {
      this.lastReloading = reloading;
      this.reloadHint.textContent = reloading ? "RELOADING..." : "";
    }
  }

  setScore(score: number): void {
    if (score === this.lastScore) return;
    this.lastScore = score;
    this.scoreNum.textContent = String(score);
  }

  setWave(wave: number): void {
    if (wave === this.lastWave) return;
    this.lastWave = wave;
    this.waveNum.textContent = String(wave);
  }

  setEnemies(count: number): void {
    if (count === this.lastEnemies) return;
    this.lastEnemies = count;
    this.enemiesNum.textContent = String(count);
  }

  setFps(fps: number): void {
    this.fpsPanel.textContent = `${fps} FPS`;
  }

  hitmark(): void {
    this.crosshair.classList.add("hit");
    this.hitmarker.classList.remove("show");
    void this.hitmarker.offsetWidth; // restart CSS animation
    this.hitmarker.classList.add("show");
    setTimeout(() => this.crosshair.classList.remove("hit"), 100);
  }

  setObjective(text: string): void {
    if (text === this.lastObjective) return;
    this.lastObjective = text;
    this.objectiveEl.textContent = text;
    // Pulse the panel so new orders register at a glance.
    this.objectivePanel.classList.remove("flash");
    void this.objectivePanel.offsetWidth;
    this.objectivePanel.classList.add("flash");
  }

  announce(text: string, sub = ""): void {
    this.announceMainEl.textContent = text;
    this.announceSubEl.textContent = sub;
    this.announceEl.classList.remove("show");
    void this.announceEl.offsetWidth;
    this.announceEl.classList.add("show");
  }

  update(dt: number): void {
    if (this.vignetteTimer > 0) {
      this.vignetteTimer -= dt;
      if (this.vignetteTimer <= 0) this.vignette.style.opacity = "0";
    }
  }
}
