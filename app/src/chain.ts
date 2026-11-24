// Everything that talks to Solana / the Ephemeral Rollup. Shared by the browser game and the
// Node smoke script, so the smoke test exercises exactly the code the game runs.
import { AnchorProvider, Program } from "@anchor-lang/core";
import BN from "bn.js";
import {
  Commitment,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
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
}

export const NETS: Record<Net, NetConfig> = {
  local: {
    base: "http://127.0.0.1:8899",
    baseWs: "ws://127.0.0.1:8900",
    er: "http://127.0.0.1:7799",
    erWs: "ws://127.0.0.1:7800",
    validator: new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"),
    airdrop: true,
  },
  devnet: {
    base: "https://api.devnet.solana.com",
    baseWs: "wss://api.devnet.solana.com",
    er: "https://devnet-as.magicblock.app",
    erWs: "wss://devnet-as.magicblock.app",
    validator: new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"),
    airdrop: false,
  },
};

export const PROGRAM_ID = new PublicKey(idl.address);
export const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
export const EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
export const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");

export const Dir = { Up: 0, Right: 1, Down: 2, Left: 3 } as const;
export const Status = { Lobby: 0, Live: 1, Ended: 2 } as const;
export const ChestState = { Closed: 0, Opening: 1, Opened: 2 } as const;

/** Mirrors programs/extraction_dungeon/src/map.rs. */
export const MAP = {
  W: 12,
  H: 9,
  LAYOUT: [
    "############",
    "#..........#",
    "#.##....##.#",
    "#..........#",
    "#....##....#",
    "#..........#",
    "#.##....##.#",
    "#..........#",
    "############",
  ],
  CHESTS: [[3, 1], [8, 1], [1, 4], [10, 4], [3, 7], [8, 7]] as [number, number][],
  EXTRACTS: [[5, 3], [6, 5]] as [number, number][],
};

export interface PlayerSlot {
  wallet: PublicKey;
  signer: PublicKey;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  extracted: boolean;
  bag: number;
  kills: number;
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
}

/** Signs transactions for the player's real wallet (Phantom, or a local dev keypair). */
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
const PROGRAM_IDENTITY = PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID)[0];

export class Chain {
  readonly base: Connection;
  readonly er: Connection;
  readonly program: Program<ExtractionDungeon>;

  constructor(readonly net: NetConfig, commitment: Commitment = "confirmed") {
    this.base = new Connection(net.base, { commitment, wsEndpoint: net.baseWs });
    this.er = new Connection(net.er, { commitment, wsEndpoint: net.erWs });
    // Instructions only: we sign and send ourselves, so the provider wallet is never used.
    const dummy = {
      publicKey: PublicKey.default,
      signTransaction: async (t: any) => t,
      signAllTransactions: async (t: any) => t,
    };
    this.program = new Program<ExtractionDungeon>(idl as any, new AnchorProvider(this.base, dummy as any, {}));
  }

  // ---------- reading ----------

  decode(data: Buffer): RunState {
    return this.program.coder.accounts.decode("run", data) as RunState;
  }

  /** Reads the run from wherever it currently lives: the ER while delegated, else base. */
  async fetchRun(run: PublicKey): Promise<{ state: RunState; onEr: boolean } | null> {
    const baseInfo = await this.base.getAccountInfo(run);
    if (!baseInfo) return null;
    const delegated = !baseInfo.owner.equals(PROGRAM_ID);
    if (delegated) {
      const erInfo = await this.er.getAccountInfo(run);
      if (erInfo) return { state: this.decode(erInfo.data), onEr: true };
    }
    if (!baseInfo.owner.equals(PROGRAM_ID)) return null; // delegated but ER hasn't cloned it yet
    return { state: this.decode(baseInfo.data), onEr: false };
  }

  /** Live updates from the ER (during play) or base (lobby / after commit).
   *  On base, `onDelegated` fires when the account is handed to the delegation program,
   *  i.e. the run just went live on the ER. */
  subscribe(conn: "er" | "base", run: PublicKey, cb: (s: RunState) => void, onDelegated?: () => void): () => void {
    const c = conn === "er" ? this.er : this.base;
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
    return () => void c.removeAccountChangeListener(id);
  }

  // ---------- sending ----------

  private async send(
    conn: Connection,
    ixs: TransactionInstruction[],
    feePayer: PublicKey,
    sign: (tx: Transaction) => Promise<Transaction>,
    opts: { skipPreflight?: boolean; confirm?: boolean } = {},
  ): Promise<string> {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = feePayer;
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    const signed = await sign(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: opts.skipPreflight ?? false });
    if (opts.confirm !== false) {
      const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
      if (res.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
    }
    return sig;
  }

  private sendBase(wallet: WalletSigner, ixs: TransactionInstruction[]) {
    return this.send(this.base, ixs, wallet.publicKey, (t) => wallet.signTransaction(t));
  }

  private erNonce = 0;
  private erHash: { blockhash: string; lastValidBlockHeight: number; at: number } | null = null;
  private erHashFetch: Promise<unknown> | null = null;
  /** Called when a fire-and-forget ER action later turns out to have failed. */
  onActionError: ((err: string) => void) | null = null;

  /** ER blockhash, refreshed in the background so actions don't pay a round trip for it.
   *  ER slots are ~50ms and blockhashes stay valid for seconds, so a 1s-old hash is fine. */
  private async erBlockhash() {
    const stale = !this.erHash || Date.now() - this.erHash.at > 1000;
    if (stale && !this.erHashFetch) {
      this.erHashFetch = this.er
        .getLatestBlockhash()
        .then((h) => (this.erHash = { ...h, at: Date.now() }))
        .finally(() => (this.erHashFetch = null));
    }
    if (!this.erHash) await this.erHashFetch;
    return this.erHash!;
  }

