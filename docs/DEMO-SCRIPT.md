# Demo video script (target 2:30, hard cap 3:00)

**Setup before recording**
- Two browsers side by side (e.g. Chrome + Brave, or Chrome + an incognito profile with its own Phantom), each with a
  Phantom wallet in **testnet mode** holding ~0.2 devnet SOL.
- Open https://extraction-dungeon-three.vercel.app in both. 1080p, browser zoom 100%, close other tabs.
- A third tab on Solana Explorer (devnet), ready for the settle transaction.
- Stake **0.05 SOL**, run length **90 s**.
- Rehearse the fight once: P1 walks ↓↓→→→ to the left of the top exit, P2 comes from the bottom right.
  Open a chest *before* the fight so the dropped bag is worth something.

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:12 | Title card or the game mid-fight | "Extraction Dungeon. Stake SOL, loot a dungeon, fight other players, and get out alive. What you extract with is yours, on Solana." |
| 0:12–0:30 | P1: Connect Phantom → Create run (0.05 SOL, 90 s) → Join. Copy invite link. | "A host opens a run with a stake and a timer. Joining puts your stake in a vault that never leaves Solana's base layer, and registers a session key in your browser." |
| 0:30–0:42 | P2 opens the link, joins. P1's lobby updates live to pot 0.10. Start run. | "When the host starts, the run is delegated to a MagicBlock Ephemeral Rollup in the same transaction." |
| 0:42–1:05 | Both move. P1 walks into a chest: "opening" pulse, then **RARE +3**. | "From here every step, hit and chest is a transaction on the rollup: no fees, no wallet popups, around 50 to 80 milliseconds each. Walking into a chest asks MagicBlock's VRF, running inside the rollup, to roll the loot. That's verifiable randomness, landing in under two seconds." |
| 1:05–1:30 | P2 hunts P1. Three hits: shake, flash, **SLAIN**, sack on the floor. | "Walk into another player to attack. Three hits and they're out, and their bag drops right where they fell." |
| 1:30–1:45 | P2 steps on the sack (+3), walks to EXIT, presses E: **EXTRACTED**. | "Anyone can pick it up. To keep your loot you have to reach an exit and extract. Stay greedy too long and you're the one getting robbed." |
| 1:45–2:05 | End run → "Committing to Solana…" → results: P2 extracted, 0.100 SOL. Settle payouts. | "When the run ends, the final state is committed back to Solana and undelegated. Extracted players split the pot by loot points. Slain or trapped players get nothing." |
| 2:05–2:15 | Explorer: the settle tx, the vault → winner transfer. | "The payout comes straight from the program's vault, on devnet." |
| 2:15–2:30 | README architecture diagram, then the GitHub repo | "Anchor program, ephemeral rollup, VRF and session keys, with tests in MagicSVM and on devnet. Entertainment Finance: a game where what you risk and what you win is real. Extraction Dungeon." |

**If something goes wrong on camera**
- A VRF chest takes over 3 s: cut it. The "opening" pulse plus the tier popup is the shot.
- The commit takes a moment: keep "Committing to Solana…" on screen for 1–2 s. It shows the round trip.
- Keep the HUD visible in the fight shots: pot, bags and the timer tell the story without narration.
