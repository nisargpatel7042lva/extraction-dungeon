// Waits until a run has at least N players, then prints them. Exits non-zero on timeout.
//   npx tsx scripts/wait-join.ts <run> [players=2] [timeoutSec=900]
import { PublicKey } from "@solana/web3.js";
import { Chain, NETS, Net } from "../src/chain";

const chain = new Chain(NETS[(process.env.NET ?? "devnet") as Net]);
const run = new PublicKey(process.argv[2]);
const want = Number(process.argv[3] ?? 2);
const deadline = Date.now() + Number(process.argv[4] ?? 900) * 1000;
for (;;) {
  const got = await chain.fetchRun(run).catch(() => null);
  const n = got?.state.playerCount ?? 0;
  if (n >= want) {
    console.log(`JOINED: ${n} players:`, got!.state.players.slice(0, n).map((p) => p.wallet.toBase58()).join(", "));
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.log(`TIMEOUT: still ${n} player(s)`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
