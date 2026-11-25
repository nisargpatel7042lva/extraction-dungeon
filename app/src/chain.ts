// Everything that talks to Solana / the (Private) Ephemeral Rollup. Shared by the browser game and
// the Node scripts, so the smoke test exercises exactly the code the game runs.
//
// On devnet the game runs on MagicBlock's TEE rollup (Private Ephemeral Rollup). Every rollup
// connection is authenticated with a token for one identity (a session key): that's what lets a
// player read their own private Bag while nobody else can.
import { AnchorProvider, Program } from "@anchor-lang/core";
import BN from "bn.js";
import nacl from "tweetnacl";
import {
  AccountMeta,
  Commitment,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  getAuthToken,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import idl from "./idl/extraction_dungeon.json";
import type { ExtractionDungeon } from "./idl/extraction_dungeon";

export type Net = "local" | "devnet";

export interface NetConfig {
  base: string;
  baseWs: string;
  er: string;
  erWs: string;
  /** ER validator to delegate to. */
  validator: PublicKey;
  /** Whether the dev wallet can airdrop itself. */
  airdrop: boolean;
  /** TEE rollup: connections need an auth token, and private accounts are hidden. */
  tee: boolean;
}

export const NETS: Record<Net, NetConfig> = {
  local: {
    base: "http://127.0.0.1:8899",
    baseWs: "ws://127.0.0.1:8900",
    er: "http://127.0.0.1:7799",
    erWs: "ws://127.0.0.1:7800",
    validator: new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"),
    airdrop: true,
    tee: false,
  },
  devnet: {
    // MagicBlock's free devnet RPC: the public api.devnet.solana.com rate-limits hard (429s).
    base: "https://rpc.magicblock.app/devnet",
    baseWs: "wss://rpc.magicblock.app/devnet",
    er: "https://devnet-tee.magicblock.app",
    erWs: "wss://devnet-tee.magicblock.app",
    validator: new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"),
    airdrop: false,
    tee: true,
  },
};

export const PROGRAM_ID = new PublicKey(idl.address);
export const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
export const EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
export const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");

export const Dir = { Up: 0, Right: 1, Down: 2, Left: 3 } as const;
export const Status = { Lobby: 0, Live: 1, Ended: 2, Cancelled: 3 } as const;
/** Rollup blockhashes go stale within ~2 s: refresh in the background past this age... */
const ER_HASH_REFRESH_MS = 400;
/** ...and never sign with one older than this. */
const ER_HASH_MAX_AGE_MS = 900;

/** The run account was made by an older version of the program and can't be read any more. */
export class OutdatedRunError extends Error {
  constructor() {
    super("This game was created with an older version of Extraction Dungeon.");
    this.name = "OutdatedRunError";
  }
}

/** Mirrors LOBBY_TIMEOUT_SECS: after this, anyone can cancel a lobby that never started. */
export const LOBBY_TIMEOUT_SECS = 600;
export const ChestState = { Closed: 0, Opening: 1, Opened: 2 } as const;
export const TIER_NAMES: Record<number, string> = { 1: "COMMON", 2: "RARE", 3: "LEGENDARY", 4: "MIMIC! -1♥" };
export const TIER_POINTS: Record<number, number> = { 1: 1, 2: 3, 3: 8, 4: 0 };
/** Mirrors TIER_MIMIC: a chest that bites (1 damage, no loot). */
export const TIER_MIMIC = 4;
/** Mirrors ATTACK_COOLDOWN_SLOTS (36 slots at ~11ms). The program is the authority. */
export const ATTACK_COOLDOWN_MS = 420;
/** Mirrors EXTRACT_CHANNEL_SLOTS (180 slots at ~11ms), plus a little slack for slot jitter. */
export const EXTRACT_CHANNEL_MS = 2100;

/** Mirrors `MAPS` in programs/extraction_dungeon/src/map.rs. Each run is played on one of these. */
export const MAPS: { name: string; LAYOUT: string[]; CHESTS: [number, number][]; EXTRACTS: [number, number][] }[] = [
  {
    name: "CROSSROADS",
    LAYOUT: [
      "####################",
      "#....#........#....#",
      "#.##.#..####..#.##.#",
      "#..................#",
      "###.##.##..##.##.###",
      "#........##........#",
      "#.#..#........#..#.#",
      "#........##........#",
      "###.##.##..##.##.###",
      "#..................#",
      "#.##.#..####..#.##.#",
      "#....#........#....#",
      "####################",
    ],
    CHESTS: [[3, 1], [16, 1], [3, 11], [16, 11], [5, 3], [14, 3], [5, 9], [14, 9], [1, 6], [18, 6], [9, 6]],
    EXTRACTS: [[3, 6], [16, 6], [9, 1], [10, 11]],
  },
  {
    name: "PILLARS",
    LAYOUT: [
      "####################",
      "#..................#",
      "#.#.#.#.#..#.#.#.#.#",
      "#..................#",
      "#.#.#.#.#..#.#.#.#.#",
      "#..................#",
      "#.#...#......#...#.#",
      "#..................#",
      "#.#.#.#.#..#.#.#.#.#",
      "#..................#",
      "#.#.#.#.#..#.#.#.#.#",
      "#..................#",
      "####################",
    ],
    CHESTS: [[4, 1], [15, 1], [4, 11], [15, 11], [3, 4], [16, 4], [3, 8], [16, 8], [3, 6], [16, 6], [9, 6]],
    EXTRACTS: [[1, 6], [18, 6], [9, 3], [10, 9]],
  },
  {
    name: "ROOMS",
    LAYOUT: [
      "####################",
      "#....#........#....#",
      "#....#........#....#",
      "#....#.##..##.#....#",
      "##.###.#....#.###.##",
      "#..................#",
      "#...##........##...#",
      "#..................#",
      "##.###.#....#.###.##",
      "#....#.##..##.#....#",
      "#....#........#....#",
      "#....#........#....#",
      "####################",
    ],
    CHESTS: [[4, 2], [15, 2], [4, 10], [15, 10], [8, 4], [11, 4], [8, 8], [11, 8], [2, 6], [17, 6], [9, 6]],
    EXTRACTS: [[6, 6], [13, 6], [9, 1], [10, 11]],
  },
  {
    name: "SERPENT",
    LAYOUT: [
      "####################",
      "#...#..........#...#",
      "#.#.#.###..###.#.#.#",
      "#.#...#......#...#.#",
      "#.###.#.####.#.###.#",
      "#..................#",
      "###.##.#....#.##.###",
      "#..................#",
      "#.###.#.####.#.###.#",
      "#.#...#......#...#.#",
      "#.#.#.###..###.#.#.#",
      "#...#..........#...#",
      "####################",
    ],
    CHESTS: [[3, 1], [16, 1], [3, 11], [16, 11], [7, 3], [12, 3], [7, 9], [12, 9], [3, 6], [16, 6], [9, 6]],
    EXTRACTS: [[1, 5], [18, 5], [5, 1], [14, 11]],
  },
  {
    name: "RING",
    LAYOUT: [
      "####################",
      "#..................#",
      "#.######....######.#",
      "#.#..............#.#",
      "#.#.####.##.####.#.#",
      "#.....#......#.....#",
      "##.#............#.##",
      "#.....#......#.....#",
      "#.#.####.##.####.#.#",
      "#.#..............#.#",
      "#.######....######.#",
      "#..................#",
      "####################",
    ],
    CHESTS: [[3, 3], [16, 3], [3, 9], [16, 9], [7, 5], [12, 5], [7, 7], [12, 7], [4, 6], [15, 6], [9, 6]],
    EXTRACTS: [[2, 6], [17, 6], [9, 2], [10, 10]],
  },
];

/** The map of the run being shown. Mutated in place by `useLayout`, so every module that imports
 *  it sees the current run's dungeon. */
export const MAP = {
  W: 20,
  H: 13,
  layout: 0,
  name: MAPS[0].name,
  LAYOUT: [...MAPS[0].LAYOUT],
  CHESTS: [...MAPS[0].CHESTS],
  /** Index of the Vault chest (rare or legendary only). Last on every map. */
  VAULT: 10,
  EXTRACTS: [...MAPS[0].EXTRACTS],
};

/** Switches `MAP` to a run's layout. Returns true if it changed. */
export function useLayout(layout: number): boolean {
  const i = ((layout % MAPS.length) + MAPS.length) % MAPS.length;
  if (i === MAP.layout) return false;
  const m = MAPS[i];
  MAP.layout = i;
  MAP.name = m.name;
  MAP.LAYOUT = [...m.LAYOUT];
  MAP.CHESTS = [...m.CHESTS];
  MAP.EXTRACTS = [...m.EXTRACTS];
  return true;
}

/** On-chain time as the program sees it. The rollup's Clock sysvar runs a few seconds off device
 *  clocks (measured ~2.5 s behind), so countdowns use `chainClock.now()` after `Chain.syncClock`. */
export const chainClock = {
  skew: 0,
  now(): number {
    return Date.now() / 1000 + this.skew;
  },
};

/** Unix time at which exits unlock (a quarter of the way into the run). */
export function exitsOpenAt(s: { endsAt: BN; durationSecs: number }): number {
  return Number(s.endsAt.toString()) - Math.floor((s.durationSecs * 3) / 4);
}

export interface PlayerSlot {
  wallet: PublicKey;
  signer: PublicKey;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  extracted: boolean;
  kills: number;
  lastAttackSlot: BN;
  /** Non-zero while this player is channeling an extraction (public: everyone sees it). */
  extractStartSlot: BN;
}
export interface RunState {
  authority: PublicKey;
  runId: BN;
  status: number;
  playerCount: number;
  entryLamports: BN;
  pot: BN;
  durationSecs: number;
  endsAt: BN;
  players: PlayerSlot[];
  chests: { state: number; tier: number; opener: number }[];
  dropped: { x: number; y: number; points: number; present: boolean }[];
  settled: boolean;
  /** Index into `MAPS`. */
  layout: number;
  createdAt: BN;
  /** Vault Guardians (public). */
  monsters: { x: number; y: number; homeX: number; homeY: number; hp: number; alive: boolean; lastAttackSlot: BN }[];
  lastTickSlot: BN;
  /** Who scheduled the guardian crank, and the crank signer PDA (default until scheduled). */
  crankAuthority: PublicKey;
  crankSigner: PublicKey;
}
/** A seat's private loot. Readable on the TEE only by that seat's session key. */
export interface BagState {
  run: PublicKey;
  seat: number;
  points: number;
  dropped: number;
  lastTier: number;
}

/** Signs transactions for the player's real wallet (Phantom, or a dev keypair). */
export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

export function keypairSigner(kp: Keypair): WalletSigner {
  return {
    publicKey: kp.publicKey,
    async signTransaction(tx) {
      tx.partialSign(kp);
      return tx;
    },
  };
}

export function runPda(authority: PublicKey, runId: BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("run"), authority.toBuffer(), runId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  )[0];
}
export function vaultPda(run: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), run.toBuffer()], PROGRAM_ID)[0];
}
export function bagPda(run: PublicKey, seat: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bag"), run.toBuffer(), Buffer.from([seat])], PROGRAM_ID)[0];
}
const PROGRAM_IDENTITY = PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID)[0];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Chain {
  readonly base: Connection;
  readonly program: Program<ExtractionDungeon>;
  /** Identity for public reads on the TEE (any key can authenticate). */
  private readonly viewer = Keypair.generate();
  private erConns = new Map<string, Promise<Connection>>();

  constructor(readonly net: NetConfig, private commitment: Commitment = "confirmed") {
    this.base = new Connection(net.base, { commitment, wsEndpoint: net.baseWs });
    // Instructions only: we sign and send ourselves, so the provider wallet is never used.
    const dummy = {
      publicKey: PublicKey.default,
      signTransaction: async (t: any) => t,
      signAllTransactions: async (t: any) => t,
    };
    this.program = new Program<ExtractionDungeon>(idl as any, new AnchorProvider(this.base, dummy as any, {}));
  }

  /** A rollup connection authenticated as `who` (default: an anonymous viewer). On the TEE the
   *  identity signs an auth challenge locally; no wallet involved. */
  er(who: Keypair = this.viewer): Promise<Connection> {
    const key = who.publicKey.toBase58();
    let c = this.erConns.get(key);
    if (!c) {
      c = (async () => {
        if (!this.net.tee) return new Connection(this.net.er, { commitment: this.commitment, wsEndpoint: this.net.erWs });
        const auth = await getAuthToken(this.net.er, who.publicKey, (m: Uint8Array) =>
          Promise.resolve(nacl.sign.detached(m, who.secretKey)),
        );
        return new Connection(`${this.net.er}?token=${auth.token}`, {
          commitment: this.commitment,
          wsEndpoint: `${this.net.erWs}?token=${auth.token}`,
        });
      })();
      c.catch(() => this.erConns.delete(key));
      this.erConns.set(key, c);
    }
    return c;
  }

  // ---------- reading ----------

  /** Measures the rollup's clock against the device clock (half the round trip compensated). */
  async syncClock(): Promise<number> {
    const conn = await this.er();
    const t0 = Date.now();
    const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
    const t1 = Date.now();
    if (!info) return chainClock.skew;
    const unix = Number(info.data.readBigInt64LE(32));
    chainClock.skew = unix - (t0 + t1) / 2000;
    return chainClock.skew;
  }

  decode(data: Buffer): RunState {
    try {
      return this.program.coder.accounts.decode("run", data) as RunState;
    } catch (e) {
      // A run created before a program upgrade that grew the Run account is shorter than the
      // current layout, and decoding it overruns the buffer.
      if (e instanceof RangeError) throw new OutdatedRunError();
      throw e;
    }
  }

  decodeBag(data: Buffer): BagState {
    return this.program.coder.accounts.decode("bag", data) as BagState;
  }

  bags(run: PublicKey, count: number): PublicKey[] {
    return Array.from({ length: count }, (_, i) => bagPda(run, i));
  }

  private bagMetas(run: PublicKey, count: number, writable = true): AccountMeta[] {
    return this.bags(run, count).map((pubkey) => ({ pubkey, isSigner: false, isWritable: writable }));
  }

  /** Reads the run from wherever it currently lives: the ER while delegated, else base. */
  async fetchRun(run: PublicKey): Promise<{ state: RunState; onEr: boolean } | null> {
    const baseInfo = await this.base.getAccountInfo(run);
    if (!baseInfo) return null;
    if (!baseInfo.owner.equals(PROGRAM_ID)) {
      const erInfo = await (await this.er()).getAccountInfo(run).catch(() => null);
      if (erInfo) return { state: this.decode(erInfo.data), onEr: true };
      return null; // delegated but not readable on the ER yet
    }
    return { state: this.decode(baseInfo.data), onEr: false };
  }

  /** A seat's bag: from the ER through the owner's authenticated connection while delegated,
   *  else from base (where it's public after the run). Null if it can't be read. */
  async fetchBag(run: PublicKey, seat: number, owner?: Keypair): Promise<BagState | null> {
    const pda = bagPda(run, seat);
    const baseInfo = await this.base.getAccountInfo(pda);
    if (baseInfo && baseInfo.owner.equals(PROGRAM_ID)) return this.decodeBag(baseInfo.data);
    const info = await (await this.er(owner)).getAccountInfo(pda).catch(() => null);
    return info ? this.decodeBag(info.data) : null;
  }

  /** Live updates of the run, from the ER (during play) or base (lobby / after commit).
   *  On base, `onDelegated` fires when the account is handed to the delegation program,
   *  i.e. the run just went live on the ER. */
  subscribe(conn: "er" | "base", run: PublicKey, cb: (s: RunState) => void, onDelegated?: () => void): () => void {
    let stop = () => {};
    let stopped = false;
    void (async () => {
      const c = conn === "er" ? await this.er() : this.base;
      if (stopped) return;
      const id = c.onAccountChange(
        run,
        (info) => {
          if (conn === "base" && !info.owner.equals(PROGRAM_ID)) {
            onDelegated?.();
            return;
          }
          try {
            cb(this.decode(info.data));
          } catch {
            /* not a Run (e.g. mid-delegation) */
          }
        },
        { commitment: "processed" },
      );
      stop = () => void c.removeAccountChangeListener(id);
    })();
    return () => {
      stopped = true;
      stop();
    };
  }

  /** Live updates of your own private bag on the ER. */
  subscribeBag(owner: Keypair, run: PublicKey, seat: number, cb: (b: BagState) => void): () => void {
    let stop = () => {};
    let stopped = false;
    void (async () => {
      const c = await this.er(owner);
      if (stopped) return;
      const id = c.onAccountChange(
        bagPda(run, seat),
        (info) => {
          try {
            cb(this.decodeBag(info.data));
          } catch {
            /* ignore */
          }
        },
        { commitment: "processed" },
      );
      stop = () => void c.removeAccountChangeListener(id);
    })();
    return () => {
      stopped = true;
      stop();
    };
  }

  // ---------- sending ----------

  private async send(
    conn: Connection,
    ixs: TransactionInstruction[],
    feePayer: PublicKey,
    sign: (tx: Transaction) => Promise<Transaction>,
  ): Promise<string> {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = feePayer;
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    const signed = await sign(tx);
    const sig = await conn.sendRawTransaction(signed.serialize());
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
    if (res.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  private sendBase(wallet: WalletSigner, ixs: TransactionInstruction[]) {
    return this.send(this.base, ixs, wallet.publicKey, (t) => wallet.signTransaction(t));
  }

  private erNonce = 0;
  private erHash: { blockhash: string; lastValidBlockHeight: number; at: number } | null = null;
  private erHashFetch: Promise<unknown> | null = null;
  /** Called when a fire-and-forget ER action later turns out to have failed. */
  onActionError: ((err: string, signer: PublicKey) => void) | null = null;

  /** ER blockhash, refreshed ahead of time so most actions don't pay a round trip for it.
   *  Rollup slots are ~11 ms, so a blockhash expires within a couple of seconds: never hand out
   *  one older than ER_HASH_MAX_AGE_MS (that caused "Blockhash not found" after any pause). */
  private async erBlockhash(fresh = false) {
    const age = this.erHash ? Date.now() - this.erHash.at : Infinity;
    if ((fresh || age > ER_HASH_REFRESH_MS) && !this.erHashFetch) {
      this.erHashFetch = this.er()
        .then((c) => c.getLatestBlockhash())
        .then((h) => (this.erHash = { ...h, at: Date.now() }))
        .finally(() => (this.erHashFetch = null));
    }
    if (fresh || age > ER_HASH_MAX_AGE_MS) await this.erHashFetch;
    return this.erHash!;
  }

  /** ER transactions are signed and fee-paid by the session key alone: no wallet popups.
   *  ER blockhashes change slowly, so two identical moves (e.g. Down, Down) would serialize to
   *  the same bytes and the second would be dropped as "already processed". A rotating compute
   *  unit limit makes every transaction unique without touching the program.
   *  With `confirm = false` this resolves as soon as the ER has the transaction; confirmation
   *  runs in the background and failures are reported via `onActionError`. */
  private async sendEr(session: Keypair, ixs: TransactionInstruction[], confirm = true) {
    const conn = await this.er(session);
    const build = async (fresh: boolean) => {
      const nonce = ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 + (this.erNonce++ % 50_000) });
      const hash = await this.erBlockhash(fresh);
      const tx = new Transaction().add(nonce, ...ixs);
      tx.feePayer = session.publicKey;
      tx.recentBlockhash = hash.blockhash;
      tx.sign(session);
      return { tx, ...hash };
    };
    let built = await build(false);
    let sig: string;
    try {
      sig = await conn.sendRawTransaction(built.tx.serialize(), { skipPreflight: true });
    } catch (e) {
      // The rollup moved past our blockhash between fetching it and sending: once more, fresh.
      if (!/blockhash not found/i.test((e as Error)?.message ?? "")) throw e;
      built = await build(true);
      sig = await conn.sendRawTransaction(built.tx.serialize(), { skipPreflight: true });
    }
    const { blockhash, lastValidBlockHeight } = built;
    const confirmed = conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "processed").then((r) => {
      if (r.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(r.value.err)}`);
    });
    if (confirm) await confirmed;
    else confirmed.catch((e) => this.onActionError?.((e as Error).message, session.publicKey));
    return sig;
  }

  /** Retries an ER call that depends on the ER having cloned freshly delegated accounts. */
  private async retryEr<T>(f: () => Promise<T>, what: string, timeoutMs = 30_000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      try {
        return await f();
      } catch (e) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`${what}: ${(e as Error).message}`);
        await sleep(700);
      }
    }
  }

  // ---------- base layer ----------

  /** Opens a run on `layout`, or on a random map when omitted. */
  /** Opens a run on `layout` (random when omitted). With `seatHost`, the host also takes seat P1 in
   *  the same transaction (create + join + delegate their private bag: one wallet approval);
   *  `seatHost(run)` returns the session key to register for that run. */
  async createRun(
    wallet: WalletSigner,
    entryLamports: number,
    durationSecs: number,
    opts: { layout?: number; seatHost?: (run: PublicKey) => PublicKey } = {},
  ) {
    const layout = opts.layout ?? Math.floor(Math.random() * MAPS.length);
    const runId = new BN(Date.now());
    const run = runPda(wallet.publicKey, runId);
    const ixs = [
      await this.program.methods
        .createRun(runId, new BN(entryLamports), durationSecs, layout)
        .accountsPartial({ authority: wallet.publicKey, run, vault: vaultPda(run) })
        .instruction(),
    ];
    if (opts.seatHost) {
      const session = opts.seatHost(run);
      const bag = bagPda(run, 0);
      ixs.push(
        await this.program.methods
          .joinRun(session)
          .accountsPartial({ player: wallet.publicKey, run, vault: vaultPda(run), session, bag })
          .instruction(),
        await this.program.methods
          .delegateBag(0)
          .accountsPartial({ payer: wallet.publicKey, run, bag })
          .remainingAccounts([{ pubkey: this.net.validator, isSigner: false, isWritable: false }])
          .instruction(),
      );
    }
    await this.sendBase(wallet, ixs);
    return { run, runId };
  }

  /** join_run + delegate_bag in one transaction. Returns the seat. */
  async joinRun(wallet: WalletSigner, run: PublicKey, session: PublicKey): Promise<number> {
    const info = await this.base.getAccountInfo(run);
    if (!info) throw new Error("run not found");
    const seat = this.decode(info.data).playerCount;
    const bag = bagPda(run, seat);
    const join = await this.program.methods
      .joinRun(session)
      .accountsPartial({ player: wallet.publicKey, run, vault: vaultPda(run), session, bag })
      .instruction();
    const delegate = await this.program.methods
      .delegateBag(seat)
      .accountsPartial({ payer: wallet.publicKey, run, bag })
      .remainingAccounts([{ pubkey: this.net.validator, isSigner: false, isWritable: false }])
      .instruction();
    await this.sendBase(wallet, [join, delegate]);
    return seat;
  }

  /** Seats an AI bot: the host funds a fresh bot wallet and the bot joins, all in one transaction
   *  (one wallet approval). The bot is then a normal player: it stakes, has a private bag, and can
   *  be killed and looted. Returns the bot's seat. */
  async joinBot(host: WalletSigner, run: PublicKey, bot: Keypair, botSession: PublicKey): Promise<number> {
    const info = await this.base.getAccountInfo(run);
    if (!info) throw new Error("run not found");
    const s = this.decode(info.data);
    const seat = s.playerCount;
    const bag = bagPda(run, seat);
    // Stake + the session top-up + bag & permission rent + fees, with margin. Leftovers are swept back.
    const fund = Number(s.entryLamports.toString()) + 12_000_000;
    const transfer = SystemProgram.transfer({ fromPubkey: host.publicKey, toPubkey: bot.publicKey, lamports: fund });
    const join = await this.program.methods
      .joinRun(botSession)
      .accountsPartial({ player: bot.publicKey, run, vault: vaultPda(run), session: botSession, bag })
      .instruction();
    const delegate = await this.program.methods
      .delegateBag(seat)
      .accountsPartial({ payer: bot.publicKey, run, bag })
      .remainingAccounts([{ pubkey: this.net.validator, isSigner: false, isWritable: false }])
      .instruction();
    await this.send(this.base, [transfer, join, delegate], host.publicKey, async (tx) => {
      tx.partialSign(bot);
      return host.signTransaction(tx);
    });
    return seat;
  }

  /** Sends everything left in a keypair's base account (minus the fee) to `to`. */
  async sweep(from: Keypair, to: PublicKey): Promise<number> {
    const bal = await this.base.getBalance(from.publicKey);
    const FEE = 5000;
    if (bal <= FEE) return 0;
    const ix = SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: bal - FEE });
    await this.send(this.base, [ix], from.publicKey, async (t) => {
      t.sign(from);
      return t;
    });
    return bal - FEE;
  }

  /** start_run + delegate_run in one transaction, signed by the host. */
  async startRun(wallet: WalletSigner, run: PublicKey, runId: BN) {
    const start = await this.program.methods.startRun().accountsPartial({ authority: wallet.publicKey, run }).instruction();
    const delegate = await this.program.methods
      .delegateRun(runId)
      .accountsPartial({ authority: wallet.publicKey, run })
      .remainingAccounts([{ pubkey: this.net.validator, isSigner: false, isWritable: false }])
      .instruction();
    return this.sendBase(wallet, [start, delegate]);
  }

  async settleRun(wallet: WalletSigner, run: PublicKey, state: RunState) {
    const wallets = state.players.slice(0, state.playerCount).map((p) => ({ pubkey: p.wallet, isSigner: false, isWritable: true }));
    const ix = await this.program.methods
      .settleRun()
      .accountsPartial({ caller: wallet.publicKey, run, vault: vaultPda(run) })
      .remainingAccounts([...wallets, ...this.bagMetas(run, state.playerCount, false)])
      .instruction();
    return this.sendBase(wallet, [ix]);
  }

  /** The transaction that paid out (settle) or refunded (cancel) a run: the vault's latest
   *  successful one. Null if the vault hasn't paid anything yet or the lookup fails. */
  async payoutSignature(run: PublicKey): Promise<string | null> {
    const sigs = await this.base.getSignaturesForAddress(vaultPda(run), { limit: 5 }).catch(() => []);
    return sigs.find((s) => !s.err)?.signature ?? null;
  }

  /** Cancels a lobby that never started and refunds every seated wallet its stake. */
  async cancelRun(wallet: WalletSigner, run: PublicKey, state: RunState) {
    const wallets = state.players.slice(0, state.playerCount).map((p) => ({ pubkey: p.wallet, isSigner: false, isWritable: true }));
    const ix = await this.program.methods
      .cancelRun()
      .accountsPartial({ caller: wallet.publicKey, run, vault: vaultPda(run) })
      .remainingAccounts(wallets)
      .instruction();
    return this.sendBase(wallet, [ix]);
  }

  /** Sends a session key's base-layer balance (minus the fee) back to the player's wallet. */
  async sweepSession(session: Keypair, to: PublicKey): Promise<string | null> {
    const bal = await this.base.getBalance(session.publicKey);
    const FEE = 5000;
    if (bal <= FEE) return null;
    const ix = SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: to, lamports: bal - FEE });
    return this.send(this.base, [ix], session.publicKey, async (t) => {
      t.sign(session);
      return t;
    });
  }

  // ---------- ER: setup ----------

  /** Makes your bag private on the TEE (idempotent). Retries until the ER has the bag. */
  async ensureBagPermission(session: Keypair, run: PublicKey, seat: number) {
    const bag = bagPda(run, seat);
    const ix = await this.program.methods
      .initBagPermission(seat)
      .accountsPartial({
        signer: session.publicKey,
        run,
        bag,
        permission: permissionPdaFromAccount(bag),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .instruction();
    return this.retryEr(() => this.sendEr(session, [ix]), "bag permission");
  }

  /** Gives the run its public permission on the TEE (idempotent). Retries until the ER has it. */
  async ensureRunPermission(signer: Keypair, run: PublicKey) {
    const ix = await this.program.methods
      .initRunPermission()
      .accountsPartial({
        signer: signer.publicKey,
        run,
        permission: permissionPdaFromAccount(run),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .instruction();
    return this.retryEr(() => this.sendEr(signer, [ix]), "run permission");
  }

  // ---------- ER: gameplay ----------

  async move(session: Keypair, run: PublicKey, players: number, dir: number, confirm = true) {
    const ix = await this.program.methods
      .movePlayer(dir)
      .accountsPartial({ signer: session.publicKey, run })
      .remainingAccounts(this.bagMetas(run, players))
      .instruction();
    return this.sendEr(session, [ix], confirm);
  }

  async attack(session: Keypair, run: PublicKey, players: number, dir: number, confirm = true) {
    const ix = await this.program.methods
      .attack(dir)
      .accountsPartial({ signer: session.publicKey, run })
      .remainingAccounts(this.bagMetas(run, players))
      .instruction();
    return this.sendEr(session, [ix], confirm);
  }

  /** Hands the Vault Guardians to the rollup's scheduler: a MagicBlock crank ticks them on-chain
   *  until the timer ends, with no client involved. */
  async startGuardians(session: Keypair, run: PublicKey, players: number) {
    const ix = await this.program.methods
      .startGuardians()
      .accountsPartial({ payer: session.publicKey, run, magicProgram: MAGIC_PROGRAM_ID })
      .remainingAccounts(this.bagMetas(run, players))
      .instruction();
    return this.sendEr(session, [ix], true);
  }

  /** Advances the Vault Guardians one step (rate-limited on-chain, so extra calls are no-ops). */
  async tickMonsters(session: Keypair, run: PublicKey, players: number) {
    const ix = await this.program.methods
      .tickMonsters()
      .accountsPartial({ signer: session.publicKey, run })
      .remainingAccounts(this.bagMetas(run, players))
      .instruction();
    return this.sendEr(session, [ix], true);
  }

  /** Starts channeling an extraction (stand still ~2s, then `finishExtract`). */
  async startExtract(session: Keypair, run: PublicKey) {
    const ix = await this.program.methods.startExtract().accountsPartial({ signer: session.publicKey, run }).instruction();
    return this.sendEr(session, [ix]);
  }

  async finishExtract(session: Keypair, run: PublicKey) {
    const ix = await this.program.methods.extract().accountsPartial({ signer: session.publicKey, run }).instruction();
    return this.sendEr(session, [ix]);
  }

  async openChest(session: Keypair, run: PublicKey, seat: number, chest: number) {
    const ix = await this.program.methods
      .openChest(chest)
      .accountsPartial({
        payer: session.publicKey,
        run,
        bag: bagPda(run, seat),
        oracleQueue: EPHEMERAL_QUEUE,
        programIdentity: PROGRAM_IDENTITY,
        vrfProgram: VRF_PROGRAM_ID,
        slotHashes: SLOT_HASHES,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return this.sendEr(session, [ix]);
  }

  /** Any session key (or the host's) can end a finished run; it commits run + bags to base. */
  async endRun(session: Keypair, run: PublicKey, players: number) {
    const ix = await this.program.methods
      .endRun()
      .accountsPartial({ payer: session.publicKey, run, magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT_ID })
      .remainingAccounts(this.bagMetas(run, players))
      .instruction();
    return this.sendEr(session, [ix]);
  }

  // ---------- waiting ----------

  /** Waits until the run (and, given `players`, every bag) is back on base with the given status. */
  async waitForBase(run: PublicKey, status: number, timeoutMs = 30_000, players = 0): Promise<RunState> {
    const t0 = Date.now();
    for (;;) {
      const info = await this.base.getAccountInfo(run);
      if (info && info.owner.equals(PROGRAM_ID)) {
        const s = this.decode(info.data);
        if (s.status === status) {
          const bags = players ? await this.base.getMultipleAccountsInfo(this.bags(run, players)) : [];
          if (bags.every((b) => b && b.owner.equals(PROGRAM_ID))) return s;
        }
      }
      if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for the run to land on base");
      await sleep(500);
    }
  }

  /** Waits until the ER can see the delegated run as live. */
  async waitForEr(run: PublicKey, timeoutMs = 45_000): Promise<RunState> {
    const t0 = Date.now();
    for (;;) {
      const info = await (await this.er()).getAccountInfo(run).catch(() => null);
      if (info) {
        try {
          const s = this.decode(info.data);
          if (s.status === Status.Live) return s;
        } catch {
          /* not yet */
        }
      }
      if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for the ER to pick up the run");
      await sleep(400);
    }
  }
}
