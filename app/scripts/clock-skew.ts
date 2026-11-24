// Compares the rollup's and base layer's on-chain clocks (Clock sysvar unix_timestamp) with local time.
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { Chain, NETS } from "../src/chain";

const chain = new Chain(NETS.devnet);
void PublicKey;
for (let i = 0; i < 3; i++) {
  const [er, base] = await Promise.all([
    (await chain.er()).getAccountInfo(SYSVAR_CLOCK_PUBKEY),
    chain.base.getAccountInfo(SYSVAR_CLOCK_PUBKEY),
  ]);
  const now = Date.now() / 1000;
  const unix = (d: Buffer) => Number(d.readBigInt64LE(32));
  console.log(`local ${now.toFixed(1)}  ER skew ${(unix(er!.data) - now).toFixed(1)}s  base skew ${(unix(base!.data) - now).toFixed(1)}s`);
  await new Promise((r) => setTimeout(r, 1500));
}
