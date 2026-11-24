// Waits until a run is settled (or its timer has long passed), then prints the outcome.
//   npx tsx scripts/wait-end.ts <run> [timeoutSec=600]
import { PublicKey } from "@solana/web3.js";
import { Chain, NETS, Net, Status } from "../src/chain";

const chain = new Chain(NETS[(process.env.NET ?? "devnet") as Net]);
const run = new PublicKey(process.argv[2]);
const deadline = Date.now() + Number(process.argv[3] ?? 600) * 1000;
let lastLine = "";
for (;;) {
  const got = await chain.fetchRun(run).catch(() => null);
  const s = got?.state;
  if (s) {
    const seats = s.players.slice(0, s.playerCount).map((p, i) => `seat${i}:${p.extracted ? "extracted" : p.alive ? "inside" : "slain"}`).join(" ");
    const line = `status=${s.status} settled=${s.settled} ${seats}`;
    if (line !== lastLine) {
      lastLine = line;
      if (s.status === Status.Ended && s.settled) {
        const bags = await Promise.all(s.players.slice(0, s.playerCount).map((_, i) => chain.fetchBag(run, i)));
        console.log(`SETTLED: ${seats}; bag points: ${bags.map((b) => b?.points ?? "?").join(", ")}; pot ${Number(s.pot.toString()) / 1e9} SOL`);
        process.exit(0);
      }
    }
  }
  if (Date.now() > deadline) {
    console.log(`TIMEOUT: ${lastLine}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
