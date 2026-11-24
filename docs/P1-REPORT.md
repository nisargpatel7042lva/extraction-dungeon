# P1 Phase Report: Core program (Mon 23 Nov 2026)

## Result
```
=== unit tests (cargo test -p extraction_dungeon --lib)
test state::tests::empty_bags_split_equally ... ok
test state::tests::nobody_extracted_goes_to_house ... ok
test state::tests::proportional_to_bag_points_among_extracted ... ok
test state::tests::tiers_cover_the_whole_roll_range ... ok
test state::tests::integer_dust_goes_to_house ... ok
test test_id ... ok
test result: ok. 6 passed; 0 failed

=== MagicSVM end-to-end (tests-magicsvm/tests/run.rs)
test authority_can_end_early_and_extracted_players_split_by_points ... ok
test chests_roll_tiers_with_vrf_paid_by_the_session_key ... ok
test death_drops_the_bag_killer_loots_it_extracts_and_takes_the_pot ... ok
test join_takes_stakes_funds_session_keys_and_enforces_seats ... ok
test movement_respects_walls_chests_players_and_session_keys ... ok
test timer_runs_out_trapping_players_and_the_pot_goes_to_the_house ... ok
test result: ok. 6 passed; 0 failed
```
The build has zero warnings.

## Instructions
| Layer | Instruction | What it does |
|---|---|---|
| base | `create_run(run_id, entry_lamports, duration_secs)` | Creates the lobby and its stake `Vault` PDA, which is never delegated |
| base | `join_run(session_signer)` | Takes the stake into the vault, sends 0.004 SOL to the session key, seats the player at a corner spawn |
| base | `start_run` + `delegate_run` | One tx: starts the clock (`ends_at`) and hands the run to the ER |
| ER | `move_player(dir)` | Grid step. Walls, chests and live players block. Walking onto a dropped bag picks it up |
| ER | `attack(dir)` | 1 damage to the adjacent player. At 0 HP the target dies and its bag drops on its tile |
| ER | `open_chest(chest)` → `callback_open_chest` | Adjacent chests only. VRF rolls 1–100: up to 60 common (1 pt), up to 90 rare (3), above 90 legendary (8) |
| ER | `extract` | From tile (5,3) or (6,5). The player leaves the board with their bag |
| ER | `end_run` | Authority at any time. Anyone once time is up or every player is dead or extracted. Commits and undelegates |
| base | `settle_run` | The vault pays extracted players in proportion to bag points. Empty bags split equally, nobody extracted means the house takes it, dust goes to the house. Emits `RunSettled` |

## Proven by tests
- Stakes land in the vault, the pot is tracked, session keys get funded, and the seat rules hold (double join, 5th player).
- Blocking by walls, chests, other players, bad directions and strangers' keys. The base layer is unchanged until commit.
- VRF tiers inside the ER (randomness forced via `set_vrf_randomness`). A chest can't be reopened and must be adjacent.
- Full PvP loop: rare chest, 3 hits kill, bag drops at (4,3), the killer walks onto it (+3), extracts, ends the run as a
  *player* (everyone resolved), and settle pays the winner exactly 0.2 SOL. Double settle is rejected.
- Timer: moves fail after `ends_at`, a player can only end the run after the timer, and trapped players' stakes go to the house.
- Split: 1 pt and 3 pts extracted, 1 trapped, so 0.075 / 0.225 / 0 SOL exactly.

## Findings
- **VRF on the ER cost the session key 0 lamports in MagicSVM.** If devnet agrees, `SESSION_TOPUP` can
  drop to 0, or just enough for base-layer cleanup.
- Error 6009 in the one failure along the way was the program correctly blocking a test path that ran into a wall.

## Known gaps (deliberate, noted for later phases)
- No attack cooldown: a faster clicker wins a trade. The client will rate-limit. A slot-based cooldown is an easy add if playtests show spam.
- If a chest's opener dies *and* their dropped bag is looted before the VRF callback lands, that chest's loot is lost.
- No collectible mint for rare drops yet (stretch goal, P3/P4).
- Still nothing tested on a real devnet ER. This is the first thing to do in P2/P3.
