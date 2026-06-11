import * as THREE from "three";

/**
 * Procedural canvas textures, generated once at startup. Keeps the game
 * asset-free: nothing to download or decode, and every surface still
 * gets per-pixel detail.
 */

function makeCanvas(size: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return c.getContext("2d")!;
}

function makeCanvasWH(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c.getContext("2d")!;
}

function toTexture(ctx: CanvasRenderingContext2D, repeatX = 1, repeatY = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(ctx.canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function rgb(r: number, g: number, b: number, mul = 1): string {
  return `rgb(${Math.min(255, (r * mul) | 0)},${Math.min(255, (g * mul) | 0)},${Math.min(255, (b * mul) | 0)})`;
}

/** Random scratches/scuffs overlay. */
function scuffs(ctx: CanvasRenderingContext2D, size: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 4 + Math.random() * 30;
    const a = Math.random() * Math.PI;
    const light = Math.random() < 0.5;
    ctx.strokeStyle = light ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.12)";
    ctx.lineWidth = 1 + Math.random();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
}

function rivet(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, Math.PI * 2);
  ctx.fill();
}

export function floorTexture(repeat: number): THREE.CanvasTexture {
  const S = 512;
  const ctx = makeCanvas(S);
  const P = S / 4;

  ctx.fillStyle = rgb(35, 47, 71);
  ctx.fillRect(0, 0, S, S);

  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 4; px++) {
      const x = px * P;
      const y = py * P;
      const mul = 0.88 + Math.random() * 0.24;
      ctx.fillStyle = rgb(35, 47, 71, mul);
      ctx.fillRect(x + 2, y + 2, P - 4, P - 4);

      // Bevel: light top/left, dark bottom/right.
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 3, y + P - 3);
      ctx.lineTo(x + 3, y + 3);
      ctx.lineTo(x + P - 3, y + 3);
      ctx.stroke();
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.moveTo(x + P - 3, y + 3);
      ctx.lineTo(x + P - 3, y + P - 3);
      ctx.lineTo(x + 3, y + P - 3);
      ctx.stroke();

      rivet(ctx, x + 10, y + 10, 3);
      rivet(ctx, x + P - 10, y + 10, 3);
      rivet(ctx, x + 10, y + P - 10, 3);
      rivet(ctx, x + P - 10, y + P - 10, 3);

      // Occasional tech marking.
      if (Math.random() < 0.3) {
        ctx.strokeStyle = "rgba(79,217,255,0.18)";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 30 + Math.random() * 30, y + 30 + Math.random() * 30, 24, 10);
      }
    }
  }

  scuffs(ctx, S, 70);
  return toTexture(ctx, repeat, repeat);
}

export function wallTexture(repeatX: number, repeatY: number): THREE.CanvasTexture {
  const S = 512;
  const ctx = makeCanvas(S);
  const ROW = S / 4;

  ctx.fillStyle = rgb(36, 52, 80);
  ctx.fillRect(0, 0, S, S);

  for (let row = 0; row < 4; row++) {
    const y = row * ROW;
    const offset = (row % 2) * (ROW / 2);
    for (let col = -1; col < 4; col++) {
      const x = col * ROW + offset;
      const mul = 0.9 + Math.random() * 0.2;
      ctx.fillStyle = rgb(36, 52, 80, mul);
      ctx.fillRect(x + 2, y + 2, ROW - 4, ROW - 4);
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 1, y + 1, ROW - 2, ROW - 2);
      rivet(ctx, x + 12, y + 12, 3);
      rivet(ctx, x + ROW - 12, y + 12, 3);
      rivet(ctx, x + 12, y + ROW - 12, 3);
      rivet(ctx, x + ROW - 12, y + ROW - 12, 3);

      // Some panels get a vent grille.
      if (Math.random() < 0.25) {
        const vx = x + 28;
        const vy = y + 44;
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(vx, vy, ROW - 56, 40);
        ctx.strokeStyle = "rgba(120,150,190,0.35)";
        ctx.lineWidth = 2;
        for (let s = 0; s < 5; s++) {
          ctx.beginPath();
          ctx.moveTo(vx + 4, vy + 6 + s * 8);
          ctx.lineTo(vx + ROW - 60, vy + 6 + s * 8);
          ctx.stroke();
        }
      }
    }
  }

  // Grime gradient toward the bottom.
  const grad = ctx.createLinearGradient(0, 0, 0, S);
  grad.addColorStop(0.6, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, S, S);

  scuffs(ctx, S, 50);
  return toTexture(ctx, repeatX, repeatY);
}

