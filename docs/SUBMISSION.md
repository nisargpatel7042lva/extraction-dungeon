# Blitz v10 submission text

Copy into the form at https://build.magicblock.app/?stage=blitz#submit (log in first; logged out, it shows no open event).

**Project name**
Extraction Dungeon

**One-liner** (99 chars)
Stake SOL, loot a dungeon, fight, and get out alive. Real-time PvP where nobody can see your bag.

**Links**
- Live (devnet): https://extraction-dungeon-three.vercel.app
- Repo: https://github.com/nisargpatel7042lva/extraction-dungeon
- Video: <YouTube / Loom URL>
- Program (devnet): 2c1W2MUPCkF6bdcKvKXmLePwBorg6yy8L1A6BdoDBBqw

**Description**
Extraction Dungeon is a staked, real-time PvP extraction game, built from MagicBlock's "Extraction dungeon" idea.
2–4 players pay an entry stake into a vault that never leaves Solana's base layer. The run is then delegated to a
MagicBlock **Private Ephemeral Rollup**. Inside, every step, hit and chest is an on-chain transaction signed by a browser
session key: no fees and no wallet popups.

Walking into a chest calls MagicBlock VRF inside the rollup, and the loot lands in your **private bag**: only you can see
how much you carry and what your chests rolled. Opponents see a chest open and a "?" over every sack. Three hits kill (with
a 0.4 s attack cooldown), and a dead player's whole bag drops on the floor for anyone to grab, unseen. To keep your loot you
have to reach an exit and extract before the timer runs out. When the run ends, the run and every bag are committed back to
Solana, the bags are revealed, and the vault pays extracted players in proportion to their loot points. Slain or trapped
players get nothing.

It's Entertainment Finance in a small package: the stake is real, the risk is real (stay greedy and someone takes your bag),
the information is hidden (you never know whether that player is worth killing), and the payout is settled by the
program, not by a server. A six-step "How to play" guide opens on the first visit.

**How it uses MagicBlock**
- **Private Ephemeral Rollup (TEE):** the run and one Bag PDA per player are delegated to the TEE validator. Each player's
  session key creates a private permission (`CreateEphemeralPermissionCpi`, members = itself) so only it can read its bag;
  the run gets a public one. Clients authenticate with `getAuthToken`, signed locally by the session key.
- **Ephemeral Rollups:** all gameplay runs on the rollup. `end_run` commits and undelegates the run plus every bag in one
  `MagicIntentBundleBuilder` intent.
- **VRF:** `open_chest` requests randomness on the ephemeral queue from inside the PER. `callback_open_chest` writes the
  tier and loot into the opener's private bag (~0.7 s on devnet-tee).
- **Session keys:** a per-run browser keypair registered at join. Every rollup action is checked against it.

**What's tested**
6 unit tests for the payout math. 9 end-to-end scenarios in MagicSVM, including "opponents can't read each other's bags",
the attack cooldown, chest tiers landing only in the private bag, and bags that can't be swapped between seats. A devnet
smoke test on the TEE makes 17 checks: owner-only bag reads (an opponent and an anonymous viewer are both refused), VRF on
the TEE, the cooldown, hidden sack contents, bags public after the run, and the exact payout.

**Found along the way (feedback for the MagicBlock team)**
- `#[vrf_callback]` in SDK 0.18 evaluates `scoped_vrf_identity_const` at runtime inside the injected constraint and uses up
  the whole 200k CU budget. Workaround: declare `vrf_program_identity` yourself with a `const` address.
- Ephemeral permission accounts hold no lamports, so a `permission.lamports() > 0` "already exists" check is always false.
  Check `!data_is_empty()` instead.
- Identical rollup transactions within one blockhash are dropped as "already processed". A rotating ComputeBudget
  instruction fixes it.
- Locally, ephemeral-validator 1.1.1's commit/finalize transaction is rejected by the bundled base validator
  ("failed to fill whole buffer"), and the ephemeral VRF queue has no oracle. Devnet is fine.

**What's next**
Collectible mints for legendary drops, touch controls, a lobby list of open runs, and reclaiming rent from finished runs.

**Team**
<name, role, X/GitHub>
