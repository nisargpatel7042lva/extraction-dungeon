//! Extraction Dungeon: staked, real-time extraction runs on a MagicBlock Ephemeral Rollup.
//!
//! Lifecycle of a `Run` PDA:
//!   base:  create_run -> join_run (stake, x N) -> start_run + delegate_run (one tx)
//!   ER:    move_player / attack / open_chest (VRF) / extract
//!          (free, fast, signed by each player's session key)
//!   ER:    end_run -> commit_and_undelegate back to base
//!   base:  settle_run -> vault pays extracted players by bag points

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::{
    anchor::{commit, delegate, ephemeral, vrf, vrf_callback},
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
    vrf::{
        consts::{program_identity_pubkey, scoped_vrf_identity_const},
        instructions::{create_request_randomness_ix_const, RequestRandomnessParams},
        rnd::random_u8_with_range,
        types::SerializableAccountMeta,
    },
};

pub mod map;
pub mod state;

use state::*;

declare_id!("2c1W2MUPCkF6bdcKvKXmLePwBorg6yy8L1A6BdoDBBqw");

pub const RUN_SEED: &[u8] = b"run";
pub const VAULT_SEED: &[u8] = b"vault";
const PROGRAM_IDENTITY: Pubkey = program_identity_pubkey(&crate::ID);
const VRF_CALLBACK_IDENTITY: Pubkey =
    Pubkey::new_from_array(scoped_vrf_identity_const(&crate::ID).0);

#[ephemeral]
#[program]
pub mod extraction_dungeon {
    use super::*;

