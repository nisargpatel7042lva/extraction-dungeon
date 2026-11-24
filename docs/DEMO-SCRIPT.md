# Demo video script (target 2:30, hard cap 3:00)

**Setup before recording**
- Two browsers side by side (e.g. Chrome + Brave, or Chrome + an incognito profile with its own Phantom), each with a
  Phantom wallet in **testnet mode** holding ~0.2 devnet SOL.
- Open https://extraction-dungeon-three.vercel.app in both. 1080p, browser zoom 100%, close other tabs.
- A third tab on Solana Explorer (devnet), ready for the settle transaction.
- Stake **0.05 SOL**, run length **90 s**.
- Rehearse the fight once: P1 walks ↓↓→→→ to the left of the top exit, P2 comes from the bottom right.
  Open a chest *before* the fight so the dropped bag is worth something.
- **The privacy shot is the money shot:** frame both screens so viewers see P1's HUD say "Your bag 🔒 3 pts" while P2's
  says "bag ?" for P1.

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:12 | Title card or the game mid-fight | "Extraction Dungeon. Stake SOL, loot a dungeon, fight other players, and get out alive. What you extract with is yours, and nobody can see what you're carrying." |
| 0:12–0:25 | First visit: the **How to play** guide opens. Scroll it once, close. | "New players get a six-step guide: join, loot, fight, steal, get out, get paid." |
| 0:25–0:42 | P1: Connect Phantom → Create run → Join. P2 opens the link, joins. P1's lobby shows pot 0.10. Start. | "Joining puts your stake in a vault that never leaves Solana, and gives you a private bag on a MagicBlock Private Ephemeral Rollup, readable only by your own session key." |
| 0:42–1:05 | Split screen. P1 opens a chest: **RARE +3** on P1's screen. On P2's screen the chest just opens: "LOOTED ?". | "Walking into a chest asks MagicBlock VRF, running inside the rollup, to roll the loot. The tier lands in your private bag. Look at the other screen: they saw the chest open, but not what came out." |
| 1:05–1:30 | P2 hunts P1. Spam-pressing attack: the meter refills, and only one hit per 0.4 s lands. Three hits: **SLAIN**, sack with "?". | "Three hits kill, with a cooldown so the fastest clicker doesn't automatically win. The victim's whole bag drops as a sack, and nobody knows what's inside." |
| 1:30–1:45 | P2 steps on the sack: **+3**. Walks to EXIT, presses E: **EXTRACTED**. | "Grab it and run. To keep your loot you have to reach an exit. Stay greedy too long and you're the one getting robbed." |
| 1:45–2:05 | End run → "Committing the run and every bag…" → results with every bag revealed. Settle payouts. | "When the run ends, the run and every bag are committed back to Solana, and the bags are revealed. Extracted players split the pot by loot points." |
| 2:05–2:15 | Explorer: the settle tx, the vault → winner transfer. | "The payout comes straight from the program's vault, on devnet." |
| 2:15–2:30 | README architecture diagram, then the GitHub repo | "Private Ephemeral Rollup, VRF, session keys and an Anchor program, tested in MagicSVM and on devnet. Entertainment Finance with real stakes and hidden information. Extraction Dungeon." |

**If something goes wrong on camera**
- A VRF chest takes over 3 s: cut it. The "opening" flicker plus the tier popup is the shot.
- The commit takes a moment: keep "Committing…" on screen for 1–2 s. It shows the round trip.
- Keep the HUD visible in the fight shots: pot, your 🔒 bag, the attack meter and the timer tell the story without narration.
