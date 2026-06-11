// Procedural sound effects via WebAudio. No assets to load, near-zero memory.
//
// Design notes: every sound is layered (sub-bass thump + mid body + noise
// transient) and routed through a master compressor, which is what keeps
// them sounding heavy instead of chiptune-y. World-positioned sounds go
// through an HRTF PannerNode against the listener pose, so you can hear
// left/right and (with headphones) front/back where a robot is. Distance
// gain stays hand-rolled per sound type to keep the mix balanced.

/** World position for a sound source; y defaults to chest height. */
interface SoundPos {
  x: number;
  z: number;
  y?: number;
}

interface ToneOpts {
  vol?: number; // spatial volume multiplier
  at?: SoundPos; // world position -> HRTF panning
  delay?: number; // seconds from now
  drive?: boolean; // run through the tanh waveshaper (growl/grit)
  lp?: number; // lowpass cutoff, tames sawtooth fizz
}

export type HumKind = "reactor" | "console";

interface NoiseOpts {
  vol?: number;
  at?: SoundPos;
  delay?: number;
  type?: BiquadFilterType; // default bandpass
  fEnd?: number; // sweep the filter to this frequency
}

const MASTER_GAIN = 0.5;

export class AudioFX {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;
  private distCurve!: Float32Array<ArrayBuffer>;

  // Listener position cache for distance culling (set once per frame).
  private lx = 0;
  private lz = 0;

  // Global throttles so a crowd of robots doesn't become white noise.
  private nextStepT = 0;
  private nextAlertT = 0;
  private nextGrowlT = 0;

  // Hum emitters registered before the context exists (init needs a
  // user gesture); created as real nodes once init runs.
  private pendingHums: Array<{ x: number; y: number; z: number; kind: HumKind }> = [];

  private muted = false;

  /** Mute everything via the master gain (works before/after init). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx) this.master.gain.value = muted ? 0 : MASTER_GAIN;
  }

  /** Must be called from a user gesture. */
  init(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext();

    // Compressor gives transients punch and stops layered shots clipping.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 12;
    comp.ratio.value = 5;
    comp.attack.value = 0.002;
    comp.release.value = 0.18;
    comp.connect(this.ctx.destination);

    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
    this.master.connect(comp);

    const len = this.ctx.sampleRate * 1.5;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Soft-clip curve shared by every "drive" sound.
    this.distCurve = new Float32Array(257);
    for (let i = 0; i <= 256; i++) {
      this.distCurve[i] = Math.tanh(3.5 * (i / 128 - 1));
    }

    for (const h of this.pendingHums) this.createHum(h.x, h.y, h.z, h.kind);
    this.pendingHums.length = 0;
  }

  resume(): void {
    this.ctx?.resume();
  }

