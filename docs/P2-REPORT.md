# P2 Phase Report: Web client (Tue 24 Nov 2026)

## Result: what was played, and where
**Local MagicBlock stack** (ephemeral-validator 1.1.1, the version the public devnet ERs run: base :8899, ER :7799).

### Smoke script (`app/scripts/smoke.ts`, same `chain.ts` the game uses)
```
[1.6s] created run …
[2.5s] 2 players joined, pot 200000000
[3.0s] delegated; ER sees the run live
[3.5s] positions: seat0 (4,3) seat1 (4,4)
[3.6s] after 3 hits: seat0 alive=false dropped bag present=true
[3.7s] seat1 extracted
[3.8s] end_run accepted on the ER
[23.9s] COMMIT NOT LANDED (known local-stack issue …)
[23.9s] ER move latency (send+confirm) over 18 moves: p50 50ms, max 59ms
[31.9s] open_chest accepted on the ER; waiting for the VRF callback...
[49.5s] VRF: request accepted but no callback within 20s
```

### Two browser tabs, two dev wallets (in-app browser, driven by keyboard)
| Step | Result |
|---|---|
| Tab 1: dev wallet, then create run (0.05 SOL, 300 s), then join | Lobby shows pot 0.05 |
| Tab 2: opens the invite link, dev wallet, join | Tab 1 updates live: 2 seats, pot 0.10 |
| Tab 1 (host): Start run | **Both** tabs switch into the game on their own |
| Tab 1: ↓↓→→→ | `sent: 5`, at (4,3) |
| Tab 2: ↑↑←←←←←←↑ | at (4,4), and sees seat 0 at (4,3) |
| Tab 2: ↑↑↑ (bump attacks) | Seat 0 slain, bag dropped at (4,3). Tab 1's HUD: "You were slain…" |
| Tab 2: ↑ onto the bag, → onto the exit, E | Bag picked up, "You got out", extracted |
| Tab 2 (not the host): End run | Both tabs: "Run over: committing the final state back to Solana…" |

## Client
- `app/src/chain.ts`: all RPC and transaction building (Anchor TS 1.1.2, web3.js v1, ER SDK 0.18.0). Shared with the Node scripts.
- `app/src/main.ts`: screens (connect, create, lobby, live, ended/settle) and input (bump-to-attack, bump-to-open chest, E to extract).
- `app/src/game.ts`: Phaser scene drawn purely from `Run` state. It diffs consecutive states for effects: hit shake and flash, −1, SLAIN, EXTRACTED, +loot, tier popups, and a flash for legendaries.
- `app/src/wallet.ts`: Phantom (injected provider) and a dev wallet in sessionStorage, so each tab is a different player. Session keys are per run, per tab.
- `npm run build`: tsc clean, Vite builds 2.4 MB (617 KB gzipped).

## Bugs found and fixed during P2
1. **Identical ER transactions dropped.** Two equal moves inside one ER blockhash serialize to the same bytes, and the second fails with
   "already processed". Fixed with a rotating `ComputeBudget` unit limit on every ER transaction (no program change).
2. **Non-host tabs stuck in the lobby.** The base subscription ignored the account once its owner became the delegation program.
   It now treats that as "went live" and follows the run to the ER.
3. **Lost taps.** "Latest input wins" dropped quick taps. Now one action is in flight at a time, with a FIFO buffer of 3, and
   move/attack/open is decided when the action runs, not at keypress.
4. **Input depended on the render loop.** Keys moved from Phaser to a `window` listener. Throttled key-repeat makes each tap
   exactly one action (`sent: 5` for 5 taps).
5. **HUD swallowed clicks.** Rebuilding the HUD every second could swallow a click. The tick now updates only the clock text.

## Not verified yet (blocked locally, moves to devnet in P3)
- **Commit back to base and settle.** On the local stack, ER 1.1.1's finalize transaction is rejected by the local base validator
  (`failed to deserialize VersionedTransaction: failed to fill whole buffer`). This is a version mismatch inside the stack, not our
  program: the same commit passes in MagicSVM, and `end_run` succeeds on the ER.
- **VRF chests.** No local oracle serves the ER queue. The request is accepted and the chest pulses "opening", but no callback arrives.
  The devnet ERs have a live oracle.
- **The rendered canvas.** The browser pane was hidden during testing, so Phaser never drew a frame and the game screen hasn't been
  seen yet. Everything above was verified through on-chain state, page text and the `window.__ed` debug handle.

## Running it
- Stack: `bash scripts/start-stack.sh` (foreground, logs in `~/ed-stack.log`)
- Client: `bash app/dev.sh` serves http://localhost:5180 (`?net=devnet` to target devnet)
- Smoke test: `cd app && npx tsx scripts/smoke.ts` · Inspect a run: `npx tsx scripts/peek.ts <run>`
