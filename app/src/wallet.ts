// The player's real wallet (stakes + payouts) and the per-run session key (in-run actions).
import { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { Chain, WalletSigner } from "./chain";

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

function phantom(): PhantomProvider | null {
  const p = (window as any).phantom?.solana ?? (window as any).solana;
  return p?.isPhantom ? p : null;
}

export function hasPhantom(): boolean {
  return phantom() !== null;
}

export async function connectPhantom(): Promise<WalletSigner> {
  const p = phantom();
  if (!p) throw new Error("Phantom not found");
  const { publicKey } = await p.connect();
  return { publicKey, signTransaction: (tx) => p.signTransaction(tx) };
}

/** A throwaway keypair kept in sessionStorage: one per browser tab, so two tabs are two players.
 *  On the local stack it airdrops itself; on devnet (`?dev=1`, for testing) it must be funded externally. */
export async function devWallet(chain: Chain): Promise<WalletSigner> {
  const key = `ed:devwallet:${chain.net.base}`;
  let kp: Keypair;
  const saved = sessionStorage.getItem(key);
  if (saved) kp = Keypair.fromSecretKey(bs58.decode(saved));
  else {
    kp = Keypair.generate();
    sessionStorage.setItem(key, bs58.encode(kp.secretKey));
  }
  if (chain.net.airdrop && (await chain.base.getBalance(kp.publicKey)) < LAMPORTS_PER_SOL) {
    const sig = await chain.base.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
    await chain.base.confirmTransaction(sig);
  }
  return {
    publicKey: kp.publicKey,
    async signTransaction(tx) {
      tx.partialSign(kp);
      return tx;
    },
  };
}

/** The session key for one run, kept per tab so a reload doesn't lose your character. */
export function sessionKey(run: PublicKey): Keypair {
  const key = `ed:session:${run.toBase58()}`;
  const saved = sessionStorage.getItem(key);
  if (saved) return Keypair.fromSecretKey(bs58.decode(saved));
  const kp = Keypair.generate();
  sessionStorage.setItem(key, bs58.encode(kp.secretKey));
  return kp;
}
