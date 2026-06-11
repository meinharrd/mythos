// Headless arena player for multiplayer testing.
// Usage: node scripts/mp-bot.mjs <room> <name> [--shoot]
// Walks a circle around the central platform, publishes its pose at
// 15 Hz with the same protocol as the browser client, applies damage
// written to its inbox, and (with --shoot) deals damage to one peer.
import Gun from "gun";

const [room = "arena", name = "Bot", flag = ""] = process.argv.slice(2);
const SHOOT = flag === "--shoot";
const RELAY = process.env.GUN_RELAY || "https://vibing.at/gun";

const id = Math.random().toString(36).slice(2, 10);
const gun = Gun({ peers: [RELAY], file: `/tmp/mp-bot-${id}` });
const roomNode = gun.get(`mythos-mp/${room}`);
const players = roomNode.get("p");
const dmg = roomNode.get("dmg");

const log = (...a) => console.log(`[${name}]`, ...a);
log(`joining room "${room}" via ${RELAY} as ${id}`);

let health = 300;
let kills = 0;
let deaths = 0;
let shotSeq = 0;
let deathSeq = 0;
let killedBy = "";
let angle = Math.random() * Math.PI * 2;
const peers = new Map(); // id -> {name, x, z, lastSeen}
const seenTotals = new Map();

players.map().on((data, key) => {
  if (!data || key === id || typeof data.x !== "number") return;
  const first = !peers.has(key);
  peers.set(key, { name: data.n, x: data.x, y: data.y, z: data.z, h: data.h, t: Date.now() });
  if (first) log(`sees peer ${data.n} (${key})`);
});

dmg.get(id).map().on((data, attackerId) => {
  if (!data || typeof data.total !== "number") return;
  const seen = seenTotals.get(attackerId) ?? 0;
  if (data.total <= seen) return;
  const delta = data.total - seen;
  seenTotals.set(attackerId, data.total);
  if (health <= 0) return;
  health -= delta;
  log(`took ${delta} damage from ${peers.get(attackerId)?.name ?? attackerId} -> ${Math.max(0, health)} hp`);
  if (health <= 0) {
    deaths++;
    deathSeq++;
    killedBy = attackerId;
    log(`DIED (death #${deaths}), respawning in 3.5s`);
    setTimeout(() => {
      health = 300;
      log("respawned");
    }, 3500);
  }
});

// Walk a circle of radius 16 around the platform.
setInterval(() => {
  angle += 0.035;
  const x = Math.cos(angle) * 16;
  const z = Math.sin(angle) * 16;
  players.get(id).put({
    n: name,
    x: Math.round(x * 100) / 100,
    y: 0,
    z: Math.round(z * 100) / 100,
    // Face the walk direction in the client's camera convention
    // (yaw 0 looks toward -z, forward = (-sin yaw, -cos yaw)).
    yaw: Math.round((Math.PI - angle) * 100) / 100,
    pitch: 0,
    h: Math.max(0, Math.round(health)),
    w: 0,
    k: kills,
    d: deaths,
    s: shotSeq,
    sdx: 1,
    sdy: 0,
    sdz: 0,
    ks: deathSeq,
    kb: killedBy,
    t: Date.now(),
  });
}, 66);

if (SHOOT) {
  const dealt = new Map();
  setInterval(() => {
    if (health <= 0) return;
    const target = [...peers.entries()].find(([, p]) => Date.now() - p.t < 5000 && p.h > 0);
    if (!target) return;
    const [tid, p] = target;
    shotSeq++;
    const total = (dealt.get(tid) ?? 0) + 22;
    dealt.set(tid, total);
    dmg.get(tid).get(id).put({ total, t: Date.now() });
    log(`shot ${p.name} (total dealt ${total})`);
  }, 1500);
}

// Status line every 5s.
setInterval(() => {
  const list = [...peers.values()]
    .filter((p) => Date.now() - p.t < 5000)
    .map((p) => `${p.name}@(${p.x.toFixed(0)},${p.z.toFixed(0)})hp${p.h}`)
    .join(" ");
  log(`status hp=${Math.max(0, health)} k=${kills} d=${deaths} peers: ${list || "none"}`);
}, 5000);
