# Demo video script (target 2:45, hard cap 3:00)

Judges score **creativity, technical depth, and how compellingly it shows what's possible on Solana**. The video has to
land three ideas fast: (1) it's a fun arcade game, (2) every action is on-chain in real time with no popups, (3) your bag is
private until the run ends, and the payout is settled by the program.

## Setup before recording

- **Two browser windows side by side** (e.g. Chrome + a second Chrome profile), each with Phantom in **testnet mode** and
  ~0.3 devnet SOL (faucet.solana.com). Window A = you (P1, host), window B = a friend or your second profile (P2).
- Open https://extraction-dungeon-three.vercel.app in both. 1080p screen recording, browser zoom 100%, other tabs closed.
- Sound **on** (the chiptune track and effects carry the energy). Record system audio.
- A third tab on Solana Explorer (devnet) for the payout transaction.
- Stake **0.05 SOL**, timer **2:00**, plus one **Hard CPU** so the fight is busy.
- The map is random each run. Do a couple of rehearsal runs; if you get a layout you like (Crossroads or Rooms read
  best on video), keep that take.
- **The money shot is privacy:** frame both windows so viewers see A's HUD say "Your bag 🔒 3" while B's player list shows
  "?" for A.
- Optional: a phone (or the browser's mobile view) for a 4-second shot of the D-pad layout.

## Shot list

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:10 | Hard cut into a fight mid-run: chests flashing, a knight going down, "SLAIN", the music running. | "This is Extraction Dungeon. Stake SOL, loot a dungeon, fight, and get out alive. Every single move here is a Solana transaction." |
| 0:10–0:22 | Landing page (arcade cabinet), then **Press start → Dev/Phantom → ★ New game**: pick 0.05 SOL, 2:00, Create. | "It's built on MagicBlock. You put in a stake, it goes into a vault that never leaves Solana's base layer." |
| 0:22–0:38 | **Player select**: B joins from the invite link, you add **+ CPU Hard**. Point at "STAGE 3 · ROOMS". Press **START GAME**, the loading bar ("Loading stage…"). | "Up to four players, or CPU bots if you're alone. A bot is a real on-chain player with its own stake. Every run gets one of five random dungeons. Start, and the whole run moves onto a MagicBlock Private Ephemeral Rollup running inside a TEE." |
| 0:38–0:55 | Both windows. Walk around fast; show the knight moving instantly. | "From here there are no wallet popups and no fees. A browser session key signs every step, and the rollup confirms it in milliseconds." |
| 0:55–1:20 | A opens a chest: **RARE +3**. Cut to B's window: the same chest just shows **LOOTED ?**. Then A's HUD "Your bag 🔒 3" next to B's roster showing "?" for A. | "Walking into a chest asks MagicBlock VRF for a provable roll, inside the rollup. The loot goes into my private bag. Look at the other screen: they saw the chest open, but not what came out. The TEE won't let anyone else read my bag." |
| 1:20–1:35 | Go for the glowing **Vault** in the centre: it rolls RARE or LEGENDARY. | "The Vault in the middle never rolls common, so that's where everybody fights." |
| 1:35–1:55 | Fight: B (or the Hard CPU) hits A, the attack meter refills between hits; three hits, **SLAIN**, a sack with "?". B walks over it: "+" pops on B's side only. | "Three hits kill, with a cooldown so spam-clicking doesn't win. Your whole bag drops as a sack, and nobody knows what's in it. Whoever grabs it is gambling." |
| 1:55–2:10 | **EXITS OPEN** banner. A player stands on an exit, the green channel ring fills, **EXTRACTED**. Show a hit interrupting someone else's channel if you catch it. | "Exits unlock a quarter of the way in. Extracting takes two seconds of standing still, and any hit cancels it. Get out before the timer, or lose everything." |
| 2:10–2:25 | Timer hits zero, the music speeds up in the last 30 s, then **Counting the loot…** then the results: **YOU WIN!** with the payout counting up and the high-score table. Press **CLAIM WINNINGS** for the coin shower and the **PAID ✓** stamp. | "When time's up, the run and every bag are committed back to Solana and revealed. The program splits the pot by loot. Nobody can end a run early, the host takes no cut, and if nobody escapes everyone's refunded." |
| 2:25–2:33 | Explorer: the settle transaction, vault to winner. | "That payout came straight from the program's vault, on devnet." |
| 2:33–2:38 | Phone view with the D-pad (optional). | "It plays on phones too, fullscreen." |
| 2:38–2:50 | README architecture diagram, then the repo. | "Private Ephemeral Rollup, VRF and session keys, an Anchor program with eighteen end-to-end tests in MagicSVM and a live devnet check. Real stakes, hidden information, arcade fun. Extraction Dungeon." |

## If something goes wrong on camera

- A VRF chest takes over 3 s: cut it. The "opening" flicker plus the tier popup is the shot.
- "Counting the loot…" takes a few seconds: keep 1–2 s of it, it shows the trip back to Solana, then cut.
- You die early (the Hard CPU is ruthless): keep it. "SLAIN" and the "?" sack are great footage; let window B carry the
  rest of the run.
- Keep the HUD visible in fight shots: pot, your 🔒 bag, the attack meter and the timer tell the story on their own.

## After recording

1. Upload to YouTube (unlisted is fine) or Loom.
2. Paste the link into `docs/SUBMISSION.md` (Video) and into the form.
3. Fill in the Team section, then submit at https://build.magicblock.app/?stage=blitz#submit before Fri 27 Nov.
