// Prints a run's current state from wherever it lives.  npx tsx scripts/peek.ts <run>
import { PublicKey } from "@solana/web3.js";
import { Chain, NETS, Net } from "../src/chain";

const chain = new Chain(NETS[(process.env.NET ?? "local") as Net]);
const got = await chain.fetchRun(new PublicKey(process.argv[2]));
if (!got) throw new Error("not found");
const s = got.state;
console.log(`onEr=${got.onEr} status=${s.status} settled=${s.settled} pot=${s.pot.toString()}`);
s.players.slice(0, s.playerCount).forEach((p, i) =>
  console.log(`seat${i} (${p.x},${p.y}) hp=${p.hp} alive=${p.alive} out=${p.extracted} kills=${p.kills} (bag is private)`),
);
console.log("dropped:", s.dropped.filter((b) => b.present).map((b) => `(${b.x},${b.y})=${b.points}`).join(" ") || "none");
