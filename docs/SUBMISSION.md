# Blitz v10 submission text

Copy into the form at https://build.magicblock.app/?stage=blitz#submit (log in first; logged out, it shows no open event).

**Project name**
Extraction Dungeon

**One-liner** (95 chars)
Stake SOL, loot a dungeon, fight other players, and get out alive: real-time PvP on MagicBlock.

**Links**
- Live (devnet): https://extraction-dungeon-three.vercel.app
- Repo: <GitHub URL>
- Video: <YouTube / Loom URL>
- Program (devnet): 2c1W2MUPCkF6bdcKvKXmLePwBorg6yy8L1A6BdoDBBqw

**Description**
Extraction Dungeon is a staked, real-time PvP extraction game, built from MagicBlock's "Extraction dungeon" idea.
2–4 players pay an entry stake into a vault that never leaves Solana's base layer, then the run is delegated to a
MagicBlock Ephemeral Rollup. Inside, every step, hit and chest is an on-chain transaction signed by a browser session key:
no fees, no wallet popups, about 50–80 ms each. Walking into a chest calls MagicBlock VRF inside the rollup to roll the loot
tier (common, rare, legendary). Three hits kill a player, and their bag drops on the floor for anyone to take. To keep your
loot you have to reach an exit and extract before the timer runs out. When the run ends it is committed back to Solana,
and the vault pays extracted players in proportion to their loot points. Slain or trapped players get nothing.

It's Entertainment Finance in a small package: the stake is real, the risk is real (stay greedy and someone takes your bag),
and the payout is settled by the program, not by a server.

**How it uses MagicBlock**
- **Ephemeral Rollups:** `start_run` + `delegate_run` in one tx. All gameplay runs on devnet-as. `end_run` commits and undelegates via `MagicIntentBundleBuilder`.
- **VRF:** `open_chest` requests randomness on the ephemeral queue from inside the ER, and `callback_open_chest` sets the tier and adds loot. About 0.7–2 s on devnet.
- **Session keys:** a per-run browser keypair registered at join; every ER action is checked against it.

**What's tested**
6 unit tests for the payout math, and 6 end-to-end scenarios in MagicSVM (stakes, movement, VRF tiers in the ER, death and
bag looting, timer expiry, proportional split). A devnet smoke test runs the whole loop with a real VRF chest and checks the
exact payout.

**Found along the way (feedback for the MagicBlock team)**
- `#[vrf_callback]` in SDK 0.18 evaluates `scoped_vrf_identity_const` at runtime inside the injected constraint and uses up
  the whole 200k CU budget. Workaround: declare `vrf_program_identity` yourself with a `const` address.
- Identical ER transactions within one blockhash are dropped as "already processed". A rotating ComputeBudget instruction fixes it.
- Locally, ephemeral-validator 1.1.1's commit/finalize transaction is rejected by the bundled base validator
  ("failed to fill whole buffer"), and the ephemeral VRF queue has no oracle. Devnet is fine.

**What's next**
Private bags on a Private Ephemeral Rollup (opponents can't see what you carry), collectible mints for legendary drops,
touch controls, and reclaiming rent from finished runs.

**Team**
<name, role, X/GitHub>
