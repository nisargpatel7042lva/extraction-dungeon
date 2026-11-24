// Probe the MagicBlock devnet TEE (Private Ephemeral Rollup): auth token, latency, slot time.
import { Connection, Keypair } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";

const TEE = "https://devnet-tee.magicblock.app";
const AS = "https://devnet-as.magicblock.app";
const kp = Keypair.generate();

let t = performance.now();
const auth = await getAuthToken(TEE, kp.publicKey, (m: Uint8Array) => Promise.resolve(nacl.sign.detached(m, kp.secretKey)));
console.log(`auth token in ${(performance.now() - t).toFixed(0)}ms, expires ${new Date(Number(auth.expiresAt)).toISOString?.() ?? auth.expiresAt}`);

const tee = new Connection(`${TEE}?token=${auth.token}`, "processed");
const rtt: number[] = [];
for (let i = 0; i < 10; i++) {
  t = performance.now();
  await tee.getLatestBlockhash();
  rtt.push(performance.now() - t);
}
rtt.sort((a, b) => a - b);
console.log(`TEE getLatestBlockhash p50 ${rtt[5].toFixed(0)}ms min ${rtt[0].toFixed(0)}ms`);

for (const [name, conn] of [["tee", tee], ["asia", new Connection(AS, "processed")]] as const) {
  const s0 = await conn.getSlot();
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, 5000));
  const s1 = await conn.getSlot();
  console.log(`${name}: ${s1 - s0} slots in 5s -> ${((performance.now() - t0) / (s1 - s0)).toFixed(0)}ms/slot`);
}

// Without a token the TEE should refuse.
try {
  await new Connection(TEE, "processed").getLatestBlockhash();
  console.log("no-token request: ACCEPTED (unexpected)");
} catch (e) {
  console.log("no-token request rejected:", (e as Error).message.slice(0, 80));
}