export function ceilingTexture(repeat: number): THREE.CanvasTexture {
  const S = 512;
  const ctx = makeCanvas(S);
  const P = S / 2;

  ctx.fillStyle = rgb(24, 32, 48);
  ctx.fillRect(0, 0, S, S);

  for (let py = 0; py < 2; py++) {
    for (let px = 0; px < 2; px++) {
      const x = px * P;
      const y = py * P;
      const mul = 0.9 + Math.random() * 0.2;
      ctx.fillStyle = rgb(24, 32, 48, mul);
      ctx.fillRect(x + 3, y + 3, P - 6, P - 6);
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 4;
      ctx.strokeRect(x + 2, y + 2, P - 4, P - 4);
      rivet(ctx, x + 16, y + 16, 4);
      rivet(ctx, x + P - 16, y + 16, 4);
      rivet(ctx, x + 16, y + P - 16, 4);
      rivet(ctx, x + P - 16, y + P - 16, 4);

      const variant = px === py ? "light" : px === 1 ? "fan" : "pipes";
      const cx = x + P / 2;
      const cy = y + P / 2;

      if (variant === "light") {
        // Recessed light strip with a soft halo; doubles as the glow
        // source through the emissive map.
        ctx.fillStyle = "rgba(160,220,255,0.18)";
        ctx.fillRect(cx - 90, cy - 34, 180, 68);
        ctx.fillStyle = "rgba(160,220,255,0.3)";
        ctx.fillRect(cx - 80, cy - 24, 160, 48);
        ctx.fillStyle = rgb(216, 242, 255);
        ctx.fillRect(cx - 72, cy - 14, 144, 28);
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fillRect(cx - 76, cy - 18, 4, 36);
        ctx.fillRect(cx + 72, cy - 18, 4, 36);
      } else if (variant === "fan") {
        // Extractor fan: dark well with blades and a hub.
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.beginPath();
        ctx.arc(cx, cy, 74, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(110,140,180,0.5)";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(cx, cy, 74, 0, Math.PI * 2);
        ctx.stroke();
        for (let b = 0; b < 5; b++) {
          const a = (b / 5) * Math.PI * 2;
          ctx.strokeStyle = "rgba(90,115,150,0.6)";
          ctx.lineWidth = 12;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * 14, cy + Math.sin(a) * 14);
          ctx.lineTo(cx + Math.cos(a + 0.5) * 64, cy + Math.sin(a + 0.5) * 64);
          ctx.stroke();
        }
        ctx.fillStyle = rgb(50, 65, 95);
        ctx.beginPath();
        ctx.arc(cx, cy, 16, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Conduit pipes running across the panel.
        for (let p = 0; p < 3; p++) {
          const yy = y + 60 + p * 64;
          ctx.fillStyle = rgb(34, 46, 68, 1 + p * 0.06);
          ctx.fillRect(x + 16, yy, P - 32, 26);
          ctx.fillStyle = "rgba(255,255,255,0.08)";
          ctx.fillRect(x + 16, yy + 3, P - 32, 6);
          ctx.fillStyle = "rgba(0,0,0,0.35)";
          ctx.fillRect(x + 16, yy + 20, P - 32, 6);
          rivet(ctx, x + 40, yy + 13, 5);
          rivet(ctx, x + P - 40, yy + 13, 5);
        }
      }
    }
  }

  scuffs(ctx, S, 30);
  return toTexture(ctx, repeat, repeat);
}

/**
 * Crate skins come in three variants so stacks don't all read as clones.
 * Designs are center-weighted: World maps them onto each box face with an
 * aspect-preserving crop, so the circular emblems never get squeezed.
 */
export function crateTexture(variant: number): THREE.CanvasTexture {
  const S = 512;
  const ctx = makeCanvas(S);

  const bases: Array<[number, number, number]> = [
    [46, 62, 92], // hall blue
    [72, 66, 44], // depot olive
    [40, 70, 66], // reactor teal
  ];
  const [br, bg, bb] = bases[variant % 3];

  ctx.fillStyle = rgb(br, bg, bb);
  ctx.fillRect(0, 0, S, S);

  // Outer frame.
  ctx.strokeStyle = rgb(br + 16, bg + 20, bb + 26);
  ctx.lineWidth = 36;
  ctx.strokeRect(18, 18, S - 36, S - 36);
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 3;
  ctx.strokeRect(36, 36, S - 72, S - 72);

  // Recessed inner panel.
  ctx.fillStyle = rgb(br - 8, bg - 10, bb - 14);
  ctx.fillRect(48, 48, S - 96, S - 96);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 2;
  ctx.strokeRect(50, 50, S - 100, S - 100);

  // Corner bolts.
  rivet(ctx, 18, 18, 8);
  rivet(ctx, S - 18, 18, 8);
  rivet(ctx, 18, S - 18, 8);
  rivet(ctx, S - 18, S - 18, 8);

  if (variant % 3 === 0) {
    // Hazard stripe band along the bottom.
    ctx.save();
    ctx.beginPath();
    ctx.rect(48, S - 130, S - 96, 56);
    ctx.clip();
    for (let i = -2; i < 12; i++) {
      ctx.fillStyle = i % 2 === 0 ? rgb(190, 150, 60) : rgb(24, 30, 44);
      ctx.beginPath();
      ctx.moveTo(i * 56, S - 130);
      ctx.lineTo(i * 56 + 56, S - 130);
      ctx.lineTo(i * 56 + 28, S - 74);
      ctx.lineTo(i * 56 - 28, S - 74);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Center emblem: ringed crosshair.
    ctx.strokeStyle = "rgba(79,217,255,0.45)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2 - 30, 52, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(S / 2 - 30, S / 2 - 30);
    ctx.lineTo(S / 2 + 30, S / 2 - 30);
    ctx.stroke();
  } else if (variant % 3 === 1) {
    // Stencilled cargo markings.
    ctx.fillStyle = "rgba(230,190,90,0.5)";
    ctx.font = "bold 64px monospace";
    ctx.textAlign = "center";
    ctx.fillText("MX-07", S / 2, S / 2 - 36);
    ctx.font = "bold 30px monospace";
    ctx.fillText("SUPPLY", S / 2, S / 2 + 8);

    // Double ring emblem below the text.
    ctx.strokeStyle = "rgba(230,190,90,0.45)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2 + 86, 42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2 + 86, 26, 0, Math.PI * 2);
    ctx.stroke();
    // Up arrows in the corners of the panel.
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 6;
    for (const x of [92, S - 92]) {
      ctx.beginPath();
      ctx.moveTo(x - 18, 130);
      ctx.lineTo(x, 100);
      ctx.lineTo(x + 18, 130);
      ctx.stroke();
    }
  } else {
    // Radiation-style trefoil emblem.
    const cx = S / 2;
    const cy = S / 2 - 10;
    ctx.fillStyle = "rgba(87,255,154,0.4)";
    for (let k = 0; k < 3; k++) {
      const a0 = -Math.PI / 2 + (k * Math.PI * 2) / 3 - 0.45;
      ctx.beginPath();
      ctx.arc(cx, cy, 64, a0, a0 + 0.9);
      ctx.arc(cx, cy, 24, a0 + 0.9, a0, true);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, 12, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font = "bold 28px monospace";
    ctx.textAlign = "center";
    ctx.fillText("CELL-9 // SEALED", S / 2, S - 86);

    // Diagonal corner wedges.
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath();
    ctx.moveTo(48, 48);
    ctx.lineTo(140, 48);
    ctx.lineTo(48, 140);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(S - 48, S - 48);
    ctx.lineTo(S - 140, S - 48);
    ctx.lineTo(S - 48, S - 140);
    ctx.closePath();
    ctx.fill();
  }

  scuffs(ctx, S, 60);
  return toTexture(ctx);
}

/**
 * Barrel side skin, horizontally seamless so it wraps a cylinder.
 * Bands and ribs run the full width; stenciling sits mid-face.
 */
export function barrelTexture(variant: number): THREE.CanvasTexture {
  const S = 512;
  const ctx = makeCanvas(S);

  const bases: Array<[number, number, number]> = [
    [58, 74, 104], // steel blue
    [134, 96, 40], // rusty amber
    [44, 84, 70], // toxic green
  ];
  const [br, bg, bb] = bases[variant % 3];
  ctx.fillStyle = rgb(br, bg, bb);
  ctx.fillRect(0, 0, S, S);

  // Vertical brushed streaks (don't cross the seam edges).
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * S;
    ctx.strokeStyle = Math.random() < 0.5 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.1)";
    ctx.lineWidth = 1 + Math.random() * 2;
    ctx.beginPath();
    ctx.moveTo(x, 30 + Math.random() * 80);
    ctx.lineTo(x, S - 30 - Math.random() * 80);
    ctx.stroke();
  }

  // Rolled ribs: raised highlight + shadow pairs, full width = seamless.
  for (const y of [54, 178, S - 178, S - 54]) {
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.fillRect(0, y - 8, S, 8);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, y, S, 10);
  }
  // Dark rims top and bottom.
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(0, 0, S, 26);
  ctx.fillRect(0, S - 26, S, 26);

  if (variant % 3 === 1) {
    // Hazard band across the waist.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, S / 2 - 34, S, 68);
    ctx.clip();
    for (let i = -1; i < 10; i++) {
      ctx.fillStyle = i % 2 === 0 ? rgb(200, 160, 60) : rgb(26, 30, 40);
      ctx.beginPath();
      ctx.moveTo(i * 64, S / 2 - 34);
      ctx.lineTo(i * 64 + 64, S / 2 - 34);
      ctx.lineTo(i * 64 + 32, S / 2 + 34);
      ctx.lineTo(i * 64 - 32, S / 2 + 34);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  } else {
    ctx.fillStyle = variant % 3 === 2 ? "rgba(87,255,154,0.4)" : "rgba(170,210,255,0.4)";
    ctx.font = "bold 44px monospace";
    ctx.textAlign = "center";
    ctx.fillText(variant % 3 === 2 ? "BIOHAZ" : "FUEL-3", S / 2, S / 2 + 14);
  }

  // Rust drips from the top rim.
  for (let i = 0; i < 14; i++) {
    const x = Math.random() * S;
    const len = 20 + Math.random() * 90;
    const g = ctx.createLinearGradient(0, 26, 0, 26 + len);
    g.addColorStop(0, "rgba(70,40,20,0.4)");
    g.addColorStop(1, "rgba(70,40,20,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x, 26, 3 + Math.random() * 4, len);
  }

  scuffs(ctx, S, 30);
  return toTexture(ctx);
}

/** Circular lid for barrel/drum caps: rim ring, cross handle, bolts. */
export function barrelLidTexture(): THREE.CanvasTexture {
  const S = 256;
  const ctx = makeCanvas(S);
  const c = S / 2;

  ctx.fillStyle = rgb(52, 64, 88);
  ctx.fillRect(0, 0, S, S);

  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(c, c, c - 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(c, c, c - 26, 0, Math.PI * 2);
  ctx.stroke();

  // Cross brace.
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.moveTo(c - 70, c);
  ctx.lineTo(c + 70, c);
  ctx.moveTo(c, c - 70);
  ctx.lineTo(c, c + 70);
  ctx.stroke();
  ctx.fillStyle = rgb(64, 78, 106);
  ctx.beginPath();
  ctx.arc(c, c, 26, 0, Math.PI * 2);
  ctx.fill();
  rivet(ctx, c, c, 8);

  // Bolt circle.
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    rivet(ctx, c + Math.cos(a) * (c - 26), c + Math.sin(a) * (c - 26), 6);
  }

  scuffs(ctx, S, 14);
  return toTexture(ctx);
}

/** Emissive console screen (2:1) with radar, waveform and bar gauges. */
export function screenTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 128;
  const ctx = makeCanvasWH(W, H);

  ctx.fillStyle = rgb(6, 16, 22);
  ctx.fillRect(0, 0, W, H);

  // Grid.
  ctx.strokeStyle = "rgba(79,217,255,0.12)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y <= H; y += 16) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // Radar circle with sweep (left half) — square pixels keep it round.
  const rc = 52;
  ctx.strokeStyle = "rgba(79,217,255,0.6)";
  ctx.lineWidth = 2;
  for (const r of [18, 32, 46]) {
    ctx.beginPath();
    ctx.arc(60, 64, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(79,217,255,0.18)";
  ctx.beginPath();
  ctx.moveTo(60, 64);
  ctx.arc(60, 64, rc - 6, -0.4, 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(120,255,170,0.9)";
  for (const [bx, by] of [
    [44, 48],
    [78, 76],
    [66, 40],
  ]) {
    ctx.fillRect(bx, by, 3, 3);
  }

  // Waveform (top right).
  ctx.strokeStyle = "rgba(87,255,154,0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= 110; x += 2) {
    const y = 34 + Math.sin(x * 0.22) * 12 * Math.sin(x * 0.045);
    if (x === 0) ctx.moveTo(128 + x, y);
    else ctx.lineTo(128 + x, y);
  }
  ctx.stroke();

  // Bar gauges (bottom right).
  for (let i = 0; i < 7; i++) {
    const h = 8 + ((i * 37) % 36);
    ctx.fillStyle = i === 4 ? "rgba(255,150,80,0.85)" : "rgba(79,217,255,0.7)";
    ctx.fillRect(132 + i * 16, 112 - h, 10, h);
  }

  // Scanlines.
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 2);

  const t = new THREE.CanvasTexture(ctx.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function pillarTexture(repeatY: number): THREE.CanvasTexture {
  const S = 256;
  const ctx = makeCanvas(S);

  ctx.fillStyle = rgb(40, 57, 90);
  ctx.fillRect(0, 0, S, S);

  // Vertical brushed streaks.
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * S;
    ctx.strokeStyle = Math.random() < 0.5 ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.08)";
    ctx.lineWidth = 1 + Math.random() * 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, S);
    ctx.stroke();
  }

  // Edge trims.
  ctx.fillStyle = rgb(58, 78, 116);
  ctx.fillRect(0, 0, 18, S);
  ctx.fillRect(S - 18, 0, 18, S);
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(19, 0);
  ctx.lineTo(19, S);
  ctx.moveTo(S - 19, 0);
  ctx.lineTo(S - 19, S);
  ctx.stroke();

  // Glowing accent lines inside the trims.
  ctx.fillStyle = "rgba(79,217,255,0.5)";
  ctx.fillRect(7, 0, 3, S);
  ctx.fillRect(S - 10, 0, 3, S);

  // Horizontal seam with bolts.
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(0, S / 2 - 2, S, 4);
  rivet(ctx, 34, S / 2, 4);
  rivet(ctx, S / 2, S / 2, 4);
  rivet(ctx, S - 34, S / 2, 4);

  scuffs(ctx, S, 25);
  return toTexture(ctx, 1, repeatY);
}

/** Grayscale brushed metal; tinted by each material's color. */
export function metalTexture(): THREE.CanvasTexture {
  const S = 256;
  const ctx = makeCanvas(S);

  ctx.fillStyle = rgb(200, 205, 214);
  ctx.fillRect(0, 0, S, S);

  for (let i = 0; i < 300; i++) {
    const y = Math.random() * S;
    const x = Math.random() * S;
    const len = 20 + Math.random() * 120;
    const v = 175 + Math.random() * 70;
    ctx.strokeStyle = `rgba(${v | 0},${(v + 4) | 0},${(v + 10) | 0},0.25)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y);
    ctx.stroke();
  }

  // Sparse panel seams.
  ctx.strokeStyle = "rgba(40,50,70,0.5)";
  ctx.lineWidth = 2;
  for (const y of [64, 150, 210]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(S, y);
    ctx.stroke();
  }
  rivet(ctx, 26, 40, 4);
  rivet(ctx, 200, 100, 4);
  rivet(ctx, 90, 180, 4);

  return toTexture(ctx);
}

/** Dark soil with pebbles, moss patches and a worn stone path streak. */
export function soilTexture(repeat: number): THREE.CanvasTexture {
  const S = 512;
  const ctx = makeCanvas(S);

  ctx.fillStyle = rgb(38, 32, 26);
  ctx.fillRect(0, 0, S, S);

  // Earth mottling.
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 4 + Math.random() * 18;
    const mul = 0.7 + Math.random() * 0.6;
    ctx.fillStyle = `rgba(${(44 * mul) | 0},${(36 * mul) | 0},${(28 * mul) | 0},0.5)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Moss patches.
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 6 + Math.random() * 22;
    ctx.fillStyle = `rgba(${30 + Math.random() * 25},${55 + Math.random() * 35},30,${0.18 + Math.random() * 0.2})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Pebbles.
  for (let i = 0; i < 130; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 1.5 + Math.random() * 4;
    const g = 80 + Math.random() * 70;
    ctx.fillStyle = `rgba(${g},${g},${g * 1.05},0.8)`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.7, Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath();
    ctx.ellipse(x + 1, y + 1.5, r, r * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  scuffs(ctx, S, 40);

  return toTexture(ctx, repeat, repeat);
}

/** Square stepping-stone plates for garden paths. */
export function pavingTexture(): THREE.CanvasTexture {
  const S = 256;
  const ctx = makeCanvas(S);
  ctx.fillStyle = rgb(38, 32, 26);
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = rgb(96, 100, 108);
  ctx.beginPath();
  // Irregular rounded slab.
  ctx.moveTo(30, 46);
  ctx.quadraticCurveTo(128, 14, 224, 42);
  ctx.quadraticCurveTo(246, 128, 222, 214);
  ctx.quadraticCurveTo(128, 244, 34, 216);
  ctx.quadraticCurveTo(12, 128, 30, 46);
  ctx.fill();
  for (let i = 0; i < 50; i++) {
    const x = 40 + Math.random() * 176;
    const y = 40 + Math.random() * 176;
    ctx.fillStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.1})`;
    ctx.beginPath();
    ctx.arc(x, y, 2 + Math.random() * 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 3;
  ctx.stroke();
  return toTexture(ctx);
}

/** Grayscale techno-organic skin; tinted per enemy kind. */
export function enemyTexture(): THREE.CanvasTexture {
  const S = 256;
  const ctx = makeCanvas(S);

  ctx.fillStyle = rgb(185, 185, 190);
  ctx.fillRect(0, 0, S, S);

  // Dark mottled cells.
  for (let i = 0; i < 80; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 6 + Math.random() * 22;
    ctx.fillStyle = `rgba(40,40,50,${0.08 + Math.random() * 0.14})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Bright crack veins.
  for (let i = 0; i < 26; i++) {
    let x = Math.random() * S;
    let y = Math.random() * S;
    ctx.strokeStyle = `rgba(255,255,255,${0.25 + Math.random() * 0.3})`;
    ctx.lineWidth = 1 + Math.random();
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 5; s++) {
      x += (Math.random() - 0.5) * 50;
      y += (Math.random() - 0.5) * 50;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Dark fissures.
  for (let i = 0; i < 14; i++) {
    let x = Math.random() * S;
    let y = Math.random() * S;
    ctx.strokeStyle = "rgba(15,15,25,0.5)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 4; s++) {
      x += (Math.random() - 0.5) * 60;
      y += (Math.random() - 0.5) * 60;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  return toTexture(ctx);
}
