# Blitz v10 submission text

Copy into the form at https://build.magicblock.app/?stage=blitz#submit (log in first; the form's fields only appear
when you're signed in). Submissions close **Fri 27 Nov 2026**.

Judging: creativity, technical depth, and how compellingly it showcases what's possible on Solana.

**Project name**
Extraction Dungeon

**One-liner** (96 chars)
Stake SOL, loot a dungeon, fight, and get out alive. Real-time PvP where nobody can see your bag.

**Short pitch** (for a tweet or a 280-character field)
Extraction Dungeon: stake SOL, crack VRF chests, steal bags, escape before time runs out. Every step is on-chain on a
MagicBlock Private Ephemeral Rollup: no fees, no popups, and your loot stays hidden in a TEE until the run ends.
Play solo vs CPUs or with friends.

**Links**
- Live (devnet): https://extraction-dungeon-three.vercel.app
- Repo: https://github.com/nisargpatel7042lva/extraction-dungeon
- Video: <YouTube / Loom URL, add after recording>
- Program (devnet): `2c1W2MUPCkF6bdcKvKXmLePwBorg6yy8L1A6BdoDBBqw`

**Description**
Extraction Dungeon is a staked, real-time PvP extraction game, built from MagicBlock's "Extraction dungeon" idea and
styled like an arcade cabinet.

1 to 4 players stake SOL into a vault that never leaves Solana's base layer. The run is then delegated to a MagicBlock
**Private Ephemeral Rollup** running in a TEE. Inside, every step, hit and chest is an on-chain transaction signed by a
browser session key: no fees and no wallet popups.

Walking into a chest asks MagicBlock **VRF** for a roll inside the rollup, and the loot lands in your **private bag**: only
you can see how much you carry. Opponents see a chest open and a "?" over every sack. Three hits kill (0.4 s cooldown), and a
dead player's whole bag drops on the floor for anyone to grab, unseen. The Vault in the middle never rolls common, so it's
where fights happen. Exits stay locked for the first quarter of the run, and extracting is a 2-second channel that any hit
interrupts. Get out before the timer ends, or lose everything.

When the run ends, the run and every bag are committed back to Solana, the bags are revealed, and the vault pays extracted
players in proportion to their loot. The rules protect the stake: nobody (the host included) can end a run early, the
host never takes a cut, if nobody escapes every stake is refunded, and a lobby that never starts can be cancelled with full
refunds.

It's Entertainment Finance in a small package: real stakes, real risk (stay greedy and someone takes your bag), hidden
information (you never know whether that player is worth killing), and a payout settled by the program, not a server.

**What makes it fun to play**
- Five random dungeon layouts (Crossroads, Pillars, Rooms, Serpent, Ring), so no two rounds feel the same.
- Easy, Medium and Hard CPU opponents. A CPU is a real seated player with its own stake and private bag; its brain runs
  in the host's tab, and its winnings come back to the host. Practice runs are free.
- Arcade presentation: player select, loading bars between chain hops, a score tally and high-score table, a coin shower
  when you claim, an original chiptune soundtrack that speeds up in the last 30 seconds, and procedural sound effects.
- Plays on phones in both orientations with a D-pad, and goes fullscreen on the first tap.

**How it uses MagicBlock**
- **Private Ephemeral Rollup (TEE):** the run and one Bag PDA per player are delegated to the TEE validator. Each player's
  session key creates an ER-local permission (`CreateEphemeralPermissionCpi`, members = itself) so only it can read its
  bag; the run gets a public one. Clients authenticate with `getAuthToken`, signed locally by the session key.
- **Ephemeral Rollups:** all gameplay runs on the rollup. Moves are fire-and-forget with client-side prediction, so your
  knight moves instantly. `end_run` commits and undelegates the run and every bag in one `MagicIntentBundleBuilder` intent.
- **VRF:** `open_chest` requests randomness on the ephemeral queue from inside the PER (fee-free there).
  `callback_open_chest`, gated by the program's scoped VRF identity, writes the tier into the opener's private bag
  (about 0.7 s on devnet-tee).
- **Session keys:** a per-run browser keypair registered at join, checked on every rollup action and swept back after.

**What's tested**
- 8 unit tests: payout math (proportional split, equal split, refunds when nobody escapes, dust to the best bag), tier
  tables, and every map being fully connected.
- 18 end-to-end scenarios in MagicSVM (base layer + ER + VRF + permission program), including "opponents can't read each
  other's bags", "the host can't end a run early to grab the pot", lobby cancel refunds, the attack cooldown, locked
  exits, channeled extraction, and a loot-and-extract run on every map.
- A devnet smoke test on the TEE with 13 checks: owner-only bag reads (an opponent is refused), VRF on the TEE, the Vault
  tier table, locked exits, the cooldown, hidden sack contents, channeling, and the exact payout.

**Found along the way (feedback for the MagicBlock team)**
- `#[vrf_callback]` in SDK 0.18 evaluates `scoped_vrf_identity_const` at runtime inside the injected constraint and uses
  up the whole 200k CU budget. Workaround: declare `vrf_program_identity` yourself with a `const` address.
- Ephemeral permission accounts hold no lamports, so a `permission.lamports() > 0` "already exists" check is always
  false. Check `!data_is_empty()` instead.
- Identical rollup transactions within one blockhash are dropped as "already processed". A rotating ComputeBudget
  instruction fixes it.
- The rollup's Clock sysvar runs about 1–3 s behind device clocks, so client countdowns read the chain clock.
- On the SBF target, an array-of-structs map table read back zeroed tuple fields for some entries; plain per-field const
  arrays work. Caught by a MagicSVM test that plays every map.
- Locally, ephemeral-validator 1.1.1's commit/finalize transaction is rejected by the bundled base validator ("failed to
  fill whole buffer"), and the ephemeral VRF queue has no oracle. Devnet is fine.

**What's next**
- A crank that ends each run automatically at the buzzer, and a post-commit Magic Action that settles payouts in the same
  step (no "End run" or "Claim" clicks).
- A public list of open lobbies, collectible mints for legendary drops, and reclaiming rent from finished runs.

**Team**
- <your name> — <role> · GitHub [@nisargpatel7042lva](https://github.com/nisargpatel7042lva) · X: <handle>
- <add teammates, if any>
