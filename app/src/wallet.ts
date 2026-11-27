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

/** Phone and tablet browsers (Chrome, Safari...) have no wallet extension: a wallet only exists
 *  inside the wallet app's own browser. */
export function isMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
}

/** Universal link that reopens this exact page (invite link included) inside the Phantom app's
 *  browser, where the wallet is injected and Connect works. */
export function walletBrowseLinks(url = location.href) {
  const u = encodeURIComponent(url);
  const ref = encodeURIComponent(location.origin);
  return {
    phantom: `https://phantom.app/ul/browse/${u}?ref=${ref}`,
  };
}

/** Wallet apps' in-app browsers sometimes inject the provider a moment after the page loads. */
export async function waitForPhantom(ms = 2500): Promise<boolean> {
  const t0 = Date.now();
  while (!hasPhantom() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 150));
  return hasPhantom();
}

/** Reconnects Phantom without a popup if this site was approved before; null otherwise. */
export async function reconnectPhantom(): Promise<WalletSigner | null> {
  if (!(await waitForPhantom(1500))) return null;
  const p = phantom()!;
  try {
    const { publicKey } = await (p.connect as (o?: { onlyIfTrusted: boolean }) => Promise<{ publicKey: PublicKey }>)({ onlyIfTrusted: true });
    return { publicKey, signTransaction: (tx) => p.signTransaction(tx) };
  } catch {
    return null;
  }
}

/** Whether this tab already has a dev wallet (it lives in sessionStorage, so it survives reloads). */
export function hasDevWallet(chain: Chain): boolean {
  return !!sessionStorage.getItem(`ed:devwallet:${chain.net.base}`);
}

export async function connectPhantom(): Promise<WalletSigner> {
  if (!(await waitForPhantom())) throw new Error("Phantom not found");
  const p = phantom()!;
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
