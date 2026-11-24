// End-to-end smoke test over real RPC: base layer + (Private) Ephemeral Rollup.
//   NET=devnet npx tsx scripts/smoke.ts      (local stack: NET=local, but commits/VRF don't work there)
// Plays a PvP run with a VRF chest, checks bag privacy, the attack cooldown, and the exact payout.
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { Chain, ChestState, Dir, NETS, Net, Status, TIER_NAMES, keypairSigner } from "../src/chain";

const net = (process.env.NET ?? "devnet") as Net;
const chain = new Chain(NETS[net]);
const ENTRY = net === "local" ? LAMPORTS_PER_SOL / 10 : LAMPORTS_PER_SOL / 100;
const FUND = net === "local" ? 1 : 0.03;
const { Up, Right, Down, Left } = Dir;

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
    const bal = await chain.base.getBalance(kp.publicKey);
    if (bal <= 5000) continue;
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: cliWallet.publicKey, lamports: bal - 5000 }));
    await sendAndConfirmTransaction(chain.base, tx, [kp]).then(() => (total += bal - 5000)).catch(() => {});
  }
  log(`swept ${(total / LAMPORTS_PER_SOL).toFixed(4)} SOL back to the CLI wallet`);
}

const moveTimes: number[] = [];
async function walk(session: Keypair, run: PublicKey, dirs: number[]) {
  for (const d of dirs) {
    const s = Date.now();
    await chain.move(session, run, 2, d);
    moveTimes.push(Date.now() - s);
  }
}

async function pos(run: PublicKey, seat: number) {
  const p = (await chain.fetchRun(run))!.state.players[seat];
  return `(${p.x},${p.y})`;
}

async function main() {
  log(`net=${net} er=${NETS[net].er} program=${chain.program.programId.toBase58()}`);
  const host = keypairSigner(await funded(FUND));
  const wallets = [await funded(FUND), await funded(FUND)];
  const sessions = [Keypair.generate(), Keypair.generate()];
  temps.push(...sessions);

  const { run, runId } = await chain.createRun(host, ENTRY, 300);
  log("created run", run.toBase58());
  for (let i = 0; i < 2; i++) {
    const seat = await chain.joinRun(keypairSigner(wallets[i]), run, sessions[i].publicKey);
    check(seat === i, `seat ${i} joined, bag delegated`);
  }
  for (let i = 0; i < 2; i++) await chain.ensureBagPermission(sessions[i], run, i);
  log("bag permissions created on the ER (private to each session key)");

  await chain.startRun(host, run, runId);
  await chain.ensureRunPermission(sessions[0], run);
  await chain.waitForEr(run);
  log("run delegated, public permission set, live on the ER");

  // ---- privacy ----
  check((await chain.fetchBag(run, 0, sessions[0])) !== null, "seat 0 can read its own bag");
  check((await chain.fetchBag(run, 0, sessions[1])) === null, "seat 1 can NOT read seat 0's bag");
  check((await chain.fetchBag(run, 0)) === null, "an anonymous viewer can NOT read seat 0's bag");
  check((await chain.fetchRun(run)) !== null, "anyone can read the public run");

  // ---- VRF chest on the TEE ----
  await walk(sessions[0], run, [Right]);
  const sent = Date.now();
  await chain.openChest(sessions[0], run, 0, 0);
  let bag0 = null;
  for (let i = 0; i < 60; i++) {
    const s = (await chain.fetchRun(run))!.state;
    if (s.chests[0].state === ChestState.Opened) {
      bag0 = await chain.fetchBag(run, 0, sessions[0]);
      log(`VRF callback landed on the TEE after ${Date.now() - sent}ms: ${TIER_NAMES[bag0!.lastTier]}, bag ${bag0!.points} pts`);
      check(s.chests[0].tier === 0, "chest tier is not public on the run");
      break;
    }
    await sleep(250);
  }
  check(bag0 !== null && bag0.points > 0, "chest loot landed in seat 0's private bag");

  // ---- fight with cooldown ----
  await walk(sessions[0], run, [Left, Down, Down, Right, Right, Right]); // (4,3)
  await walk(sessions[1], run, [Up, Up, Left, Left, Left, Left, Left, Left, Up]); // (4,4)
  log(`positions: seat0 ${await pos(run, 0)} seat1 ${await pos(run, 1)}`);
  await chain.attack(sessions[1], run, 2, Up);
  let blocked = false;
  try {
    await chain.attack(sessions[1], run, 2, Up);
  } catch (e) {
    blocked = /6022|1786/.test((e as Error).message); // AttackCooldown = 6022 (0x1786)
  }
  check(blocked, "a second attack inside the cooldown is rejected");
  await sleep(500);
  await chain.attack(sessions[1], run, 2, Up);
  await sleep(500);
  await chain.attack(sessions[1], run, 2, Up);
  let s = (await chain.fetchRun(run))!.state;
  check(!s.players[0].alive && s.dropped[0].present, "3 spaced hits kill; sack dropped");
  check(s.dropped[0].points === 0, "sack contents are not public");
  const victim = await chain.fetchBag(run, 0, sessions[0]);
  check(victim?.dropped === bag0?.points && victim?.points === 0, `victim's loot moved into the sack (${victim?.dropped} pts)`);

  await walk(sessions[1], run, [Up, Right]); // onto the sack, then the exit
  const winnerBag = await chain.fetchBag(run, 1, sessions[1]);
  check(winnerBag?.points === bag0?.points, `killer picked up the sack (${winnerBag?.points} pts)`);
  await chain.extract(sessions[1], run);
  log("seat1 extracted");

  // ---- end + settle ----
  await chain.endRun(sessions[1], run, 2);
  const final = await chain.waitForBase(run, Status.Ended, 90_000, 2);
  log("run + both bags committed back to base");
  const publicBag = await chain.fetchBag(run, 1);
  check(publicBag?.points === winnerBag?.points, "bags are public on base after the run");

  const before = await chain.base.getBalance(wallets[1].publicKey);
  await chain.settleRun(host, run, final);
  const gained = (await chain.base.getBalance(wallets[1].publicKey)) - before;
  check(gained === 2 * ENTRY, `winner paid exactly the pot (${gained / LAMPORTS_PER_SOL} SOL)`);

  const sorted = [...moveTimes].sort((a, b) => a - b);
  log(`ER move send+confirm over ${sorted.length} moves: p50 ${sorted[sorted.length >> 1]}ms, max ${sorted.at(-1)}ms`);
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
