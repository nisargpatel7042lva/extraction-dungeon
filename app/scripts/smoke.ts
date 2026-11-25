// End-to-end smoke test over real RPC: base layer + Private Ephemeral Rollup (devnet-tee).
//   NET=devnet npx tsx scripts/smoke.ts
// Plays a PvP run: a VRF chest, the Vault, bag privacy, the attack cooldown, locked exits, a
// channeled extraction, and the exact payout.
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { Chain, ChestState, EXTRACT_CHANNEL_MS, MAP, NETS, Net, Status, TIER_NAMES, chainClock, exitsOpenAt, keypairSigner } from "../src/chain";

const net = (process.env.NET ?? "devnet") as Net;
const chain = new Chain(NETS[net]);
const ENTRY = net === "local" ? LAMPORTS_PER_SOL / 10 : LAMPORTS_PER_SOL / 100;
const FUND = net === "local" ? 1 : 0.03;
const DURATION = 80; // exits unlock after 20s

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string) => {
  log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const cliWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))));
const temps: Keypair[] = [];

async function funded(sol: number): Promise<Keypair> {
  const kp = Keypair.generate();
  temps.push(kp);
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  if (NETS[net].airdrop) {
    await chain.base.confirmTransaction(await chain.base.requestAirdrop(kp.publicKey, lamports));
  } else {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: cliWallet.publicKey, toPubkey: kp.publicKey, lamports }));
    await sendAndConfirmTransaction(chain.base, tx, [cliWallet]);
  }
  return kp;
}

async function sweep() {
  if (NETS[net].airdrop) return;
  let total = 0;
  for (const kp of temps) {
    const bal = await chain.base.getBalance(kp.publicKey).catch(() => 0);
    if (bal <= 5000) continue;
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: cliWallet.publicKey, lamports: bal - 5000 }));
    await sendAndConfirmTransaction(chain.base, tx, [kp]).then(() => (total += bal - 5000)).catch(() => {});
  }
  log(`swept ${(total / LAMPORTS_PER_SOL).toFixed(4)} SOL back to the CLI wallet`);
}

// ---- BFS routing over the real map ----
type P = [number, number];
const isChest = (x: number, y: number) => MAP.CHESTS.some(([cx, cy]) => cx === x && cy === y);
const open = (x: number, y: number) => MAP.LAYOUT[y]?.[x] === "." && !isChest(x, y);
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
function route(from: P, goals: P[], blocked: P[] = []): number[] {
  const key = ([x, y]: P) => `${x},${y}`;
  const prev = new Map<string, [P, number]>([[key(from), [from, -1]]]);
  const q: P[] = [from];
  while (q.length) {
    const cur = q.shift()!;
    if (goals.some((g) => g[0] === cur[0] && g[1] === cur[1])) {
      const dirs: number[] = [];
      let k = key(cur);
      while (prev.get(k)![1] !== -1) {
        const [p, d] = prev.get(k)!;
        dirs.push(d);
        k = key(p);
      }
      return dirs.reverse();
    }
    for (let d = 0; d < 4; d++) {
      const n: P = [cur[0] + DX[d], cur[1] + DY[d]];
      if (!open(...n) || blocked.some((b) => b[0] === n[0] && b[1] === n[1]) || prev.has(key(n))) continue;
      prev.set(key(n), [cur, d]);
      q.push(n);
    }
  }
  throw new Error(`no route from ${from} to ${goals}`);
}

async function here(run: PublicKey, seat: number): Promise<P> {
  const p = (await chain.fetchRun(run))!.state.players[seat];
  return [p.x, p.y];
}
async function others(run: PublicKey, seat: number): Promise<P[]> {
  const s = (await chain.fetchRun(run))!.state;
  return s.players.slice(0, s.playerCount).filter((p, i) => i !== seat && p.alive && !p.extracted).map((p) => [p.x, p.y] as P);
}
async function walkTo(session: Keypair, run: PublicKey, seat: number, goals: P[]) {
  for (const d of route(await here(run, seat), goals, await others(run, seat))) await chain.move(session, run, 2, d);
}
async function walkToChest(session: Keypair, run: PublicKey, seat: number, chest: number): Promise<number> {
  const [cx, cy] = MAP.CHESTS[chest];
  const sides = [0, 1, 2, 3].map((d) => [[cx - DX[d], cy - DY[d]] as P, d] as const).filter(([t]) => open(...t));
  await walkTo(session, run, seat, sides.map(([t]) => t));
  const at = await here(run, seat);
  return sides.find(([t]) => t[0] === at[0] && t[1] === at[1])![1];
}
async function waitChest(run: PublicKey, chest: number) {
  for (let i = 0; i < 80; i++) {
    if ((await chain.fetchRun(run))!.state.chests[chest].state === ChestState.Opened) return true;
    await sleep(250);
  }
  return false;
}

