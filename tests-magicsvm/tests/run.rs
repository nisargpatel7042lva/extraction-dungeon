//! End-to-end runs in MagicSVM (base layer + ER + VRF oracle).
//!
//! Map reference (x right, y down), C = chest, E = extract, numbers = spawns:
//!   ############
//!   #0.C....C.2#     seat 0 (1,1), seat 2 (10,1)
//!   #.##....##.#
//!   #....E.....#     E (5,3)
//!   #C...##...C#
//!   #.....E....#     E (6,5)
//!   #.##....##.#
//!   #3.C....C.1#     seat 3 (1,7), seat 1 (10,7)
//!   ############

use {
    anchor_lang::{prelude::Pubkey, system_program, AccountDeserialize, Id},
    extraction_dungeon::{
        accounts as acc, instruction as ixs,
        state::{ChestState, Run, RunStatus, SESSION_TOPUP, START_HP, TIER_COMMON, TIER_LEGENDARY, TIER_RARE},
        RUN_SEED, VAULT_SEED,
    },
    magicsvm::{MagicSVM, TransactionTarget::{self, Base, Ephemeral}},
    solana_clock::Clock,
    solana_instruction::{AccountMeta, Instruction},
    solana_keypair::Keypair,
    solana_native_token::LAMPORTS_PER_SOL,
    solana_signer::Signer,
    test_utils::{
        as_address, as_pubkey, boot, client_ix,
        delegate_buffer_pda_from_delegated_account_and_owner_program,
        delegation_metadata_pda_from_delegated_account,
        delegation_record_pda_from_delegated_account, is_delegated, program_id_from_idl,
        send_ixs, sign_tx, DelegationProgram, MagicProgram, MAGIC_CONTEXT_ID,
    },
};

