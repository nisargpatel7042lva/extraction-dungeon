//! Extraction Dungeon: staked, real-time extraction runs on a MagicBlock Private Ephemeral Rollup.
//!
//! Accounts:
//!   Run  (public)   positions, HP, chests opened/closed, where sacks lie
//!   Bag  (private)  one per seat: loot points, sack contents, last chest tier.
//!                   Delegated to the TEE validator with a permission only that seat's
//!                   session key can read, so nobody sees what you carry until the run ends.
//!   Vault           stakes, never delegated
//!
//! Lifecycle:
//!   base:  create_run -> join_run + delegate_bag (x N) -> start_run + delegate_run
//!   ER:    init_bag_permission (each player), init_run_permission (public)
//!   ER:    move_player / attack (cooldown) / open_chest (VRF) / extract
//!   ER:    end_run -> commit + undelegate run and bags
//!   base:  settle_run -> vault pays extracted players by (now public) bag points

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::CreateEphemeralPermissionCpi,
        structs::{EphemeralMembersArgs, EphemeralPermission, Member, AUTHORITY_FLAG, PERMISSION_SEED, TX_LOGS_FLAG},
    },
    anchor::{commit, delegate, ephemeral, vrf, vrf_callback},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
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
pub const BAG_SEED: &[u8] = b"bag";
const PROGRAM_IDENTITY: Pubkey = program_identity_pubkey(&crate::ID);
const VRF_CALLBACK_IDENTITY: Pubkey =
    Pubkey::new_from_array(scoped_vrf_identity_const(&crate::ID).0);

fn permission_rent(members: usize) -> u64 {
    ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(members) as u32)
}

#[ephemeral]
#[program]
pub mod extraction_dungeon {
    use super::*;

