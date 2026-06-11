import Gun from "gun";

/**
 * Pose + combat state every peer publishes about itself (~15 Hz).
 * Kept flat and short-keyed: gun ships every field name over the wire.
 */
export interface PeerState {
  n: string; // display name
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  h: number; // health
  w: number; // weapon index
  k: number; // kills (self-counted)
  d: number; // deaths (self-counted)
  s: number; // shot sequence number
  sdx: number; // last shot direction
  sdy: number;
  sdz: number;
  ks: number; // death sequence number
  kb: string; // peer id that caused the last death
  t: number; // sender wall-clock, only for debugging
}

const RELAY = "https://vibing.at/gun";
/** Drop peers that haven't published for this long (local clock). */
export const PEER_TIMEOUT_MS = 7000;

/**
 * Minimal view of a gun chain. Gun's bundled generics infer `never`
 * for dynamic string keys, so we keep our own loose-but-honest type.
 */
interface GunChain {
  get(key: string): GunChain;
  put(data: Record<string, unknown>): GunChain;
  map(): GunChain;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(cb: (data: any, key: string) => void): GunChain;
  off(): void;
}

/**
 * Decentralized transport on gun.js. Everything is peer-to-peer state
 * under one room node; the relay on vibing.at only provides discovery
 * and message passing. Trust model: trust-the-shooter — each client
 * raycasts its own shots and writes cumulative damage totals into the
 * victim's damage node; the victim applies the deltas to itself.
 */
export class Net {
  readonly id: string;
  private players: GunChain;
  private dmg: GunChain;
  /** Cumulative damage dealt per victim (we only ever increase it). */
  private dealtTotals = new Map<string, number>();
  /** Last damage total seen per attacker (to apply deltas once). */
  private seenTotals = new Map<string, number>();

  onPeer: (id: string, state: PeerState) => void = () => {};
  onDamage: (attackerId: string, amount: number) => void = () => {};

  constructor(room: string) {
    this.id = Math.random().toString(36).slice(2, 10);
    const gun = Gun({
      peers: [RELAY],
      localStorage: false,
      radisk: false,
    }) as unknown as GunChain;
    const roomNode = gun.get(`mythos-mp/${room}`);
    this.players = roomNode.get("p");
    this.dmg = roomNode.get("dmg");

    this.players.map().on((data: Partial<PeerState> | undefined, key: string) => {
      if (!data || key === this.id || typeof data.x !== "number") return;
      this.onPeer(key, data as PeerState);
    });

    // Our own damage inbox: one cumulative counter per attacker.
    this.dmg
      .get(this.id)
      .map()
      .on((data: { total?: number } | undefined, attackerId: string) => {
        if (!data || typeof data.total !== "number") return;
        // Our id is random per session, so anything under our damage
        // node was dealt to us in this session: deltas start at zero.
        const seen = this.seenTotals.get(attackerId) ?? 0;
        if (data.total > seen) {
          this.seenTotals.set(attackerId, data.total);
          this.onDamage(attackerId, data.total - seen);
        }
      });
  }

  publish(state: PeerState): void {
    this.players.get(this.id).put(state as unknown as Record<string, unknown>);
  }

  dealDamage(victimId: string, amount: number): void {
    const total = (this.dealtTotals.get(victimId) ?? 0) + amount;
    this.dealtTotals.set(victimId, total);
    this.dmg.get(victimId).get(this.id).put({ total, t: Date.now() });
  }

  /** Stop publishing; lets the peer time out for everyone else. */
  leave(): void {
    this.players.get(this.id).off();
  }
}