const VRF_PROGRAM_ID: Pubkey = Pubkey::from_str_const("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const DEFAULT_EPHEMERAL_QUEUE: Pubkey =
    Pubkey::from_str_const("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const SLOT_HASHES: Pubkey = Pubkey::from_str_const("SysvarS1otHashes111111111111111111111111111");

const UP: u8 = 0;
const RIGHT: u8 = 1;
const DOWN: u8 = 2;
const LEFT: u8 = 3;

const ENTRY: u64 = LAMPORTS_PER_SOL / 10;
const DURATION: u32 = 90;
const T0: i64 = 1_800_000_000;

/// VRF bytes that make `random_u8_with_range(.., 1, 100)` land on a given roll:
/// every byte `b` < 200 maps to `1 + b % 100`.
fn randomness_for_roll(roll: u8) -> [u8; 32] {
    [roll - 1; 32]
}

struct World {
    svm: MagicSVM,
    program: Pubkey,
    authority: Keypair,
    wallets: Vec<Keypair>,
    sessions: Vec<Keypair>,
    run: Pubkey,
    vault: Pubkey,
    run_id: u64,
}

fn ix(program: Pubkey, data: impl anchor_lang::InstructionData, accounts: impl anchor_lang::ToAccountMetas) -> Instruction {
    client_ix(as_address(program), data, accounts)
}

fn pk(k: &Keypair) -> Pubkey {
    as_pubkey(&k.pubkey())
}

fn balance(svm: &MagicSVM, target: TransactionTarget, key: Pubkey) -> u64 {
    svm.get_account_for(target, &as_address(key)).map(|a| a.lamports).unwrap_or(0)
}

impl World {
    fn new(players: usize) -> Self {
        let authority = Keypair::new();
        let program = as_pubkey(&program_id_from_idl(env!("CARGO_MANIFEST_DIR"), "extraction_dungeon.json"));
        let mut svm = boot(env!("CARGO_MANIFEST_DIR"), "extraction_dungeon", as_address(program), &authority, 10 * LAMPORTS_PER_SOL);
        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = T0;
        svm.set_sysvar(&clock);

        let run_id = 7u64;
        let (run, _) = Pubkey::find_program_address(&[RUN_SEED, pk(&authority).as_ref(), &run_id.to_le_bytes()], &program);
        let (vault, _) = Pubkey::find_program_address(&[VAULT_SEED, run.as_ref()], &program);
        let create = ix(program, ixs::CreateRun { run_id, entry_lamports: ENTRY, duration_secs: DURATION }, acc::CreateRun {
            authority: pk(&authority), run, vault, system_program: system_program::ID,
        });
        send_ixs(&mut svm, Base, &[&authority], [create], "create_run");

        let mut w = World { svm, program, authority, wallets: vec![], sessions: vec![], run, vault, run_id };
        for _ in 0..players {
            w.join().expect("join");
        }
        w
    }

    fn join(&mut self) -> Result<(), String> {
        let wallet = Keypair::new();
        let session = Keypair::new();
        self.svm.airdrop(&wallet.pubkey(), LAMPORTS_PER_SOL).unwrap();
        let r = self.join_as(&wallet, &session);
        if r.is_ok() {
            self.wallets.push(wallet);
            self.sessions.push(session);
        }
        r
    }

    fn join_as(&mut self, wallet: &Keypair, session: &Keypair) -> Result<(), String> {
        let join = ix(self.program, ixs::JoinRun { session_signer: pk(session) }, acc::JoinRun {
            player: pk(wallet), run: self.run, vault: self.vault, session: pk(session), system_program: system_program::ID,
        });
        self.send(Base, &[wallet], join)
    }

    fn send(&mut self, target: TransactionTarget, signers: &[&Keypair], i: Instruction) -> Result<(), String> {
        let tx = sign_tx(signers, &[i], self.svm.latest_blockhash_for(target));
        let r = self.svm.send_transaction_to(target, tx).map(|_| ()).map_err(|f| format!("{:?} {:#?}", f.err, f.meta.logs));
        self.svm.expire_blockhash_for(target);
        r
    }

    fn state(&self, target: TransactionTarget) -> Run {
        let data = self.svm.get_account_for(target, &as_address(self.run)).expect("run").data;
        Run::try_deserialize(&mut data.as_slice()).expect("decode Run")
    }

    /// start_run + delegate_run in one base-layer transaction.
    fn start(&mut self) {
        let auth = pk(&self.authority);
        let start = ix(self.program, ixs::StartRun {}, acc::StartRun { authority: auth, run: self.run });
        let mut delegate = ix(self.program, ixs::DelegateRun { run_id: self.run_id }, acc::DelegateRun {
            authority: auth,
            buffer_run: delegate_buffer_pda_from_delegated_account_and_owner_program(&self.run, &self.program),
            delegation_record_run: delegation_record_pda_from_delegated_account(&self.run),
            delegation_metadata_run: delegation_metadata_pda_from_delegated_account(&self.run),
            run: self.run,
            owner_program: self.program,
            delegation_program: DelegationProgram::id(),
            system_program: system_program::ID,
        });
        delegate.accounts.push(AccountMeta::new_readonly(self.svm.validator_identity(), false));
        send_ixs(&mut self.svm, Base, &[&self.authority], [start, delegate], "start+delegate");
        assert!(is_delegated(&self.svm, &as_address(self.run)));
    }

    fn act(&mut self, seat: usize, data: impl anchor_lang::InstructionData) -> Result<(), String> {
        let s = self.sessions[seat].insecure_clone();
        let i = ix(self.program, data, acc::Act { signer: pk(&s), run: self.run });
        self.send(Ephemeral, &[&s], i)
    }

    fn walk(&mut self, seat: usize, dirs: &[u8]) {
        for &d in dirs {
            self.act(seat, ixs::MovePlayer { dir: d }).unwrap_or_else(|e| panic!("seat {seat} move {d}: {e}"));
        }
    }

    fn hit(&mut self, seat: usize, dir: u8) -> Result<(), String> {
        self.act(seat, ixs::Attack { dir })
    }

    fn extract(&mut self, seat: usize) -> Result<(), String> {
        self.act(seat, ixs::Extract {})
    }

    /// Opens `chest` as `seat` (session key pays VRF), then fulfills it with a forced roll.
    fn open_chest(&mut self, seat: usize, chest: u8, roll: u8) -> Result<(), String> {
        let s = self.sessions[seat].insecure_clone();
        let (program_identity, _) = Pubkey::find_program_address(&[b"identity"], &self.program);
        let i = ix(self.program, ixs::OpenChest { chest }, acc::OpenChest {
            payer: pk(&s),
            run: self.run,
            oracle_queue: DEFAULT_EPHEMERAL_QUEUE,
            program_identity,
            vrf_program: VRF_PROGRAM_ID,
            slot_hashes: SLOT_HASHES,
            system_program: system_program::ID,
        });
        self.send(Ephemeral, &[&s], i)?;
        assert_eq!(self.state(Ephemeral).chests[chest as usize].state, ChestState::Opening as u8);
        self.svm.set_vrf_randomness(Some(randomness_for_roll(roll)));
        self.fulfill();
        Ok(())
    }

    fn fulfill(&mut self) {
        let slot = self.svm.get_sysvar::<Clock>().slot;
        for r in self.svm.warp_to_slot(slot + 1) {
            if let Err(f) = r {
                panic!("VRF callback failed: {:?}\n{:#?}", f.err, f.meta.logs);
            }
        }
    }

    fn end_as(&mut self, signer: &Keypair) -> Result<(), String> {
        let i = ix(self.program, ixs::EndRun {}, acc::EndRun {
            payer: pk(signer), run: self.run, magic_program: MagicProgram::id(), magic_context: MAGIC_CONTEXT_ID,
        });
        self.send(Ephemeral, &[signer], i)
    }

    fn settle(&mut self) -> Result<(), String> {
        let mut i = ix(self.program, ixs::SettleRun {}, acc::SettleRun {
            caller: pk(&self.authority), run: self.run, vault: self.vault, authority: pk(&self.authority),
        });
        for w in &self.wallets {
            i.accounts.push(AccountMeta::new(pk(w), false));
        }
        let a = self.authority.insecure_clone();
        self.send(Base, &[&a], i)
    }

    fn warp_seconds(&mut self, secs: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp += secs;
        self.svm.set_sysvar(&clock);
    }
}

#[test]
fn join_takes_stakes_funds_session_keys_and_enforces_seats() {
    let mut w = World::new(2);
    let run = w.state(Base);
    assert_eq!(run.player_count, 2);
    assert_eq!(run.pot, 2 * ENTRY);
    assert_eq!((run.players[0].x, run.players[0].y), (1, 1));
    assert_eq!((run.players[1].x, run.players[1].y), (10, 7));
    assert!(run.seated().iter().all(|p| p.alive && p.hp == START_HP && p.bag == 0));
    assert_eq!(balance(&w.svm, Base, pk(&w.sessions[0])), SESSION_TOPUP);

    // Vault holds rent + both stakes.
    let rent_only = balance(&w.svm, Base, w.vault) - 2 * ENTRY;
    assert!(rent_only > 0 && rent_only < 2_000_000, "vault rent {rent_only}");

    // Same wallet twice is rejected.
    let (wallet0, fresh) = (w.wallets[0].insecure_clone(), Keypair::new());
    assert!(w.join_as(&wallet0, &fresh).is_err(), "double join");
    // Fills at 4, the 5th is rejected.
    w.join().unwrap();
    w.join().unwrap();
    assert!(w.join().is_err(), "5th player");
    assert_eq!(w.state(Base).pot, 4 * ENTRY);
}

#[test]
fn movement_respects_walls_chests_players_and_session_keys() {
    let mut w = World::new(2);
    w.start();
    // Seat 0: (1,1) -> right to (2,1). The chest at (3,1) blocks further right.
    w.walk(0, &[RIGHT]);
    assert!(w.act(0, ixs::MovePlayer { dir: RIGHT }).is_err(), "chest blocks");
    assert!(w.act(0, ixs::MovePlayer { dir: UP }).is_err(), "outer wall blocks");
    assert!(w.act(0, ixs::MovePlayer { dir: DOWN }).is_err(), "inner wall (2,2) blocks");
    assert!(w.act(0, ixs::MovePlayer { dir: 9 }).is_err(), "bad direction");

    // A key that isn't a registered session can't act.
    let stranger = Keypair::new();
    let i = ix(w.program, ixs::MovePlayer { dir: LEFT }, acc::Act { signer: pk(&stranger), run: w.run });
    assert!(w.send(Ephemeral, &[&stranger], i).is_err(), "stranger");

    // Not on an extract tile.
    assert!(w.extract(0).is_err());

    let er = w.state(Ephemeral);
    assert_eq!((er.players[0].x, er.players[0].y), (2, 1));
    assert_eq!((w.state(Base).players[0].x, w.state(Base).players[0].y), (1, 1), "base untouched until commit");
}

#[test]
fn chests_roll_tiers_with_vrf_paid_by_the_session_key() {
    let mut w = World::new(1);
    w.start();
    let before = balance(&w.svm, Ephemeral, pk(&w.sessions[0]));

    // Not adjacent yet.
    assert!(w.open_chest(0, 0, 50).is_err(), "must be adjacent");

    w.walk(0, &[RIGHT]); // (2,1), next to chest 0 at (3,1)
    w.open_chest(0, 0, 50).unwrap(); // roll 50 -> common
    let run = w.state(Ephemeral);
    assert_eq!(run.chests[0].state, ChestState::Opened as u8);
    assert_eq!(run.chests[0].tier, TIER_COMMON);
    assert_eq!(run.players[0].bag, 1);
    assert!(w.open_chest(0, 0, 50).is_err(), "can't reopen");

    w.walk(0, &[LEFT, DOWN, DOWN]); // (1,3), next to chest 2 at (1,4)
    w.open_chest(0, 2, 99).unwrap(); // legendary
    let run = w.state(Ephemeral);
    assert_eq!(run.chests[2].tier, TIER_LEGENDARY);
    assert_eq!(run.players[0].bag, 9);

    let after = balance(&w.svm, Ephemeral, pk(&w.sessions[0]));
    // Observation, not a rule: MagicSVM charges nothing for VRF on the ephemeral queue.
    // Devnet will tell us whether SESSION_TOPUP is actually needed.
    println!("session key paid {} lamports for 2 VRF requests on the ER", before - after);
    assert!(after <= before);

    // Walk to extract (5,3) and leave.
    w.walk(0, &[RIGHT, RIGHT, RIGHT, RIGHT]);
    w.extract(0).unwrap();
    assert!(w.act(0, ixs::MovePlayer { dir: LEFT }).is_err(), "extracted players can't act");
    assert!(w.state(Ephemeral).players[0].extracted);
}

#[test]
fn death_drops_the_bag_killer_loots_it_extracts_and_takes_the_pot() {
    let mut w = World::new(2);
    w.start();
    // Seat 0 loots a rare chest, then heads toward the middle: (4,3).
    w.walk(0, &[RIGHT]);
    w.open_chest(0, 0, 75).unwrap(); // rare: 3 pts
    assert_eq!(w.state(Ephemeral).chests[0].tier, TIER_RARE);
    w.walk(0, &[LEFT, DOWN, DOWN, RIGHT, RIGHT, RIGHT]); // (4,3)

    // Seat 1 comes from (10,7) to (4,4), right under seat 0.
    w.walk(1, &[UP, UP, LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, UP]);
    let s = w.state(Ephemeral);
    assert_eq!((s.players[0].x, s.players[0].y), (4, 3));
    assert_eq!((s.players[1].x, s.players[1].y), (4, 4));
    assert!(w.act(1, ixs::MovePlayer { dir: UP }).is_err(), "players block each other");
    assert!(w.hit(1, LEFT).is_err(), "nobody there");

    // Three hits kill.
    w.hit(1, UP).unwrap();
    w.hit(1, UP).unwrap();
    assert_eq!(w.state(Ephemeral).players[0].hp, 1);
    w.hit(1, UP).unwrap();
    let s = w.state(Ephemeral);
    assert!(!s.players[0].alive);
    assert_eq!(s.players[0].bag, 0);
    assert_eq!(s.players[1].kills, 1);
    let bag = s.dropped[0];
    assert!(bag.present && (bag.x, bag.y, bag.points) == (4, 3, 3));
    assert!(w.act(0, ixs::MovePlayer { dir: RIGHT }).is_err(), "dead can't move");

    // The run can't be ended early by a player while someone is still in.
    let s1 = w.sessions[1].insecure_clone();
    assert!(w.end_as(&s1).is_err(), "seat 1 still active");

    // Seat 1 steps onto the bag (now walkable), loots it, extracts at (5,3).
    w.walk(1, &[UP]);
    let s = w.state(Ephemeral);
    assert_eq!(s.players[1].bag, 3);
    assert!(!s.dropped[0].present);
    w.walk(1, &[RIGHT]);
    w.extract(1).unwrap();

    // Everyone resolved: any player may end the run.
    w.end_as(&s1).unwrap();
    assert!(!is_delegated(&w.svm, &as_address(w.run)));
    let base = w.state(Base);
    assert_eq!(base.status, RunStatus::Ended as u8);
    assert!(base.players[1].extracted && base.players[1].bag == 3);

    let winner_before = balance(&w.svm, Base, pk(&w.wallets[1]));
    let loser_before = balance(&w.svm, Base, pk(&w.wallets[0]));
    let vault_before = balance(&w.svm, Base, w.vault);
    w.settle().unwrap();
    assert_eq!(balance(&w.svm, Base, pk(&w.wallets[1])) - winner_before, 2 * ENTRY, "winner takes the pot");
    assert_eq!(balance(&w.svm, Base, pk(&w.wallets[0])), loser_before);
    assert_eq!(vault_before - balance(&w.svm, Base, w.vault), 2 * ENTRY);
    assert!(w.state(Base).settled);
    assert!(w.settle().is_err(), "no double settle");
}

#[test]
fn timer_runs_out_trapping_players_and_the_pot_goes_to_the_house() {
    let mut w = World::new(2);
    w.start();
    w.walk(0, &[RIGHT]);
    let s0 = w.sessions[0].insecure_clone();
    assert!(w.end_as(&s0).is_err(), "too early for a player to end it");
    assert!(w.settle().is_err(), "can't settle a live run");

    w.warp_seconds(DURATION as i64);
    assert!(w.act(0, ixs::MovePlayer { dir: LEFT }).is_err(), "time is up");
    w.end_as(&s0).unwrap();

    let house_before = balance(&w.svm, Base, pk(&w.authority));
    w.settle().unwrap();
    let base = w.state(Base);
    assert!(base.seated().iter().all(|p| !p.extracted), "both trapped");
    // The authority signed (and paid the fee for) settle, so compare with fee slack.
    let gained = balance(&w.svm, Base, pk(&w.authority)) - house_before;
    assert!(gained > 2 * ENTRY - 10_000 && gained <= 2 * ENTRY, "house got {gained}");
}

#[test]
fn authority_can_end_early_and_extracted_players_split_by_points() {
    let mut w = World::new(3);
    w.start();
    // Seat 0: common chest (1 pt), extract at (5,3).
    w.walk(0, &[RIGHT]);
    w.open_chest(0, 0, 10).unwrap();
    w.walk(0, &[LEFT, DOWN, DOWN, RIGHT, RIGHT, RIGHT, RIGHT]);
    w.extract(0).unwrap();
    // Seat 1: rare chest 5 at (8,7) from (9,7) (3 pts), extract at (6,5).
    w.walk(1, &[LEFT]);
    w.open_chest(1, 5, 80).unwrap();
    w.walk(1, &[RIGHT, UP, UP, LEFT, LEFT, LEFT, LEFT]); // (9,7)->(10,7)->(10,5)->(6,5)
    w.extract(1).unwrap();
    // Seat 2 idles and gets trapped.

    let auth = w.authority.insecure_clone();
    w.end_as(&auth).unwrap();
    let before: Vec<u64> = w.wallets.iter().map(|k| balance(&w.svm, Base, pk(k))).collect();
    w.settle().unwrap();
    let gained: Vec<u64> = w.wallets.iter().zip(&before).map(|(k, b)| balance(&w.svm, Base, pk(k)) - b).collect();
    // Pot = 0.3 SOL split 1:3 between seats 0 and 1.
    assert_eq!(gained, vec![3 * ENTRY / 4, 9 * ENTRY / 4, 0]);
}