    /// Base. Creates an empty lobby and its stake vault.
    pub fn create_run(
        ctx: Context<CreateRun>,
        run_id: u64,
        entry_lamports: u64,
        duration_secs: u32,
    ) -> Result<()> {
        require!(duration_secs > 0, DungeonError::BadDuration);
        let run = &mut ctx.accounts.run;
        run.authority = ctx.accounts.authority.key();
        run.run_id = run_id;
        run.status = RunStatus::Lobby as u8;
        run.entry_lamports = entry_lamports;
        run.duration_secs = duration_secs;
        run.bump = ctx.bumps.run;
        run.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// Base. Seats the wallet, takes its stake into the vault, and funds + registers the
    /// browser session key that will sign its actions inside the ER.
    pub fn join_run(ctx: Context<JoinRun>, session_signer: Pubkey) -> Result<()> {
        let run = &mut ctx.accounts.run;
        require!(run.status == RunStatus::Lobby as u8, DungeonError::NotInLobby);
        let wallet = ctx.accounts.player.key();
        let n = run.player_count as usize;
        require!(n < MAX_PLAYERS, DungeonError::RunFull);
        require!(
            !run.seated().iter().any(|p| p.wallet == wallet),
            DungeonError::AlreadyJoined
        );

        let sys = ctx.accounts.system_program.key();
        let from = ctx.accounts.player.to_account_info();
        if run.entry_lamports > 0 {
            transfer(
                CpiContext::new(sys, Transfer { from: from.clone(), to: ctx.accounts.vault.to_account_info() }),
                run.entry_lamports,
            )?;
            run.pot = run.pot.checked_add(run.entry_lamports).ok_or(DungeonError::Overflow)?;
        }
        transfer(
            CpiContext::new(sys, Transfer { from, to: ctx.accounts.session.to_account_info() }),
            SESSION_TOPUP,
        )?;

        let (x, y) = map::SPAWNS[n];
        run.players[n] = PlayerSlot {
            wallet,
            signer: session_signer,
            x,
            y,
            hp: START_HP,
            alive: true,
            ..Default::default()
        };
        run.player_count += 1;
        Ok(())
    }

    /// Base. Starts the clock. Sent in the same tx as `delegate_run`.
    pub fn start_run(ctx: Context<StartRun>) -> Result<()> {
        let run = &mut ctx.accounts.run;
        require!(run.status == RunStatus::Lobby as u8, DungeonError::NotInLobby);
        require!(run.player_count > 0, DungeonError::NoPlayers);
        run.status = RunStatus::Live as u8;
        run.ends_at = Clock::get()?.unix_timestamp + run.duration_secs as i64;
        Ok(())
    }

    /// Base. Hands the run to the ER validator (optionally pinned via remaining_accounts[0]).
    pub fn delegate_run(ctx: Context<DelegateRun>, run_id: u64) -> Result<()> {
        ctx.accounts.delegate_run(
            &ctx.accounts.authority,
            &[RUN_SEED, ctx.accounts.authority.key().as_ref(), &run_id.to_le_bytes()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|a| a.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// ER. One grid step. `dir`: 0 up, 1 right, 2 down, 3 left.
    /// Stepping onto a dropped bag picks it up.
    pub fn move_player(ctx: Context<Act>, dir: u8) -> Result<()> {
        let run = &mut ctx.accounts.run;
        let i = acting_seat(run, &ctx.accounts.signer.key())?;
        let p = run.players[i];
        let (nx, ny) = map::step(p.x, p.y, dir).ok_or(DungeonError::BadDirection)?;
        require!(
            !map::is_wall(nx, ny) && !map::is_chest(nx, ny) && run.active_at(nx, ny).is_none(),
            DungeonError::Blocked
        );
        run.players[i].x = nx;
        run.players[i].y = ny;
        run.pick_up(i, nx, ny);
        Ok(())
    }

    /// ER. Hits the active player on the adjacent tile in `dir` for 1 damage.
    pub fn attack(ctx: Context<Act>, dir: u8) -> Result<()> {
        let run = &mut ctx.accounts.run;
        let i = acting_seat(run, &ctx.accounts.signer.key())?;
        let p = run.players[i];
        let (tx, ty) = map::step(p.x, p.y, dir).ok_or(DungeonError::BadDirection)?;
        let t = run.active_at(tx, ty).ok_or(DungeonError::NoTarget)?;
        run.players[t].hp = run.players[t].hp.saturating_sub(1);
        if run.players[t].hp == 0 {
            run.kill(t);
            run.players[i].kills = run.players[i].kills.saturating_add(1);
        }
        Ok(())
    }

    /// ER. Starts opening an adjacent chest; VRF decides the tier in `callback_open_chest`.
    /// The session key pays the VRF fee.
    pub fn open_chest(ctx: Context<OpenChest>, chest: u8) -> Result<()> {
        let run_key = ctx.accounts.run.key();
        let i = {
            let run = &mut ctx.accounts.run;
            let i = acting_seat(run, &ctx.accounts.payer.key())?;
            let c = chest as usize;
            require!(c < map::NUM_CHESTS, DungeonError::BadChest);
            require!(
                run.chests[c].state == ChestState::Closed as u8,
                DungeonError::ChestUnavailable
            );
            let p = run.players[i];
            require!(map::adjacent((p.x, p.y), map::CHESTS[c]), DungeonError::NotAdjacent);
            run.chests[c].state = ChestState::Opening as u8;
            run.chests[c].opener = i as u8;
            i
        };

        let ix = create_request_randomness_ix_const(
            RequestRandomnessParams {
                payer: ctx.accounts.payer.key(),
                oracle_queue: ctx.accounts.oracle_queue.key(),
                callback_program_id: crate::ID,
                callback_discriminator: instruction::CallbackOpenChest::DISCRIMINATOR.to_vec(),
                caller_seed: Clock::get()?.slot.to_le_bytes().repeat(4).try_into().unwrap(),
                accounts_metas: Some(vec![SerializableAccountMeta {
                    pubkey: run_key,
                    is_signer: false,
                    is_writable: true,
                }]),
                callback_args: Some(vec![chest, i as u8]),
            },
            PROGRAM_IDENTITY,
        );
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// VRF callback. Puts the loot in the opener's bag, or in their dropped bag if they
    /// died while the chest was opening.
    pub fn callback_open_chest(
        ctx: Context<CallbackOpenChest>,
        randomness: [u8; 32],
        chest: u8,
        seat: u8,
    ) -> Result<()> {
        let run = &mut ctx.accounts.run;
        let (c, i) = (chest as usize, seat as usize);
        require!(c < map::NUM_CHESTS && i < MAX_PLAYERS, DungeonError::BadChest);
        let tier = tier_for_roll(random_u8_with_range(&randomness, 1, 100));
        let pts = points_for_tier(tier);
        run.chests[c].state = ChestState::Opened as u8;
        run.chests[c].tier = tier;
        if run.players[i].alive {
            run.players[i].bag = run.players[i].bag.saturating_add(pts);
        } else {
            run.dropped[i].points = run.dropped[i].points.saturating_add(pts);
        }
        Ok(())
    }

    /// ER. Leave the dungeon from an extraction tile, keeping your bag.
    pub fn extract(ctx: Context<Act>) -> Result<()> {
        let run = &mut ctx.accounts.run;
        let i = acting_seat(run, &ctx.accounts.signer.key())?;
        let p = run.players[i];
        require!(map::is_extract(p.x, p.y), DungeonError::NotOnExtract);
        run.players[i].extracted = true;
        Ok(())
    }

    /// ER. Ends the run and commits + undelegates it to base. Allowed for the authority at
    /// any time, or for anyone once the clock has run out or every player is dead/extracted.
    /// Players still inside when it ends are trapped: their loot is lost.
    pub fn end_run(ctx: Context<EndRun>) -> Result<()> {
        let run = &mut ctx.accounts.run;
        require!(run.status == RunStatus::Live as u8, DungeonError::NotLive);
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.payer.key() == run.authority || now >= run.ends_at || run.all_resolved(),
            DungeonError::CannotEndYet
        );
        run.status = RunStatus::Ended as u8;
        run.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[run.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Base. Pays out from the vault. remaining_accounts = every seated wallet, in seat order.
    pub fn settle_run<'info>(ctx: Context<'info, SettleRun<'info>>) -> Result<()> {
        let run = &mut ctx.accounts.run;
        require!(run.status == RunStatus::Ended as u8, DungeonError::NotEnded);
        require!(!run.settled, DungeonError::AlreadySettled);
        let wallets = ctx.remaining_accounts;
        require!(wallets.len() == run.player_count as usize, DungeonError::WalletMismatch);

        let (shares, house) = run.payouts();
        let vault = ctx.accounts.vault.to_account_info();
        for (i, w) in wallets.iter().enumerate() {
            require_keys_eq!(w.key(), run.players[i].wallet, DungeonError::WalletMismatch);
            if shares[i] > 0 {
                vault.sub_lamports(shares[i])?;
                w.add_lamports(shares[i])?;
            }
        }
        if house > 0 {
            vault.sub_lamports(house)?;
            ctx.accounts.authority.add_lamports(house)?;
        }
        run.settled = true;
        emit!(RunSettled { run: run.key(), shares, house });
        Ok(())
    }
}

/// Common checks for an in-run action: the run is live, the clock hasn't run out, and the
/// signer is the session key of a player who is still on the board.
fn acting_seat(run: &Run, signer: &Pubkey) -> Result<usize> {
    require!(run.status == RunStatus::Live as u8, DungeonError::NotLive);
    require!(Clock::get()?.unix_timestamp < run.ends_at, DungeonError::TimeUp);
    let i = run.slot_of_signer(signer)?;
    require!(run.players[i].alive, DungeonError::Dead);
    require!(!run.players[i].extracted, DungeonError::Extracted);
    Ok(i)
}

#[event]
pub struct RunSettled {
    pub run: Pubkey,
    pub shares: [u64; MAX_PLAYERS],
    pub house: u64,
}

#[derive(Accounts)]
#[instruction(run_id: u64)]
pub struct CreateRun<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Run::INIT_SPACE,
        seeds = [RUN_SEED, authority.key().as_ref(), &run_id.to_le_bytes()],
        bump
    )]
    pub run: Account<'info, Run>,
    #[account(init, payer = authority, space = 8 + Vault::INIT_SPACE, seeds = [VAULT_SEED, run.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(session_signer: Pubkey)]
pub struct JoinRun<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut)]
    pub run: Account<'info, Run>,
    #[account(mut, seeds = [VAULT_SEED, run.key().as_ref()], bump = run.vault_bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: the session key being registered; only receives the VRF top-up.
    #[account(mut, address = session_signer)]
    pub session: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartRun<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub run: Account<'info, Run>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(run_id: u64)]
pub struct DelegateRun<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: the run PDA being delegated; seeds pin it to this authority + id.
    #[account(mut, del, seeds = [RUN_SEED, authority.key().as_ref(), &run_id.to_le_bytes()], bump)]
    pub run: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Act<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub run: Account<'info, Run>,
}