    /// Base. Creates an empty lobby and its stake vault. The run PDA is pre-funded with rent for
    /// its (public) ephemeral permission, created on the TEE after delegation.
    pub fn create_run(
        ctx: Context<CreateRun>,
        run_id: u64,
        entry_lamports: u64,
        duration_secs: u32,
    ) -> Result<()> {
        require!(duration_secs > 0, DungeonError::BadDuration);
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer { from: ctx.accounts.authority.to_account_info(), to: ctx.accounts.run.to_account_info() },
            ),
            permission_rent(0),
        )?;
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

    /// Base. Seats the wallet, takes its stake into the vault, funds + registers the browser
    /// session key, and creates this seat's private Bag (pre-funded for its permission).
    pub fn join_run(ctx: Context<JoinRun>, session_signer: Pubkey) -> Result<()> {
        let n = ctx.accounts.run.player_count as usize;
        {
            let run = &ctx.accounts.run;
            require!(run.status == RunStatus::Lobby as u8, DungeonError::NotInLobby);
            require!(n < MAX_PLAYERS, DungeonError::RunFull);
            let wallet = ctx.accounts.player.key();
            require!(!run.seated().iter().any(|p| p.wallet == wallet), DungeonError::AlreadyJoined);
        }

        let sys = ctx.accounts.system_program.key();
        let from = ctx.accounts.player.to_account_info();
        let entry = ctx.accounts.run.entry_lamports;
        if entry > 0 {
            transfer(CpiContext::new(sys, Transfer { from: from.clone(), to: ctx.accounts.vault.to_account_info() }), entry)?;
        }
        transfer(CpiContext::new(sys, Transfer { from: from.clone(), to: ctx.accounts.session.to_account_info() }), SESSION_TOPUP)?;
        transfer(CpiContext::new(sys, Transfer { from, to: ctx.accounts.bag.to_account_info() }), permission_rent(1))?;

        let run_key = ctx.accounts.run.key();
        let bag = &mut ctx.accounts.bag;
        bag.run = run_key;
        bag.seat = n as u8;
        bag.bump = ctx.bumps.bag;

        let run = &mut ctx.accounts.run;
        if entry > 0 {
            run.pot = run.pot.checked_add(entry).ok_or(DungeonError::Overflow)?;
        }
        let (x, y) = map::SPAWNS[n];
        run.players[n] = PlayerSlot {
            wallet: ctx.accounts.player.key(),
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

    /// Base. Hands a seat's Bag to the (TEE) ER validator. Sent in the same tx as `join_run`.
    pub fn delegate_bag(ctx: Context<DelegateBag>, seat: u8) -> Result<()> {
        require!((seat as usize) < ctx.accounts.run.player_count as usize, DungeonError::BadSeat);
        let run_key = ctx.accounts.run.key();
        ctx.accounts.delegate_bag(
            &ctx.accounts.payer,
            &[BAG_SEED, run_key.as_ref(), &[seat]],
            DelegateConfig { validator: ctx.remaining_accounts.first().map(|a| a.key()), ..Default::default() },
        )?;
        Ok(())
    }

    /// ER. Makes a seat's Bag private: only that seat's session key can read it via the TEE.
    /// Idempotent. Paid from the rent the Bag was pre-funded with at join.
    pub fn init_bag_permission(ctx: Context<InitBagPermission>, seat: u8) -> Result<()> {
        let run = &ctx.accounts.run;
        require!((seat as usize) < run.player_count as usize, DungeonError::BadSeat);
        require_keys_eq!(run.players[seat as usize].signer, ctx.accounts.signer.key(), DungeonError::UnknownSigner);
        // Ephemeral accounts hold no lamports (rent sits in the ephemeral vault), so check data.
        if !ctx.accounts.permission.data_is_empty() {
            return Ok(());
        }
        let bag = &ctx.accounts.bag;
        let run_key = run.key();
        CreateEphemeralPermissionCpi {
            payer: bag.to_account_info(),
            permissioned_account: bag.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: true,
                members: vec![Member { flags: AUTHORITY_FLAG | TX_LOGS_FLAG, pubkey: ctx.accounts.signer.key() }],
            },
        }
        .invoke_signed(&[&[BAG_SEED, run_key.as_ref(), &[seat], &[bag.bump]]])?;
        Ok(())
    }

    /// ER. Gives the Run a public permission so every authenticated TEE client can read it.
    /// Idempotent; anyone can call it.
    pub fn init_run_permission(ctx: Context<InitRunPermission>) -> Result<()> {
        if !ctx.accounts.permission.data_is_empty() {
            return Ok(());
        }
        let run = &ctx.accounts.run;
        CreateEphemeralPermissionCpi {
            payer: run.to_account_info(),
            permissioned_account: run.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs { is_private: false, members: vec![] },
        }
        .invoke_signed(&[&[RUN_SEED, run.authority.as_ref(), &run.run_id.to_le_bytes(), &[run.bump]]])?;
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
            DelegateConfig { validator: ctx.remaining_accounts.first().map(|a| a.key()), ..Default::default() },
        )?;
        Ok(())
    }

    /// ER. One grid step. `dir`: 0 up, 1 right, 2 down, 3 left. Stepping onto sacks loots them.
    /// remaining_accounts: every seat's Bag, in seat order.
    pub fn move_player<'info>(ctx: Context<'info, Act<'info>>, dir: u8) -> Result<()> {
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
        run.players[i].extract_start_slot = 0; // moving cancels an extraction

        let sacks = run.sacks_at(nx, ny);
        if !sacks.is_empty() {
            let run_key = run.key();
            let mut mine = load_bag(ctx.remaining_accounts, &run_key, i)?;
            for j in sacks {
                let mut theirs = load_bag(ctx.remaining_accounts, &run_key, j)?;
                mine.points = mine.points.saturating_add(theirs.dropped);
                theirs.dropped = 0;
                theirs.exit(&crate::ID)?;
                run.dropped[j] = DroppedBag::default();
            }
            mine.exit(&crate::ID)?;
        }
        Ok(())
    }

    /// ER. Hits the active player on the adjacent tile in `dir` for 1 damage, at most once per
    /// ATTACK_COOLDOWN_SLOTS. A kill drops the victim's whole bag on their tile.
    /// remaining_accounts: every seat's Bag, in seat order.
    pub fn attack<'info>(ctx: Context<'info, Act<'info>>, dir: u8) -> Result<()> {
        let run = &mut ctx.accounts.run;
        let i = acting_seat(run, &ctx.accounts.signer.key())?;
        let slot = Clock::get()?.slot;
        let p = run.players[i];
        require!(
            p.last_attack_slot == 0 || slot >= p.last_attack_slot.saturating_add(ATTACK_COOLDOWN_SLOTS),
            DungeonError::AttackCooldown
        );
        let (tx, ty) = map::step(p.x, p.y, dir).ok_or(DungeonError::BadDirection)?;
        let t = run.active_at(tx, ty).ok_or(DungeonError::NoTarget)?;
        run.players[i].last_attack_slot = slot;
        run.players[i].extract_start_slot = 0; // attacking cancels your own extraction
        run.players[t].extract_start_slot = 0; // and a hit interrupts the target's
        run.players[t].hp = run.players[t].hp.saturating_sub(1);
        if run.players[t].hp == 0 {
            run.kill(t);
            run.players[i].kills = run.players[i].kills.saturating_add(1);
            let mut victim = load_bag(ctx.remaining_accounts, &run.key(), t)?;
            victim.dropped = victim.dropped.saturating_add(victim.points);
            victim.points = 0;
            victim.exit(&crate::ID)?;
        }
        Ok(())
    }

    /// ER. Starts opening an adjacent chest; VRF decides the tier in `callback_open_chest`.
    pub fn open_chest(ctx: Context<OpenChest>, chest: u8) -> Result<()> {
        let run_key = ctx.accounts.run.key();
        let i = {
            let run = &mut ctx.accounts.run;
            let i = acting_seat(run, &ctx.accounts.payer.key())?;
            require!(
                ctx.accounts.bag.run == run_key && ctx.accounts.bag.seat as usize == i,
                DungeonError::BadBag
            );
            let c = chest as usize;
            require!(c < map::NUM_CHESTS, DungeonError::BadChest);
            require!(run.chests[c].state == ChestState::Closed as u8, DungeonError::ChestUnavailable);
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
                accounts_metas: Some(vec![
                    SerializableAccountMeta { pubkey: run_key, is_signer: false, is_writable: true },
                    SerializableAccountMeta { pubkey: ctx.accounts.bag.key(), is_signer: false, is_writable: true },
                ]),
                callback_args: Some(vec![chest, i as u8]),
            },
            PROGRAM_IDENTITY,
        );
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// VRF callback. The tier goes into the opener's private Bag; the Run only learns "opened".
    /// Loot goes into the opener's bag, or their sack if they died while it was opening.
    pub fn callback_open_chest(
        ctx: Context<CallbackOpenChest>,
        randomness: [u8; 32],
        chest: u8,
        seat: u8,
    ) -> Result<()> {
        let run = &mut ctx.accounts.run;
        let bag = &mut ctx.accounts.bag;
        let (c, i) = (chest as usize, seat as usize);
        require!(c < map::NUM_CHESTS && i < MAX_PLAYERS, DungeonError::BadChest);
        require!(bag.run == run.key() && bag.seat == seat, DungeonError::BadBag);
        let roll = random_u8_with_range(&randomness, 1, 100);
        let tier = if c == map::VAULT { vault_tier_for_roll(roll) } else { tier_for_roll(roll) };
        let pts = points_for_tier(tier);
        run.chests[c].state = ChestState::Opened as u8;
        bag.last_tier = tier;
        if run.players[i].alive {
            bag.points = bag.points.saturating_add(pts);
        } else if run.dropped[i].present {
            bag.dropped = bag.dropped.saturating_add(pts);
        }
        Ok(())
    }

    /// ER. Starts channeling an extraction on an exit tile. Exits unlock a quarter of the way into
    /// the run. Moving, attacking or getting hit cancels it; everyone can see you channeling.
    pub fn start_extract(ctx: Context<Act>) -> Result<()> {
        let run = &mut ctx.accounts.run;
        let i = acting_seat(run, &ctx.accounts.signer.key())?;
        let p = run.players[i];
        require!(map::is_extract(p.x, p.y), DungeonError::NotOnExtract);
        require!(run.exits_open(Clock::get()?.unix_timestamp), DungeonError::ExitsLocked);
        run.players[i].extract_start_slot = Clock::get()?.slot.max(1);
        Ok(())
    }

    /// ER. Finishes a channeled extraction: you leave the dungeon with your bag.
    pub fn extract(ctx: Context<Act>) -> Result<()> {
        let run = &mut ctx.accounts.run;
        let i = acting_seat(run, &ctx.accounts.signer.key())?;
        let p = run.players[i];
        require!(map::is_extract(p.x, p.y), DungeonError::NotOnExtract);
        require!(p.extract_start_slot != 0, DungeonError::NotChanneling);
        require!(
            Clock::get()?.slot >= p.extract_start_slot.saturating_add(EXTRACT_CHANNEL_SLOTS),
            DungeonError::StillChanneling
        );
        run.players[i].extracted = true;
        run.players[i].extract_start_slot = 0;
        Ok(())
    }

    /// ER. Ends the run and commits + undelegates the run and every Bag to base. Allowed for the
    /// authority at any time, or for anyone once the clock has run out or everyone is resolved.
    /// remaining_accounts: every seat's Bag, in seat order.
    pub fn end_run<'info>(ctx: Context<'info, EndRun<'info>>) -> Result<()> {
        let run = &mut ctx.accounts.run;
        require!(run.status == RunStatus::Live as u8, DungeonError::NotLive);
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.payer.key() == run.authority || now >= run.ends_at || run.all_resolved(),
            DungeonError::CannotEndYet
        );
        let n = run.player_count as usize;
        require!(ctx.remaining_accounts.len() == n, DungeonError::BadBag);
        let run_key = run.key();
        for i in 0..n {
            load_bag(ctx.remaining_accounts, &run_key, i)?; // validates each one
        }
        run.status = RunStatus::Ended as u8;
        run.exit(&crate::ID)?;
        let mut to_commit = vec![run.to_account_info()];
        to_commit.extend(ctx.remaining_accounts.iter().cloned());
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&to_commit)
        .build_and_invoke()?;
        Ok(())
    }

    /// Base. Pays out from the vault by the (now public) bag points.
    /// remaining_accounts: every seated wallet in seat order, then every Bag in seat order.
    pub fn settle_run<'info>(ctx: Context<'info, SettleRun<'info>>) -> Result<()> {
        let run = &mut ctx.accounts.run;
        require!(run.status == RunStatus::Ended as u8, DungeonError::NotEnded);
        require!(!run.settled, DungeonError::AlreadySettled);
        let n = run.player_count as usize;
        let ras = ctx.remaining_accounts;
        require!(ras.len() == 2 * n, DungeonError::WalletMismatch);
        let (wallets, bags) = ras.split_at(n);

        let run_key = run.key();
        let mut points = [0u16; MAX_PLAYERS];
        for i in 0..n {
            points[i] = load_bag(bags, &run_key, i)?.points;
        }
        let (shares, house) = run.payouts(&points);
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
        emit!(RunSettled { run: run.key(), shares, house, points });
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

