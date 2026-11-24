# P3 progress: Devnet + polish (Tue 24 Nov 2026, in progress)

## Done
### Program live on devnet
- `2c1W2MUPCkF6bdcKvKXmLePwBorg6yy8L1A6BdoDBBqw`, built with `opt-level = "z"`: 405 KB down to 328 KB, rent
  2.06 down to **1.67 SOL**. All 6 MagicSVM scenarios still pass on the size-optimised build.
- Deployed with `scripts/deploy-devnet.sh`. The IDL is bundled in the client, not stored on chain.

### Full loop verified on devnet + the Asia ER (`NET=devnet npx tsx scripts/smoke.ts`)
```
[5.6s] 2 players joined, pot 20000000
[7.8s] delegated; ER sees the run live
[15.5s] after 3 hits: seat0 alive=false dropped bag present=true
[17.2s] seat1 extracted
[19.2s] end_run accepted on the ER
[20.2s] committed back to base: status Ended, seat1 extracted = true      <- broken locally, works on devnet
[21.4s] settled: winner gained 0.02 SOL (pot 0.02)                        <- exact payout
[21.4s] ER move send time (input queue blocked) over 18 moves: p50 78ms, max 661ms
[21.4s] end-to-end: 7 moves landed in 2290ms; 9 moves landed in 1559ms; 2 moves landed in 325ms
[27.5s] VRF callback landed after 693ms: tier 2, bag 3; session key paid 0 lamports on the ER
[33.4s] swept 0.0820 SOL back to the CLI wallet
```
A full run (two run accounts' rent plus fees) costs about 0.04 SOL. The CLI wallet has 0.38 SOL left.

### Latency work
- Endpoint round trips from this machine: asia 75 ms, eu 145 ms, router 180 ms, us 230 ms. The game uses asia.
- Per move, the input queue was blocked for 273 ms. It's now **78 ms**:
  - ER blockhash cached and refreshed in the background.
  - Moves and attacks are fire-and-forget, confirmed at `processed` in the background, with failures shown as a toast.
- Client-side prediction: your own move is drawn immediately when the tile is walkable. Chain state takes over once it
  agrees, or after 1.5 s (rubber-band).
- After settle, the session key's leftover top-up (~0.004 SOL) is returned to the player's wallet.
- Devnet onboarding hint on the connect screen: Phantom testnet mode and the faucet link.

## Blocked on the user
1. **Rendered game not yet seen.** The in-app browser pane is hidden, so Phaser never draws a frame.
2. **Vercel deploy.** The CLI is installed (`vercel` 66.6.0, WSL) but logged out. The MCP upload path would need the 2.4 MB bundle
   inlined as base64, which isn't workable. Needs `vercel login` once.

## Still to do in P3
- Visual pass once the canvas can be seen. Then deploy to Vercel and play one 2-tab devnet run on the public URL.