#[vrf]
#[derive(Accounts)]
pub struct OpenChest<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub run: Account<'info, Run>,
    /// CHECK: validated by the VRF program.
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
}

// We declare `vrf_program_identity` ourselves. Left to `#[vrf_callback]`, the SDK 0.18 macro
// puts `scoped_vrf_identity_const(&crate::ID)` inside the `address` constraint, which
// evaluates the software PDA derivation at runtime and blows the 200k CU budget.
// A `const` item forces it to compile time.
#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackOpenChest<'info> {
    #[account(address = VRF_CALLBACK_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub run: Account<'info, Run>,
}

#[commit]
#[derive(Accounts)]
pub struct EndRun<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub run: Account<'info, Run>,
}

#[derive(Accounts)]
pub struct SettleRun<'info> {
    /// Anyone can trigger settlement.
    pub caller: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub run: Account<'info, Run>,
    #[account(mut, seeds = [VAULT_SEED, run.key().as_ref()], bump = run.vault_bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: receives the house remainder; pinned by `has_one`.
    #[account(mut)]
    pub authority: UncheckedAccount<'info>,
}

#[error_code]
pub enum DungeonError {
    #[msg("Run is not in the lobby")]
    NotInLobby,
    #[msg("Run is not live")]
    NotLive,
    #[msg("Run is full")]
    RunFull,
    #[msg("Wallet already joined this run")]
    AlreadyJoined,
    #[msg("No players joined")]
    NoPlayers,
    #[msg("Signer is not a session key of any player")]
    UnknownSigner,
    #[msg("Player is dead")]
    Dead,
    #[msg("Player already extracted")]
    Extracted,
    #[msg("Direction must be 0..=3")]
    BadDirection,
    #[msg("Tile is blocked")]
    Blocked,
    #[msg("No player on that tile")]
    NoTarget,
    #[msg("Unknown chest")]
    BadChest,
    #[msg("Chest already opened or opening")]
    ChestUnavailable,
    #[msg("Chest is not adjacent")]
    NotAdjacent,
    #[msg("Not standing on an extraction tile")]
    NotOnExtract,
    #[msg("The run timer has run out")]
    TimeUp,
    #[msg("Run can't be ended yet")]
    CannotEndYet,
    #[msg("Run has not ended")]
    NotEnded,
    #[msg("Run already settled")]
    AlreadySettled,
    #[msg("Wallet accounts don't match the seats")]
    WalletMismatch,
    #[msg("Duration must be positive")]
    BadDuration,
    #[msg("Arithmetic overflow")]
    Overflow,
}