/// Loads seat `seat`'s Bag from a slice ordered by seat, checking it belongs to `run`.
/// (Account::try_from checks the owner, and only this program writes `run`/`seat`.)
fn load_bag<'info>(accounts: &'info [AccountInfo<'info>], run: &Pubkey, seat: usize) -> Result<Account<'info, Bag>> {
    let ai = accounts.get(seat).ok_or(DungeonError::BadBag)?;
    let bag: Account<'info, Bag> = Account::try_from(ai)?;
    require!(bag.run == *run && bag.seat as usize == seat, DungeonError::BadBag);
    Ok(bag)
}

#[event]
pub struct RunSettled {
    pub run: Pubkey,
    pub shares: [u64; MAX_PLAYERS],
    pub house: u64,
    pub points: [u16; MAX_PLAYERS],
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
    /// CHECK: the session key being registered; only receives the fee top-up.
    #[account(mut, address = session_signer)]
    pub session: UncheckedAccount<'info>,
    #[account(
        init,
        payer = player,
        space = 8 + Bag::INIT_SPACE,
        seeds = [BAG_SEED, run.key().as_ref(), &[run.player_count]],
        bump
    )]
    pub bag: Account<'info, Bag>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct DelegateBag<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub run: Account<'info, Run>,
    /// CHECK: the bag PDA being delegated; seeds pin it to this run + seat.
    #[account(mut, del, seeds = [BAG_SEED, run.key().as_ref(), &[seat]], bump)]
    pub bag: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct InitBagPermission<'info> {
    pub signer: Signer<'info>,
    pub run: Account<'info, Run>,
    #[account(mut, seeds = [BAG_SEED, run.key().as_ref(), &[seat]], bump = bag.bump)]
    pub bag: Account<'info, Bag>,
    /// CHECK: created by the permission program; seeds match its layout.
    #[account(mut, seeds = [PERMISSION_SEED, bag.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: verified by the magic program
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: Magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitRunPermission<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub run: Account<'info, Run>,
    /// CHECK: created by the permission program; seeds match its layout.
    #[account(mut, seeds = [PERMISSION_SEED, run.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: Permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: verified by the magic program
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: Magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
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
    pub bag: Account<'info, Bag>,
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
    #[account(mut)]
    pub bag: Account<'info, Bag>,
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
    #[msg("Attack is on cooldown")]
    AttackCooldown,
    #[msg("Unknown seat")]
    BadSeat,
    #[msg("Bag accounts don't match the seats")]
    BadBag,
    #[msg("Exits are still locked")]
    ExitsLocked,
    #[msg("Not extracting: stand on an exit and start extracting first")]
    NotChanneling,
    #[msg("Still extracting: hold still a moment longer")]
    StillChanneling,
}