  /** Update the listener pose; world-positioned sounds are mixed against it. */
  setListener(x: number, y: number, z: number, yaw: number): void {
    this.lx = x;
    this.lz = z;
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    if (l.positionX) {
      l.positionX.value = x;
      l.positionY.value = y;
      l.positionZ.value = z;
      l.forwardX.value = fx;
      l.forwardY.value = 0;
      l.forwardZ.value = fz;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      // Legacy WebAudio (older Safari).
      l.setPosition(x, y, z);
      l.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  /** Hand-rolled distance gain for a world position; null = inaudible. */
  private spatial(x: number, z: number, maxDist = 38): { vol: number } | null {
    const dx = x - this.lx;
    const dz = z - this.lz;
    const d = Math.hypot(dx, dz);
    if (d > maxDist) return null;
    const fall = 1 - d / maxDist;
    return { vol: fall * fall };
  }

  /**
   * Output tail into the master bus. Positioned sounds route through an
   * HRTF panner for true binaural placement; distance attenuation is
   * disabled there (rolloffFactor 0) because `spatial()` already applied
   * the per-sound-type falloff.
   */
  private out(vol: number, at?: SoundPos): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = vol;
    if (at) {
      const p = ctx.createPanner();
      p.panningModel = "HRTF";
      p.rolloffFactor = 0;
      const y = at.y ?? 1.2;
      if (p.positionX) {
        p.positionX.value = at.x;
        p.positionY.value = y;
        p.positionZ.value = at.z;
      } else {
        p.setPosition(at.x, y, at.z);
      }
      g.connect(p).connect(this.master);
    } else {
      g.connect(this.master);
    }
    return g;
  }

  private tone(
    type: OscillatorType,
    freqStart: number,
    freqEnd: number,
    duration: number,
    gain: number,
    o: ToneOpts = {}
  ): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + (o.delay ?? 0);
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + duration);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    let head: AudioNode = osc;
    if (o.drive) {
      const shaper = this.ctx.createWaveShaper();
      shaper.curve = this.distCurve;
      head.connect(shaper);
      head = shaper;
    }
    if (o.lp) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = o.lp;
      head.connect(lp);
      head = lp;
    }
    head.connect(env);
    env.connect(this.out(o.vol ?? 1, o.at));
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  private noise(
    duration: number,
    gain: number,
    filterFreq: number,
    filterQ = 1,
    o: NoiseOpts = {}
  ): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + (o.delay ?? 0);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = o.type ?? "bandpass";
    filter.frequency.setValueAtTime(filterFreq, t);
    if (o.fEnd) filter.frequency.exponentialRampToValueAtTime(o.fEnd, t + duration);
    filter.Q.value = filterQ;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(env);
    env.connect(this.out(o.vol ?? 1, o.at));
    src.start(t, Math.random() * 0.5, duration + 0.05);
  }

  /**
   * Register a fixed hum emitter (reactor core, powered console). Unlike
   * one-shot sounds these are persistent localized drones: the panner
   * does real distance rolloff, so the hum swells as you approach the
   * object and fades to nothing across the arena — no global room tone.
   */
  addHum(x: number, y: number, z: number, kind: HumKind): void {
    if (this.ctx) this.createHum(x, y, z, kind);
    else this.pendingHums.push({ x, y, z, kind });
  }

  private createHum(x: number, y: number, z: number, kind: HumKind): void {
    const ctx = this.ctx!;
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = kind === "reactor" ? 4 : 1.5;
    panner.rolloffFactor = kind === "reactor" ? 2 : 2.5;
    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = y;
      panner.positionZ.value = z;
    } else {
      panner.setPosition(x, y, z);
    }
    panner.connect(this.master);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    lp.connect(g).connect(panner);

    if (kind === "reactor") {
      // Deep detuned power-core throb with a slowly breathing filter.
      lp.frequency.value = 170;
      lp.Q.value = 1.6;
      g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 2);
      for (const [f, lvl] of [
        [44, 1],
        [44.35, 0.9],
        [88.7, 0.35],
      ]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = f;
        const og = ctx.createGain();
        og.gain.value = lvl;
        osc.connect(og).connect(lp);
        osc.start();
      }
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07;
      const lfoG = ctx.createGain();
      lfoG.gain.value = 50;
      lfo.connect(lfoG).connect(lp.frequency);
      lfo.start();
    } else {
      // Faint electronic whine; only audible right next to the console.
      lp.frequency.value = 1100;
      g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 1);
      for (const [f, lvl] of [
        [218, 1],
        [327, 0.4],
      ]) {
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = f;
        const og = ctx.createGain();
        og.gain.value = lvl;
        osc.connect(og).connect(lp);
        osc.start();
      }
      // Gentle flutter so it reads as electronics, not a test tone.
      const trem = ctx.createOscillator();
      trem.frequency.value = 5.3;
      const tremG = ctx.createGain();
      tremG.gain.value = 0.012;
      trem.connect(tremG).connect(g.gain);
      trem.start();
    }
  }

  // --- Player weapons --------------------------------------------------

  shoot(kind: "rifle" | "shotgun" | "smg"): void {
    if (kind === "rifle") {
      this.tone("sine", 150, 45, 0.12, 0.5); // sub thump
      this.tone("sawtooth", 700, 90, 0.09, 0.3, { drive: true, lp: 2200 });
      this.noise(0.12, 0.4, 3200, 0.7, { type: "lowpass" });
    } else if (kind === "shotgun") {
      this.tone("sine", 120, 32, 0.32, 0.7);
      this.tone("sawtooth", 240, 40, 0.26, 0.45, { drive: true, lp: 1400 });
      this.noise(0.35, 0.7, 1300, 0.5, { type: "lowpass", fEnd: 300 });
    } else {
      this.tone("sine", 180, 60, 0.07, 0.35);
      this.tone("sawtooth", 900, 140, 0.05, 0.18, { drive: true, lp: 2600 });
      this.noise(0.06, 0.3, 2800, 0.8, { type: "lowpass" });
    }
  }

  reload(): void {
    // Mag out (metal click), mag in (heavier clack), bolt slam.
    this.noise(0.04, 0.25, 1600, 4);
    this.noise(0.05, 0.3, 900, 3, { delay: 0.4 });
    this.tone("square", 160, 90, 0.05, 0.12, { delay: 0.4, lp: 900 });
    this.noise(0.06, 0.35, 1200, 2.5, { delay: 0.85 });
    this.tone("sine", 110, 60, 0.08, 0.2, { delay: 0.85 });
  }

  empty(): void {
    this.noise(0.03, 0.2, 2200, 5);
    this.tone("square", 180, 140, 0.03, 0.08, { lp: 1200 });
  }

  hit(): void {
    // Dull metallic contact, not a slot-machine ding.
    this.tone("square", 700, 380, 0.045, 0.16, { lp: 1800 });
    this.noise(0.04, 0.18, 2400, 2);
  }

  // --- Robots ----------------------------------------------------------

  /** Servo footfall; `heavy` scales with the robot (brutes thud). */
  servoStep(x: number, z: number, heavy: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now < this.nextStepT) return; // crowd throttle
    const s = this.spatial(x, z, 30);
    if (!s) return;
    this.nextStepT = now + 0.07;
    const h = Math.min(1.6, heavy);
    const at = { x, z, y: 0.2 };
    this.noise(0.05, 0.1 * h, 1700 / h, 2.2, { vol: s.vol, at });
    this.tone("sine", 95 / h, 50 / h, 0.07, 0.14 * h, { vol: s.vol, at });
  }

  /** Detection stinger: a rising distorted growl + lock-on tick. */
  alert(x: number, z: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now < this.nextAlertT) return;
    const s = this.spatial(x, z, 42);
    if (!s) return;
    this.nextAlertT = now + 0.3;
    const at = { x, z, y: 1.6 };
    this.tone("sawtooth", 105, 175, 0.5, 0.28, { vol: s.vol, at, drive: true, lp: 650 });
    this.tone("sawtooth", 108, 181, 0.5, 0.22, { vol: s.vol, at, drive: true, lp: 650 });
    this.tone("square", 1400, 1400, 0.04, 0.07, { vol: s.vol, at, delay: 0.32 });
  }

  /** Low intermittent hunting growl — robots sound angry while stalking. */
  growl(x: number, z: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now < this.nextGrowlT) return;
    const s = this.spatial(x, z, 26);
    if (!s) return;
    this.nextGrowlT = now + 0.2;
    this.tone("sawtooth", 72, 54, 0.35, 0.16, { vol: s.vol, at: { x, z }, drive: true, lp: 380 });
  }

  /** Melee swing whoosh; bigger robots displace more air. */
  swing(x: number, z: number, big: boolean): void {
    const s = this.spatial(x, z, 24);
    if (!s) return;
    const at = { x, z };
    this.noise(big ? 0.3 : 0.22, big ? 0.4 : 0.28, 320, 1.2, {
      vol: s.vol,
      at,
      fEnd: big ? 750 : 1000,
    });
    this.tone("sawtooth", 90, 45, 0.25, 0.18, { vol: s.vol, at, drive: true, lp: 420 });
  }

  enemyShoot(x: number, z: number): void {
    const s = this.spatial(x, z, 40) ?? { vol: 0.3 };
    const at = { x, z, y: 1.4 };
    this.tone("sawtooth", 460, 80, 0.18, 0.22, { vol: s.vol, at, drive: true, lp: 1600 });
    this.tone("sine", 130, 50, 0.12, 0.25, { vol: s.vol, at });
    this.noise(0.1, 0.2, 1900, 1.2, { vol: s.vol, at, type: "lowpass" });
  }

  /** Wreck slamming into the floor. */
  slam(x: number, z: number, size: number): void {
    const s = this.spatial(x, z, 34);
    if (!s) return;
    const h = Math.min(1.5, size);
    const at = { x, z, y: 0.3 };
    this.tone("sine", 70 * h, 30, 0.25, 0.4 * h, { vol: s.vol, at });
    this.noise(0.2, 0.35 * h, 500, 0.8, { vol: s.vol, at, type: "lowpass", fEnd: 150 });
    this.noise(0.06, 0.2, 1400, 2, { vol: s.vol, at }); // metal clatter
  }

  kill(): void {
    // Small explosion: sub drop + torn metal + smoke.
    this.tone("sine", 95, 28, 0.45, 0.5);
    this.tone("sawtooth", 150, 35, 0.35, 0.3, { drive: true, lp: 900 });
    this.noise(0.5, 0.5, 900, 0.6, { type: "lowpass", fEnd: 200 });
    this.noise(0.08, 0.3, 2100, 1.5);
  }

  // --- Doors -----------------------------------------------------------

  /** Pneumatic door hiss with a mechanical thunk when the panels seat. */
  doorMove(x: number, z: number, opening: boolean): void {
    const s = this.spatial(x, z, 32);
    if (!s) return;
    const at = { x, z, y: 1.8 };
    if (opening) {
      this.noise(0.4, 0.3, 500, 1.4, { vol: s.vol, at, fEnd: 2200 });
      this.tone("sine", 65, 95, 0.35, 0.18, { vol: s.vol, at });
      this.noise(0.07, 0.25, 1100, 2, { vol: s.vol, at, delay: 0.38 }); // seat clunk
      this.tone("sine", 90, 50, 0.09, 0.2, { vol: s.vol, at, delay: 0.38 });
    } else {
      this.noise(0.55, 0.26, 1800, 1.4, { vol: s.vol, at, fEnd: 380 });
      this.noise(0.08, 0.3, 800, 2, { vol: s.vol, at, delay: 0.58 });
      this.tone("sine", 75, 38, 0.14, 0.28, { vol: s.vol, at, delay: 0.58 });
    }
  }

  /** Lock release: solenoid clack + confirmation chirp at the door. */
  unlock(x: number, z: number): void {
    const s = this.spatial(x, z, 36);
    if (!s) return;
    const at = { x, z, y: 2 };
    this.noise(0.05, 0.35, 1500, 2.5, { vol: s.vol, at });
    this.tone("sine", 120, 60, 0.12, 0.3, { vol: s.vol, at });
    this.tone("square", 880, 880, 0.07, 0.08, { vol: s.vol, at, delay: 0.14, lp: 2400 });
    this.tone("square", 1318, 1318, 0.1, 0.08, { vol: s.vol, at, delay: 0.24, lp: 2600 });
  }

  /** Facility alarm: three falling distorted wails. */
  alarm(): void {
    for (let i = 0; i < 3; i++) {
      this.tone("sawtooth", 740, 320, 0.55, 0.22, { delay: i * 0.7, drive: true, lp: 1500 });
      this.tone("sawtooth", 372, 162, 0.55, 0.16, { delay: i * 0.7, lp: 900 });
    }
  }

  // --- Player / game state ----------------------------------------------

  hurt(): void {
    this.tone("sine", 90, 45, 0.2, 0.4);
    this.tone("sawtooth", 170, 65, 0.22, 0.3, { drive: true, lp: 600 });
    this.noise(0.15, 0.3, 600, 1, { type: "lowpass" });
  }

  jump(): void {
    this.noise(0.1, 0.08, 500, 1, { type: "lowpass" });
  }

  step(): void {
    this.noise(0.06, 0.09, 420, 1.2, { type: "lowpass" });
    this.tone("sine", 80, 55, 0.05, 0.07);
  }

  wave(): void {
    // War-factory klaxon: two low minor blasts instead of a happy chime.
    this.tone("sawtooth", 98, 96, 0.55, 0.3, { drive: true, lp: 700 });
    this.tone("sawtooth", 49, 49, 0.55, 0.25, { lp: 400 });
    this.tone("sawtooth", 92.5, 90, 0.7, 0.3, { delay: 0.65, drive: true, lp: 700 });
    this.tone("sawtooth", 46.25, 46, 0.7, 0.25, { delay: 0.65, lp: 400 });
  }

  pickup(): void {
    this.tone("sine", 700, 1400, 0.15, 0.2);
  }

  death(): void {
    this.tone("sawtooth", 200, 24, 1.4, 0.4, { drive: true, lp: 800 });
    this.tone("sine", 55, 18, 1.5, 0.5);
    this.noise(1.2, 0.5, 350, 0.6, { type: "lowpass", fEnd: 80 });
  }
}
