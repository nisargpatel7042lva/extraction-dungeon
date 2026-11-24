# P3 Phase Report: Devnet + polish (Tue 24 Nov 2026)

**Live:** https://extraction-dungeon-three.vercel.app (devnet + MagicBlock devnet-as ER)
**Program:** `2c1W2MUPCkF6bdcKvKXmLePwBorg6yy8L1A6BdoDBBqw` on devnet

## Verified
### Full loop on devnet (`NET=devnet npx tsx scripts/smoke.ts`, the same `chain.ts` the site uses)
```
[7.8s]  delegated; ER sees the run live
[15.5s] after 3 hits: seat0 alive=false dropped bag present=true
[17.2s] seat1 extracted
[20.2s] committed back to base: status Ended, seat1 extracted = true
[21.4s] settled: winner gained 0.02 SOL (pot 0.02)
[21.4s] ER move send time (input queue blocked) over 18 moves: p50 78ms, max 661ms
[21.4s] end-to-end: 7 moves landed in 2290ms; 9 moves landed in 1559ms; 2 moves landed in 325ms
[27.5s] VRF callback landed after 693ms: tier 2, bag 3; session key paid 0 lamports on the ER
```

### Live site (in-app browser, at the Vercel origin)
- Anonymous `GET /` returns 200 (no Vercel auth wall). Loads in devnet mode, with no console errors.
- From the browser origin: devnet RPC 200, ER RPC 200, program account readable, both websockets open, so **no CORS problems**.

### Rendered game (local stack, two tabs, 1280×800)
- Seen for the first time: the grid, 6 chests, 2 exits, both players with HP hearts and the "you" ring, and the HUD (timer, pot, bag, seats).
- Walking: 2 taps give `sent: 2`. Player 2's 9-tap path gives `sent: 9`, landing exactly at (4,4).
- Combat seen on screen: the hit flash, then the victim disappears, a loot sack appears on their tile, and the HUD shows "You were slain…".
- Phone width (375 px): no horizontal overflow, and the canvas scales to 343 px.

## Changes in P3
- Program built with `opt-level = "z"`: 405 KB down to 328 KB (deploy rent 2.06 down to 1.67 SOL). All tests re-run green.
- ER sends: background-refreshed blockhash, fire-and-forget moves/attacks confirmed at `processed` in the background
  (failures become toasts). Input-queue block per move went from 273 ms to 78 ms.
- Client-side prediction for your own moves (rubber-bands back after 1.5 s if the chain disagrees).
- Input buffer raised from 3 to 8: the visual pass caught 2 of 6 quick taps being dropped.
- Visuals: high-contrast walls (dark stone with a lit top edge), lighter checkered floor, outlined players, larger EXIT label.
- After settle, the session key's leftover top-up is returned to the player's wallet. Devnet onboarding hint (Phantom testnet mode and the faucet).
- Vercel: project `extraction-dungeon`, `app/vercel.json` (Vite, `dist/`), deployed with `vercel deploy --prod`.

## Not verified
- **Phantom signing.** The in-app browser has no Phantom, so `connectPhantom` / `signTransaction` have never run. The chain
  code they feed is proven by the devnet smoke test, but the wallet hop itself needs one real try in a browser with Phantom.
- **A full human-vs-human run on the live site** (needs two Phantom wallets on devnet).
- **Touch controls:** none yet. The game needs a keyboard, so phones can watch but not play.

## Costs and balances
- CLI devnet wallet: 0.38 SOL left. **A program upgrade needs ~1.67 SOL of temporary buffer**, so get faucet SOL before
  any on-chain change.