async function main() {
  log(`net=${net} er=${NETS[net].er} base=${NETS[net].base}`);
  const host = keypairSigner(await funded(FUND));
  const wallets = [await funded(FUND), await funded(FUND)];
  const sessions = [Keypair.generate(), Keypair.generate()];
  temps.push(...sessions);

  const { run, runId } = await chain.createRun(host, ENTRY, DURATION, { layout: 0 }); // the scripted paths below are for map 0
  log("created run", run.toBase58());
  for (let i = 0; i < 2; i++) await chain.joinRun(keypairSigner(wallets[i]), run, sessions[i].publicKey);
  for (let i = 0; i < 2; i++) await chain.ensureBagPermission(sessions[i], run, i);
  await chain.startRun(host, run, runId);
  await chain.ensureRunPermission(sessions[0], run);
  const live = await chain.waitForEr(run);
  const skew = await chain.syncClock();
  log(`run live on the TEE (rollup clock skew ${skew.toFixed(1)}s vs this machine)`);

  check((await chain.fetchBag(run, 0, sessions[0])) !== null, "seat 0 can read its own bag");
  check((await chain.fetchBag(run, 0, sessions[1])) === null, "seat 1 can NOT read seat 0's bag");

  // Seat 0: nearest chest, then the Vault.
  await walkToChest(sessions[0], run, 0, 0);
  await chain.openChest(sessions[0], run, 0, 0);
  check(await waitChest(run, 0), "chest 0 opened by VRF on the TEE");
  const vaultDir = await walkToChest(sessions[0], run, 0, MAP.VAULT);
  void vaultDir;
  await chain.openChest(sessions[0], run, 0, MAP.VAULT);
  check(await waitChest(run, MAP.VAULT), "the Vault opened");
  const bag0 = await chain.fetchBag(run, 0, sessions[0]);
  log(`seat 0 bag: ${bag0?.points} pts, vault rolled ${TIER_NAMES[bag0!.lastTier]}`);
  check(bag0!.lastTier >= 2, "the Vault rolled rare or legendary");

  // Locked exits.
  const exitsAt = exitsOpenAt(live);
  await walkTo(sessions[1], run, 1, [MAP.EXTRACTS[3] as P]);
  if (chainClock.now() < exitsAt - 2) {
    let locked = false;
    try {
      await chain.startExtract(sessions[1], run);
    } catch (e) {
      locked = /6025|0x1789/.test((e as Error).message);
    }
    check(locked, "exits are locked early in the run");
  } else log("(exits already open: skipped the locked check)");

  // Fight: seat 1 hunts seat 0 next to the Vault.
  const target = await here(run, 0);
  await walkTo(sessions[1], run, 1, [[target[0] - 1, target[1]], [target[0] + 1, target[1]], [target[0], target[1] - 1], [target[0], target[1] + 1]].filter((t) => open(...(t as P))) as P[]);
  const me1 = await here(run, 1);
  const dir = [0, 1, 2, 3].find((d) => me1[0] + DX[d] === target[0] && me1[1] + DY[d] === target[1])!;
  await chain.attack(sessions[1], run, 2, dir);
  let blocked = false;
  try {
    await chain.attack(sessions[1], run, 2, dir);
  } catch (e) {
    blocked = /6022|0x1786/.test((e as Error).message);
  }
  check(blocked, "attack cooldown enforced");
  await sleep(500);
  await chain.attack(sessions[1], run, 2, dir);
  await sleep(500);
  await chain.attack(sessions[1], run, 2, dir);
  let s = (await chain.fetchRun(run))!.state;
  check(!s.players[0].alive && s.dropped[0].present && s.dropped[0].points === 0, "kill drops a sack with hidden contents");
  await chain.move(sessions[1], run, 2, dir); // onto the sack
  check((await chain.fetchBag(run, 1, sessions[1]))?.points === bag0?.points, "killer picked up the whole bag");

  // Channeled extraction.
  await walkTo(sessions[1], run, 1, [MAP.EXTRACTS[0] as P]);
  const wait = (exitsAt - chainClock.now()) * 1000;
  if (wait > 0) {
    log(`waiting ${Math.ceil(wait / 1000)}s (chain time) for exits to unlock`);
    await sleep(wait + 500);
  }
  for (let i = 0; ; i++) {
    try {
      await chain.startExtract(sessions[1], run);
      break;
    } catch (e) {
      if (!/6025|0x1789/.test((e as Error).message) || i >= 6) throw e;
      await sleep(700); // the rollup clock ticks in whole seconds
    }
  }
  s = (await chain.fetchRun(run))!.state;
  check(s.players[1].extractStartSlot.toString() !== "0", "channel is visible on the public run");
  let early = false;
  try {
    await chain.finishExtract(sessions[1], run);
  } catch (e) {
    early = /6027|0x178b/.test((e as Error).message);
  }
  check(early, "finishing immediately is rejected (still channeling)");
  await sleep(EXTRACT_CHANNEL_MS + 300);
  await chain.finishExtract(sessions[1], run);
  check((await chain.fetchRun(run))!.state.players[1].extracted, "extracted after a full channel");

  await chain.endRun(sessions[1], run, 2);
  const final = await chain.waitForBase(run, Status.Ended, 90_000, 2);
  log("run + bags committed back to base");
  const before = await chain.base.getBalance(wallets[1].publicKey);
  await chain.settleRun(host, run, final);
  const gained = (await chain.base.getBalance(wallets[1].publicKey)) - before;
  check(gained === 2 * ENTRY, `winner paid exactly the pot (${gained / LAMPORTS_PER_SOL} SOL)`);
}

main()
  .catch((e) => {
    console.error("SMOKE FAILED:", e);
    failures++;
  })
  .finally(async () => {
    await sweep().catch(() => {});
    log(failures ? `${failures} check(s) FAILED` : "all checks passed");
    process.exit(failures ? 1 : 0);
  });
