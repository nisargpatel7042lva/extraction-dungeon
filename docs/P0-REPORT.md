# P0 Phase Report: Scaffold (Mon 23 Nov 2026)

## Result
`cargo test` in `tests-magicsvm/` (MagicSVM 0.3.0 simulator: base layer + ER + VRF oracle):

```
ER VRF roll #1: 96
test lobby_seats_players_at_spawns_and_rejects_double_join ... ok
ER VRF roll #2: 87
ER VRF roll #3: 69
test vrf_roll_is_fulfilled_inside_the_er ... ok
test moves_run_on_the_er_with_session_keys_and_commit_back ... ok
test result: ok. 3 passed; 0 failed
```

## What exists
- `programs/extraction_dungeon`: `create_run`, `join_run(session_signer)`, `start_run`, `delegate_run`,
  `move_player(dir)` (ER), `roll` + `callback_roll` (VRF, works on the ER), `end_run` (commit + undelegate).
- `src/map.rs`: the 12x9 room and 4 corner spawns, kept as a const so the client can mirror it.
- Program id `2c1W2MUPCkF6bdcKvKXmLePwBorg6yy8L1A6BdoDBBqw`. 370 KB `.so`, build has zero warnings.

## What the tests prove
- The lobby seats players at their spawn tiles. A double join and a 5th player are both rejected.
- `start_run` + `delegate_run` work in a single base-layer transaction.
- Moves on the ER are **signed and fee-paid by the session key alone**, with no wallet involved. Walls,
  the outer edge and strangers' keys are all rejected. Base keeps its pre-run snapshot until `end_run`,
  which then lands the ER state on base and undelegates the account.
- VRF requests made inside the ER on `DEFAULT_EPHEMERAL_QUEUE` are fulfilled one slot later, and the
  results commit back to base.

## Decisions and gotchas
1. **Pin Anchor to `=1.1.2` across the board.** `anchor-lang = "=1.0.2"` let the macro crates resolve
   to 1.2.2, which emit `create_account_allow_prefund` (missing in 1.0.2). The fix is `=1.1.2`
   (matching anchor-cli 1.1.2) plus `cargo update -p <anchor-*> --precise 1.1.2` in both lockfiles.
2. **SDK 0.18 `#[vrf_callback]` bug.** Its injected `vrf_program_identity` constraint evaluates
   `scoped_vrf_identity_const(&crate::ID)` at runtime (software PDA derivation), using up all 197k CU.
   Our workaround is to declare the field ourselves with `address = VRF_CALLBACK_IDENTITY`, a `const`.
   This is worth reporting to MagicBlock (the Telegram builders group).
3. Tests use MagicSVM rather than the local `mb-stack`. MagicSVM is faster and is what the official
   examples use. The installed `ephemeral-validator` 0.13.18 is from August, and its compatibility
   with SDK 0.18 is unverified.

## Not verified yet
- **A real devnet ER.** MagicSVM simulates the ER. On real devnet two things are still open: (a) whether
  a zero-balance session key can pay fees on the ER, and (b) who funds the 0.0005 SOL VRF request inside
  the ER. Deploying needs about 2.7 SOL. The wallet `3fTVWV…nA5` has 2.13 devnet SOL.
