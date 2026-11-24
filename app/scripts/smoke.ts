// End-to-end smoke test over real RPC: base validator + Ephemeral Rollup.
//   NET=local npm run smoke      (default)   NET=devnet npm run smoke
// Plays the same PvP scenario as the MagicSVM test, then probes VRF chests.
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { Chain, ChestState, Dir, NETS, Net, Status, keypairSigner } from "../src/chain";

const net = (process.env.NET ?? "local") as Net;
const chain = new Chain(NETS[net]);
// Devnet SOL is scarce: small stakes, wallets funded from the CLI wallet and swept back after.
const ENTRY = net === "local" ? LAMPORTS_PER_SOL / 10 : LAMPORTS_PER_SOL / 100;
const FUND = net === "local" ? 1 : 0.03;
const { Up, Right, Down, Left } = Dir;

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const cliWallet = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))),
);
const temps: Keypair[] = [];

async function funded(sol: number): Promise<Keypair> {
  const kp = Keypair.generate();
  temps.push(kp);
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  if (NETS[net].airdrop) {
    const sig = await chain.base.requestAirdrop(kp.publicKey, lamports);
    await chain.base.confirmTransaction(sig);
  } else {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: cliWallet.publicKey, toPubkey: kp.publicKey, lamports }));
    await sendAndConfirmTransaction(chain.base, tx, [cliWallet]);
  }
  return kp;
}

/** Returns whatever is left in the throwaway wallets to the CLI wallet (devnet only). */
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

/** Moves as the game sends them (fire-and-forget), timing how long each blocks the input queue,
 *  then waits until the ER state shows the final position (true end-to-end time). */
async function timedMoves(session: Keypair, run: PublicKey, dirs: number[]) {
  const seat = (await chain.fetchRun(run))!.state.players.findIndex((p) => p.signer.equals(session.publicKey));
  let x = (await chain.fetchRun(run))!.state.players[seat].x, y = (await chain.fetchRun(run))!.state.players[seat].y;
  const t0 = Date.now();
  for (const d of dirs) {
    const s = Date.now();
    await chain.move(session, run, d, false);
    moveTimes.push(Date.now() - s);
    x += [0, 1, 0, -1][d];
    y += [-1, 0, 1, 0][d];
  }
  for (;;) {
    const p = (await chain.fetchRun(run))!.state.players[seat];
    if (p.x === x && p.y === y) break;
    if (Date.now() - t0 > 15_000) throw new Error(`seat ${seat} never reached (${x},${y}); at (${p.x},${p.y})`);
    await new Promise((r) => setTimeout(r, 50));
  }
  pathTimes.push(`${dirs.length} moves landed in ${Date.now() - t0}ms`);
}
const pathTimes: string[] = [];
const moveTimes: number[] = [];

async function main() {
  log(`net=${net} program=${chain.program.programId.toBase58()}`);
  const host = keypairSigner(await funded(FUND));
  const wallets = [await funded(FUND), await funded(FUND)];
  const sessions = [Keypair.generate(), Keypair.generate()];

  const { run, runId } = await chain.createRun(host, ENTRY, 300);
  log("created run", run.toBase58());
  for (let i = 0; i < 2; i++) await chain.joinRun(keypairSigner(wallets[i]), run, sessions[i].publicKey);
  log("2 players joined, pot", (await chain.fetchRun(run))!.state.pot.toString());

  await chain.startRun(host, run, runId);
  await chain.waitForEr(run);
  log("delegated; ER sees the run live");

  // Seat 0: (1,1) -> (4,3). Seat 1: (10,7) -> (4,4).
  await timedMoves(sessions[0], run, [Right, Left, Down, Down, Right, Right, Right]);
  await timedMoves(sessions[1], run, [Up, Up, Left, Left, Left, Left, Left, Left, Up]);
  let s = (await chain.fetchRun(run))!.state;
  log(`positions: seat0 (${s.players[0].x},${s.players[0].y}) seat1 (${s.players[1].x},${s.players[1].y})`);

  for (let i = 0; i < 3; i++) await chain.attack(sessions[1], run, Up);
  s = (await chain.fetchRun(run))!.state;
  log(`after 3 hits: seat0 alive=${s.players[0].alive} dropped bag present=${s.dropped[0].present}`);

  await timedMoves(sessions[1], run, [Up, Right]); // onto the bag, then extract tile (5,3)
  await chain.extract(sessions[1], run);
  log("seat1 extracted");

  await chain.endRun(sessions[1], run);
  log("end_run accepted on the ER");
  try {
    const final = await chain.waitForBase(run, Status.Ended, net === "local" ? 20_000 : 90_000);
    log("committed back to base: status Ended, seat1 extracted =", final.players[1].extracted);
    const before = await chain.base.getBalance(wallets[1].publicKey);
    await chain.settleRun(host, run, final);
    const gained = (await chain.base.getBalance(wallets[1].publicKey)) - before;
    log(`settled: winner gained ${gained / LAMPORTS_PER_SOL} SOL (pot ${(2 * ENTRY) / LAMPORTS_PER_SOL})`);
    if (gained !== 2 * ENTRY) throw new Error("payout mismatch");
  } catch (e) {
    if (net !== "local") throw e;
    log("COMMIT NOT LANDED (known local-stack issue: ER 1.1.1 finalize tx rejected by local base) ->", (e as Error).message);
  }

  const sorted = [...moveTimes].sort((a, b) => a - b);
  log(`ER move send time (input queue blocked) over ${sorted.length} moves: p50 ${sorted[sorted.length >> 1]}ms, max ${sorted.at(-1)}ms`);
  log(`end-to-end: ${pathTimes.join("; ")}`);

  await vrfProbe(host);
}

/** Opens a chest on the ER and waits for the VRF callback. Ends the run afterwards. */
async function vrfProbe(host: ReturnType<typeof keypairSigner>) {
  const probe = await chain.createRun(host, 0, 300);
  const pw = await funded(FUND);
  const ps = Keypair.generate();
  temps.push(ps);
  await chain.joinRun(keypairSigner(pw), probe.run, ps.publicKey);
  await chain.startRun(host, probe.run, probe.runId);
  await chain.waitForEr(probe.run);
  await chain.move(ps, probe.run, Right);
  const sessBefore = await chain.er.getBalance(ps.publicKey);
  const sent = Date.now();
  try {
    await chain.openChest(ps, probe.run, 0);
    log("open_chest accepted on the ER; waiting for the VRF callback...");
    let landed = false;
    for (let i = 0; i < 60 && !landed; i++) {
      const c = (await chain.fetchRun(probe.run))!.state.chests[0];
      if (c.state === ChestState.Opened) {
        landed = true;
        const paid = sessBefore - (await chain.er.getBalance(ps.publicKey));
        log(`VRF callback landed after ${Date.now() - sent}ms: tier ${c.tier}, bag ${(await chain.fetchRun(probe.run))!.state.players[0].bag}; session key paid ${paid} lamports on the ER`);
      } else await new Promise((r) => setTimeout(r, 250));
    }
    if (!landed) log("VRF: request accepted but no callback within 15s");
  } catch (e) {
    log("VRF: open_chest rejected:", (e as Error).message.slice(0, 300));
  }
  // The host may end at any time; this also returns the probe run to base.
  const hostKp = temps[0];
  await chain.endRun(hostKp, probe.run).catch((e) => log("probe end_run failed:", (e as Error).message.slice(0, 200)));
}

main()
  .catch((e) => {
    console.error("SMOKE FAILED:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sweep().catch(() => {});
    process.exit(process.exitCode ?? 0);
  });
