//! End-to-end runs in MagicSVM (base layer + ER + VRF oracle + permission program).
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
    ephemeral_rollups_sdk::{
        access_control::structs::EphemeralPermission,
        consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    },
    extraction_dungeon::{
        accounts as acc, instruction as ixs,
        state::{Bag, ChestState, Run, ATTACK_COOLDOWN_SLOTS, SESSION_TOPUP, START_HP, TIER_COMMON, TIER_LEGENDARY, TIER_RARE},
        BAG_SEED, RUN_SEED, VAULT_SEED,
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

/// VRF bytes that make `random_u8_with_range(.., 1, 100)` land on a given roll.
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

    fn bag(&self, seat: usize) -> Pubkey {
        Pubkey::find_program_address(&[BAG_SEED, self.run.as_ref(), &[seat as u8]], &self.program).0
    }

    fn bags(&self) -> Vec<AccountMeta> {
        (0..self.sessions.len()).map(|i| AccountMeta::new(self.bag(i), false)).collect()
    }

    /// Reads a bag as its owner (the seat's session key), which is who the permission lets in.
    fn read_bag(&mut self, target: TransactionTarget, seat: usize) -> Bag {
        let owner = self.sessions[seat].pubkey();
        self.svm.set_authorized_user(Some(owner));
        let acct = self.svm.get_account_for(target, &as_address(self.bag(seat)));
        self.svm.set_authorized_user(None);
        Bag::try_deserialize(&mut acct.expect("bag readable by its owner").data.as_slice()).expect("decode Bag")
    }

    /// Whether `reader`'s session key can see `seat`'s bag on the ER.
    fn can_read_bag(&mut self, reader: usize, seat: usize) -> bool {
        let who = self.sessions[reader].pubkey();
        self.svm.set_authorized_user(Some(who));
        let seen = self.svm.get_account_for(Ephemeral, &as_address(self.bag(seat))).is_some();
        self.svm.set_authorized_user(None);
        seen
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

    /// join_run + delegate_bag in one transaction, as the client sends it.
    fn join_as(&mut self, wallet: &Keypair, session: &Keypair) -> Result<(), String> {
        let seat = self.state(Base).player_count;
        let bag = Pubkey::find_program_address(&[BAG_SEED, self.run.as_ref(), &[seat]], &self.program).0;
        let join = ix(self.program, ixs::JoinRun { session_signer: pk(session) }, acc::JoinRun {
            player: pk(wallet), run: self.run, vault: self.vault, session: pk(session), bag, system_program: system_program::ID,
        });
        let mut delegate = ix(self.program, ixs::DelegateBag { seat }, acc::DelegateBag {
            payer: pk(wallet),
            run: self.run,
            buffer_bag: delegate_buffer_pda_from_delegated_account_and_owner_program(&bag, &self.program),
            delegation_record_bag: delegation_record_pda_from_delegated_account(&bag),
            delegation_metadata_bag: delegation_metadata_pda_from_delegated_account(&bag),
            bag,
            owner_program: self.program,
            delegation_program: DelegationProgram::id(),
            system_program: system_program::ID,
        });
        delegate.accounts.push(AccountMeta::new_readonly(self.svm.validator_identity(), false));
        let tx = sign_tx(&[wallet], &[join, delegate], self.svm.latest_blockhash_for(Base));
        let r = self.svm.send_transaction_to(Base, tx).map(|_| ()).map_err(|f| format!("{:?} {:#?}", f.err, f.meta.logs));
        self.svm.expire_blockhash_for(Base);
        r
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

    /// start_run + delegate_run on base, then the permissions on the ER.
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

        let a = self.authority.insecure_clone();
        let run_perm = EphemeralPermission::find_pda(&self.run).0;
        self.send(Ephemeral, &[&a], ix(self.program, ixs::InitRunPermission {}, acc::InitRunPermission {
            signer: pk(&a), run: self.run, permission: run_perm,
            permission_program: PERMISSION_PROGRAM_ID, ephemeral_vault: EPHEMERAL_VAULT_ID, magic_program: MAGIC_PROGRAM_ID,
        })).expect("init_run_permission");
        for seat in 0..self.sessions.len() {
            self.init_bag_permission(seat).expect("init_bag_permission");
        }
    }

    fn init_bag_permission(&mut self, seat: usize) -> Result<(), String> {
        let s = self.sessions[seat].insecure_clone();
        let bag = self.bag(seat);
        self.send(Ephemeral, &[&s], ix(self.program, ixs::InitBagPermission { seat: seat as u8 }, acc::InitBagPermission {
            signer: pk(&s), run: self.run, bag, permission: EphemeralPermission::find_pda(&bag).0,
            permission_program: PERMISSION_PROGRAM_ID, ephemeral_vault: EPHEMERAL_VAULT_ID, magic_program: MAGIC_PROGRAM_ID,
        }))
    }

    fn act(&mut self, seat: usize, data: impl anchor_lang::InstructionData) -> Result<(), String> {
        let s = self.sessions[seat].insecure_clone();
        let mut i = ix(self.program, data, acc::Act { signer: pk(&s), run: self.run });
        i.accounts.extend(self.bags());
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

    /// Attack, then let the cooldown pass.
    fn hit_and_wait(&mut self, seat: usize, dir: u8) {
        self.hit(seat, dir).expect("attack");
        self.advance_slots(ATTACK_COOLDOWN_SLOTS);
    }

    fn advance_slots(&mut self, n: u64) {
        let slot = self.svm.get_sysvar::<Clock>().slot;
        for r in self.svm.warp_to_slot(slot + n) {
            r.expect("due work during warp");
        }
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
            bag: self.bag(seat),
            oracle_queue: DEFAULT_EPHEMERAL_QUEUE,
            program_identity,
            vrf_program: VRF_PROGRAM_ID,
            slot_hashes: SLOT_HASHES,
            system_program: system_program::ID,
        });
        self.send(Ephemeral, &[&s], i)?;
        assert_eq!(self.state(Ephemeral).chests[chest as usize].state, ChestState::Opening as u8);
        self.svm.set_vrf_randomness(Some(randomness_for_roll(roll)));
        self.advance_slots(1);
        Ok(())
    }

    fn end_as(&mut self, signer: &Keypair) -> Result<(), String> {
        let mut i = ix(self.program, ixs::EndRun {}, acc::EndRun {
            payer: pk(signer), run: self.run, magic_program: MagicProgram::id(), magic_context: MAGIC_CONTEXT_ID,
        });
        i.accounts.extend(self.bags());
        self.send(Ephemeral, &[signer], i)
    }

    fn settle(&mut self) -> Result<(), String> {
        let mut i = ix(self.program, ixs::SettleRun {}, acc::SettleRun {
            caller: pk(&self.authority), run: self.run, vault: self.vault, authority: pk(&self.authority),
        });
        for w in &self.wallets {
            i.accounts.push(AccountMeta::new(pk(w), false));
        }
        for b in self.bags() {
            i.accounts.push(AccountMeta::new_readonly(b.pubkey, false));
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
fn join_takes_stakes_creates_delegated_bags_and_enforces_seats() {
    let mut w = World::new(2);
    let run = w.state(Base);
    assert_eq!(run.player_count, 2);
    assert_eq!(run.pot, 2 * ENTRY);
    assert_eq!((run.players[0].x, run.players[0].y), (1, 1));
    assert_eq!((run.players[1].x, run.players[1].y), (10, 7));
    assert!(run.seated().iter().all(|p| p.alive && p.hp == START_HP));
    assert_eq!(balance(&w.svm, Base, pk(&w.sessions[0])), SESSION_TOPUP);
    // Each seat's bag exists and is already delegated to the ER.
    for seat in 0..2usize {
        assert!(is_delegated(&w.svm, &as_address(w.bag(seat))), "bag {seat} delegated at join");
        let b = w.read_bag(Ephemeral, seat);
        assert_eq!((b.seat as usize, b.points, b.run), (seat, 0, w.run));
    }

    let (wallet0, fresh) = (w.wallets[0].insecure_clone(), Keypair::new());
    assert!(w.join_as(&wallet0, &fresh).is_err(), "double join");
    w.join().unwrap();
    w.join().unwrap();
    assert!(w.join().is_err(), "5th player");
    assert_eq!(w.state(Base).pot, 4 * ENTRY);
}

#[test]
fn permissions_are_created_on_the_er_and_only_by_the_owner() {
    let mut w = World::new(2);
    // Seat 1's session key can't create seat 0's permission.
    w.start_without_permissions();
    let s1 = w.sessions[1].insecure_clone();
    let bag0 = w.bag(0);
    let bad = ix(w.program, ixs::InitBagPermission { seat: 0 }, acc::InitBagPermission {
        signer: pk(&s1), run: w.run, bag: bag0, permission: EphemeralPermission::find_pda(&bag0).0,
        permission_program: PERMISSION_PROGRAM_ID, ephemeral_vault: EPHEMERAL_VAULT_ID, magic_program: MAGIC_PROGRAM_ID,
    });
    assert!(w.send(Ephemeral, &[&s1], bad).is_err(), "only the owner's session key");
    for seat in 0..2 {
        w.init_bag_permission(seat).expect("owner creates permission");
        let perm = EphemeralPermission::find_pda(&w.bag(seat)).0;
        assert!(w.svm.get_account_for(Ephemeral, &as_address(perm)).is_some(), "permission {seat} exists on ER");
        w.init_bag_permission(seat).expect("idempotent");
    }
    // The point of it all: each player can read their own bag and nobody else's.
    assert!(w.can_read_bag(0, 0) && w.can_read_bag(1, 1), "owners can read their bags");
    assert!(!w.can_read_bag(0, 1) && !w.can_read_bag(1, 0), "opponents cannot read each other's bags");
    // The Run itself stays public.
    w.svm.set_authorized_user(Some(w.sessions[1].pubkey()));
    assert!(w.svm.get_account_for(Ephemeral, &as_address(w.run)).is_some(), "run is public");
    w.svm.set_authorized_user(None);
}

impl World {
    fn start_without_permissions(&mut self) {
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
    }
}

#[test]
fn movement_respects_walls_chests_players_and_session_keys() {
    let mut w = World::new(2);
    w.start();
    w.walk(0, &[RIGHT]);
    assert!(w.act(0, ixs::MovePlayer { dir: RIGHT }).is_err(), "chest blocks");
    assert!(w.act(0, ixs::MovePlayer { dir: UP }).is_err(), "outer wall blocks");
    assert!(w.act(0, ixs::MovePlayer { dir: DOWN }).is_err(), "inner wall (2,2) blocks");
    assert!(w.act(0, ixs::MovePlayer { dir: 9 }).is_err(), "bad direction");
    let stranger = Keypair::new();
    let i = ix(w.program, ixs::MovePlayer { dir: LEFT }, acc::Act { signer: pk(&stranger), run: w.run });
    assert!(w.send(Ephemeral, &[&stranger], i).is_err(), "stranger");
    assert!(w.extract(0).is_err());
    let er = w.state(Ephemeral);
    assert_eq!((er.players[0].x, er.players[0].y), (2, 1));
}

#[test]
fn chest_tiers_land_in_the_private_bag_not_the_run() {
    let mut w = World::new(1);
    w.start();
    assert!(w.open_chest(0, 0, 50).is_err(), "must be adjacent");
    w.walk(0, &[RIGHT]);
    w.open_chest(0, 0, 50).unwrap(); // common
    let run = w.state(Ephemeral);
    assert_eq!(run.chests[0].state, ChestState::Opened as u8);
    assert_eq!(run.chests[0].tier, 0, "tier is NOT public");
    let bag = w.read_bag(Ephemeral, 0);
    assert_eq!((bag.points, bag.last_tier), (1, TIER_COMMON));
    assert!(w.open_chest(0, 0, 50).is_err(), "can't reopen");

    w.walk(0, &[LEFT, DOWN, DOWN]);
    w.open_chest(0, 2, 99).unwrap(); // legendary
    let bag = w.read_bag(Ephemeral, 0);
    assert_eq!((bag.points, bag.last_tier), (9, TIER_LEGENDARY));
    assert_eq!(w.state(Ephemeral).chests[2].tier, 0);

    w.walk(0, &[RIGHT, RIGHT, RIGHT, RIGHT]);
    w.extract(0).unwrap();
    assert!(w.act(0, ixs::MovePlayer { dir: LEFT }).is_err(), "extracted players can't act");
}

#[test]
fn attacks_have_a_cooldown() {
    let mut w = World::new(2);
    w.start();
    w.walk(0, &[DOWN, DOWN, RIGHT, RIGHT, RIGHT]); // (4,3)
    w.walk(1, &[UP, UP, LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, UP]); // (4,4)
    w.hit(1, UP).expect("first hit");
    let e = w.hit(1, UP).expect_err("second hit inside the cooldown");
    assert!(e.contains("Custom(6022)"), "AttackCooldown, got {e}");
    w.advance_slots(ATTACK_COOLDOWN_SLOTS - 1);
    assert!(w.hit(1, UP).is_err(), "still cooling down one slot early");
    w.advance_slots(1);
    w.hit(1, UP).expect("cooldown over");
    assert_eq!(w.state(Ephemeral).players[0].hp, 1);
}

#[test]
fn death_drops_the_private_bag_killer_loots_it_extracts_and_takes_the_pot() {
    let mut w = World::new(2);
    w.start();
    w.walk(0, &[RIGHT]);
    w.open_chest(0, 0, 75).unwrap(); // rare: 3 pts
    assert_eq!(w.read_bag(Ephemeral, 0).last_tier, TIER_RARE);
    w.walk(0, &[LEFT, DOWN, DOWN, RIGHT, RIGHT, RIGHT]); // (4,3)
    w.walk(1, &[UP, UP, LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, UP]); // (4,4)
    assert!(w.act(1, ixs::MovePlayer { dir: UP }).is_err(), "players block each other");
    assert!(w.hit(1, LEFT).is_err(), "nobody there");

    w.hit_and_wait(1, UP);
    w.hit_and_wait(1, UP);
    w.hit_and_wait(1, UP);
    let s = w.state(Ephemeral);
    assert!(!s.players[0].alive);
    assert_eq!(s.players[1].kills, 1);
    let sack = s.dropped[0];
    assert!(sack.present && (sack.x, sack.y) == (4, 3));
    assert_eq!(sack.points, 0, "sack contents are NOT public");
    let victim = w.read_bag(Ephemeral, 0);
    assert_eq!((victim.points, victim.dropped), (0, 3), "the bag moved into the sack");

    let s1 = w.sessions[1].insecure_clone();
    assert!(w.end_as(&s1).is_err(), "seat 1 still active");

    w.walk(1, &[UP]); // onto the sack
    assert_eq!(w.read_bag(Ephemeral, 1).points, 3);
    assert_eq!(w.read_bag(Ephemeral, 0).dropped, 0);
    assert!(!w.state(Ephemeral).dropped[0].present);
    w.walk(1, &[RIGHT]);
    w.extract(1).unwrap();

    w.end_as(&s1).unwrap();
    assert!(!is_delegated(&w.svm, &as_address(w.run)));
    for seat in 0..2 {
        assert!(!is_delegated(&w.svm, &as_address(w.bag(seat))), "bag {seat} back on base");
    }
    assert_eq!(w.read_bag(Base, 1).points, 3, "bags are public after the run");

    let winner_before = balance(&w.svm, Base, pk(&w.wallets[1]));
    let vault_before = balance(&w.svm, Base, w.vault);
    w.settle().unwrap();
    assert_eq!(balance(&w.svm, Base, pk(&w.wallets[1])) - winner_before, 2 * ENTRY);
    assert_eq!(vault_before - balance(&w.svm, Base, w.vault), 2 * ENTRY);
    assert!(w.state(Base).settled);
    assert!(w.settle().is_err(), "no double settle");
}

#[test]
fn bags_cannot_be_swapped_between_seats() {
    let mut w = World::new(2);
    w.start();
    w.walk(0, &[RIGHT]);
    // Seat 0 tries to open a chest crediting seat 1's bag.
    let s = w.sessions[0].insecure_clone();
    let (program_identity, _) = Pubkey::find_program_address(&[b"identity"], &w.program);
    let i = ix(w.program, ixs::OpenChest { chest: 0 }, acc::OpenChest {
        payer: pk(&s), run: w.run, bag: w.bag(1), oracle_queue: DEFAULT_EPHEMERAL_QUEUE,
        program_identity, vrf_program: VRF_PROGRAM_ID, slot_hashes: SLOT_HASHES, system_program: system_program::ID,
    });
    assert!(w.send(Ephemeral, &[&s], i).is_err(), "wrong bag rejected");
    // End-run with bags in the wrong order is rejected too.
    let a = w.authority.insecure_clone();
    let mut end = ix(w.program, ixs::EndRun {}, acc::EndRun {
        payer: pk(&a), run: w.run, magic_program: MagicProgram::id(), magic_context: MAGIC_CONTEXT_ID,
    });
    end.accounts.push(AccountMeta::new(w.bag(1), false));
    end.accounts.push(AccountMeta::new(w.bag(0), false));
    assert!(w.send(Ephemeral, &[&a], end).is_err(), "bag order enforced");
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
    let gained = balance(&w.svm, Base, pk(&w.authority)) - house_before;
    assert!(gained > 2 * ENTRY - 10_000 && gained <= 2 * ENTRY, "house got {gained}");
}

#[test]
fn authority_can_end_early_and_extracted_players_split_by_points() {
    let mut w = World::new(3);
    w.start();
    w.walk(0, &[RIGHT]);
    w.open_chest(0, 0, 10).unwrap(); // common, 1
    w.walk(0, &[LEFT, DOWN, DOWN, RIGHT, RIGHT, RIGHT, RIGHT]);
    w.extract(0).unwrap();
    w.walk(1, &[LEFT]);
    w.open_chest(1, 5, 80).unwrap(); // rare, 3
    w.walk(1, &[RIGHT, UP, UP, LEFT, LEFT, LEFT, LEFT]);
    w.extract(1).unwrap();
    let auth = w.authority.insecure_clone();
    w.end_as(&auth).unwrap();
    let before: Vec<u64> = w.wallets.iter().map(|k| balance(&w.svm, Base, pk(k))).collect();
    w.settle().unwrap();
    let gained: Vec<u64> = w.wallets.iter().zip(&before).map(|(k, b)| balance(&w.svm, Base, pk(k)) - b).collect();
    assert_eq!(gained, vec![3 * ENTRY / 4, 9 * ENTRY / 4, 0]);
}