  /** ER transactions are signed and fee-paid by the session key alone: no wallet popups.
   *  ER blockhashes change slowly, so two identical moves (e.g. Down, Down) would serialize to
   *  the same bytes and the second would be dropped as "already processed". A rotating compute
   *  unit limit makes every transaction unique without touching the program.
   *  With `confirm = false` this resolves as soon as the ER has the transaction; confirmation
   *  runs in the background and failures are reported via `onActionError`. */
  private async sendEr(session: Keypair, ixs: TransactionInstruction[], confirm = true) {
    const nonce = ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 + (this.erNonce++ % 50_000) });
    const { blockhash, lastValidBlockHeight } = await this.erBlockhash();
    const tx = new Transaction().add(nonce, ...ixs);
    tx.feePayer = session.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(session);
    const sig = await this.er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const confirmed = this.er.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "processed").then((r) => {
      if (r.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(r.value.err)}`);
    });
    if (confirm) await confirmed;
    else confirmed.catch((e) => this.onActionError?.((e as Error).message));
    return sig;
  }

  // ---------- base layer ----------

  async createRun(wallet: WalletSigner, entryLamports: number, durationSecs: number) {
    const runId = new BN(Date.now());
    const run = runPda(wallet.publicKey, runId);
    const ix = await this.program.methods
      .createRun(runId, new BN(entryLamports), durationSecs)
      .accountsPartial({ authority: wallet.publicKey, run, vault: vaultPda(run) })
      .instruction();
    await this.sendBase(wallet, [ix]);
    return { run, runId };
  }

  async joinRun(wallet: WalletSigner, run: PublicKey, session: PublicKey) {
    const ix = await this.program.methods
      .joinRun(session)
      .accountsPartial({ player: wallet.publicKey, run, vault: vaultPda(run), session })
      .instruction();
    return this.sendBase(wallet, [ix]);
  }

  /** start_run + delegate_run in one transaction, signed by the host. */
  async startRun(wallet: WalletSigner, run: PublicKey, runId: BN) {
    const start = await this.program.methods
      .startRun()
      .accountsPartial({ authority: wallet.publicKey, run })
      .instruction();
    const delegate = await this.program.methods
      .delegateRun(runId)
      .accountsPartial({ authority: wallet.publicKey, run })
      .remainingAccounts([{ pubkey: this.net.validator, isSigner: false, isWritable: false }])
      .instruction();
    return this.sendBase(wallet, [start, delegate]);
  }

  async settleRun(wallet: WalletSigner, run: PublicKey, state: RunState) {
    const ix = await this.program.methods
      .settleRun()
      .accountsPartial({ caller: wallet.publicKey, run, vault: vaultPda(run), authority: state.authority })
      .remainingAccounts(
        state.players
          .slice(0, state.playerCount)
          .map((p) => ({ pubkey: p.wallet, isSigner: false, isWritable: true })),
      )
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

  // ---------- ER ----------

  async move(session: Keypair, run: PublicKey, dir: number, confirm = true) {
    const ix = await this.program.methods.movePlayer(dir).accountsPartial({ signer: session.publicKey, run }).instruction();
    return this.sendEr(session, [ix], confirm);
  }

  async attack(session: Keypair, run: PublicKey, dir: number, confirm = true) {
    const ix = await this.program.methods.attack(dir).accountsPartial({ signer: session.publicKey, run }).instruction();
    return this.sendEr(session, [ix], confirm);
  }

  async extract(session: Keypair, run: PublicKey) {
    const ix = await this.program.methods.extract().accountsPartial({ signer: session.publicKey, run }).instruction();
    return this.sendEr(session, [ix]);
  }

  async openChest(session: Keypair, run: PublicKey, chest: number) {
    const ix = await this.program.methods
      .openChest(chest)
      .accountsPartial({
        payer: session.publicKey,
        run,
        oracleQueue: EPHEMERAL_QUEUE,
        programIdentity: PROGRAM_IDENTITY,
        vrfProgram: VRF_PROGRAM_ID,
        slotHashes: SLOT_HASHES,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return this.sendEr(session, [ix]);
  }

  /** Any session key (or the host's) can end a finished run; it commits back to base. */
  async endRun(session: Keypair, run: PublicKey) {
    const ix = await this.program.methods
      .endRun()
      .accountsPartial({ payer: session.publicKey, run, magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT_ID })
      .instruction();
    return this.sendEr(session, [ix]);
  }

  /** Waits until the run is back on base (owner = our program) with the given status. */
  async waitForBase(run: PublicKey, status: number, timeoutMs = 30_000): Promise<RunState> {
    const t0 = Date.now();
    for (;;) {
      const info = await this.base.getAccountInfo(run);
      if (info && info.owner.equals(PROGRAM_ID)) {
        const s = this.decode(info.data);
        if (s.status === status) return s;
      }
      if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for the run to land on base");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** Waits until the ER can see the delegated run. */
  async waitForEr(run: PublicKey, timeoutMs = 30_000): Promise<RunState> {
    const t0 = Date.now();
    for (;;) {
      const info = await this.er.getAccountInfo(run).catch(() => null);
      if (info) {
        try {
          const s = this.decode(info.data);
          if (s.status === Status.Live) return s;
        } catch {
          /* not yet */
        }
      }
      if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for the ER to pick up the run");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
