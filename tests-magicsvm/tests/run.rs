//! End-to-end runs in MagicSVM (base layer + ER + VRF oracle + permission program).
//! Players are routed with a BFS over the real map (`walk_to`), so tests don't hard-code paths.

use {
    anchor_lang::{prelude::Pubkey, system_program, AccountDeserialize, Id},
    ephemeral_rollups_sdk::{
        access_control::structs::EphemeralPermission,
        consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    },
    extraction_dungeon::{
        accounts as acc, instruction as ixs, map,
        state::{
            Bag, ChestState, Run, ATTACK_COOLDOWN_SLOTS, EXTRACT_CHANNEL_SLOTS, SESSION_TOPUP, START_HP, TIER_COMMON,
            TIER_LEGENDARY, TIER_RARE,
        },
        BAG_SEED, RUN_SEED, VAULT_SEED,
    },
    magicsvm::{MagicSVM, TransactionTarget::{self, Base, Ephemeral}},
    solana_clock::Clock,
    solana_instruction::{AccountMeta, Instruction},
    solana_keypair::Keypair,
    solana_native_token::LAMPORTS_PER_SOL,
    solana_signer::Signer,
    std::collections::VecDeque,
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
const DOWN: u8 = 2;
const LEFT: u8 = 3;

const ENTRY: u64 = LAMPORTS_PER_SOL / 10;
const DURATION: u32 = 120;
const T0: i64 = 1_800_000_000;
/// Exits unlock once a quarter of the run has passed.
const UNLOCK_AFTER: i64 = DURATION as i64 / 4;

/// VRF bytes that make `random_u8_with_range(.., 1, 100)` land on a given roll.
fn randomness_for_roll(roll: u8) -> [u8; 32] {
    [roll - 1; 32]
}

/// BFS from `from` to any tile in `goals`, avoiding walls, chests and `blocked`. Returns directions.
fn route(from: (u8, u8), goals: &[(u8, u8)], blocked: &[(u8, u8)]) -> Vec<u8> {
    let (w, h) = (map::W as usize, map::H as usize);
    let mut prev: Vec<Option<((u8, u8), u8)>> = vec![None; w * h];
    let mut seen = vec![false; w * h];
    let idx = |(x, y): (u8, u8)| y as usize * w + x as usize;
    let mut q = VecDeque::from([from]);
    seen[idx(from)] = true;
    while let Some(cur) = q.pop_front() {
        if goals.contains(&cur) {
            let mut dirs = vec![];
            let mut at = cur;
            while let Some((p, d)) = prev[idx(at)] {
                dirs.push(d);
                at = p;
            }
            dirs.reverse();
            return dirs;
        }
        for d in 0..4u8 {
            if let Some(n) = map::step(cur.0, cur.1, d) {
                if map::is_wall(n.0, n.1) || map::is_chest(n.0, n.1) || blocked.contains(&n) || seen[idx(n)] {
                    continue;
                }
                seen[idx(n)] = true;
                prev[idx(n)] = Some((cur, d));
                q.push_back(n);
            }
        }
    }
    panic!("no route from {from:?} to {goals:?}");
}

/// Tiles next to a chest, and the direction from each tile into the chest.
fn chest_sides(chest: usize) -> Vec<((u8, u8), u8)> {
    let (cx, cy) = map::CHESTS[chest];
    (0..4u8)
        .filter_map(|d| {
            let from = map::step(cx, cy, d)?; // tile on side `d` of the chest
            let back = (d + 2) % 4; // direction from that tile into the chest
            (!map::is_wall(from.0, from.1) && !map::is_chest(from.0, from.1)).then_some((from, back))
        })
        .collect()
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
        assert!(is_delegated(&self.svm, &as_address(self.run)));
    }

    /// start_run + delegate_run on base, then the permissions on the ER.
    fn start(&mut self) {
        self.start_without_permissions();
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

    fn pos(&self, seat: usize) -> (u8, u8) {
        let p = self.state(Ephemeral).players[seat];
        (p.x, p.y)
    }

    fn others(&self, seat: usize) -> Vec<(u8, u8)> {
        let s = self.state(Ephemeral);
        s.seated().iter().enumerate().filter(|(i, p)| *i != seat && p.active()).map(|(_, p)| (p.x, p.y)).collect()
    }

    fn walk(&mut self, seat: usize, dirs: &[u8]) {
        for &d in dirs {
            self.act(seat, ixs::MovePlayer { dir: d }).unwrap_or_else(|e| panic!("seat {seat} move {d}: {e}"));
        }
    }

    /// Walks `seat` to tile `to` along a BFS route around walls, chests and other players.
    fn walk_to(&mut self, seat: usize, to: (u8, u8)) {
        let dirs = route(self.pos(seat), &[to], &self.others(seat));
        self.walk(seat, &dirs);
        assert_eq!(self.pos(seat), to);
    }

    /// Walks next to `chest`; returns the direction into it.
    fn walk_to_chest(&mut self, seat: usize, chest: usize) -> u8 {
        let sides = chest_sides(chest);
        let goals: Vec<_> = sides.iter().map(|(t, _)| *t).collect();
        let dirs = route(self.pos(seat), &goals, &self.others(seat));
        self.walk(seat, &dirs);
        let here = self.pos(seat);
        sides.iter().find(|(t, _)| *t == here).unwrap().1
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

    fn warp_seconds(&mut self, secs: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp += secs;
        self.svm.set_sysvar(&clock);
    }

    fn unlock_exits(&mut self) {
        self.warp_seconds(UNLOCK_AFTER);
    }

    /// Full channeled extraction from wherever `seat` stands (must be an exit, exits unlocked).
    fn extract(&mut self, seat: usize) -> Result<(), String> {
        self.act(seat, ixs::StartExtract {})?;
        self.advance_slots(EXTRACT_CHANNEL_SLOTS);
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

    fn loot(&mut self, seat: usize, chest: usize, roll: u8) {
        self.walk_to_chest(seat, chest);
        self.open_chest(seat, chest as u8, roll).expect("open chest");
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
}

fn err_code(e: &str, code: u32) -> bool {
    e.contains(&format!("Custom({code})"))
}
// Error codes (6000 + enum index).
const ATTACK_COOLDOWN: u32 = 6022;
const EXITS_LOCKED: u32 = 6025;
const NOT_CHANNELING: u32 = 6026;
const STILL_CHANNELING: u32 = 6027;

#[test]
fn join_takes_stakes_creates_delegated_bags_and_enforces_seats() {
    let mut w = World::new(2);
    let run = w.state(Base);
    assert_eq!(run.player_count, 2);
    assert_eq!(run.pot, 2 * ENTRY);
    assert_eq!((run.players[0].x, run.players[0].y), map::SPAWNS[0]);
    assert_eq!((run.players[1].x, run.players[1].y), map::SPAWNS[1]);
    assert!(run.seated().iter().all(|p| p.alive && p.hp == START_HP));
    assert_eq!(balance(&w.svm, Base, pk(&w.sessions[0])), SESSION_TOPUP);
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
}

#[test]
fn permissions_are_created_on_the_er_and_only_by_the_owner() {
    let mut w = World::new(2);
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
        w.init_bag_permission(seat).expect("idempotent");
    }
    assert!(w.can_read_bag(0, 0) && w.can_read_bag(1, 1), "owners can read their bags");
    assert!(!w.can_read_bag(0, 1) && !w.can_read_bag(1, 0), "opponents cannot read each other's bags");
}

#[test]
fn movement_respects_walls_chests_players_and_session_keys() {
    let mut w = World::new(2);
    w.start();
    // Seat 0 at (1,1): the wall above, and the chest at (3,1) two steps right.
    assert!(w.act(0, ixs::MovePlayer { dir: UP }).is_err(), "outer wall blocks");
    assert!(w.act(0, ixs::MovePlayer { dir: LEFT }).is_err(), "outer wall blocks");
    assert!(w.act(0, ixs::MovePlayer { dir: 9 }).is_err(), "bad direction");
    w.walk_to(0, (2, 1));
    assert!(w.act(0, ixs::MovePlayer { dir: 1 }).is_err(), "chest blocks");
    let stranger = Keypair::new();
    let i = ix(w.program, ixs::MovePlayer { dir: DOWN }, acc::Act { signer: pk(&stranger), run: w.run });
    assert!(w.send(Ephemeral, &[&stranger], i).is_err(), "stranger");
    // A long BFS walk across the new map lands exactly where planned.
    w.walk_to(0, (9, 9));
    assert_eq!(w.pos(0), (9, 9));
}

#[test]
fn chest_tiers_land_in_the_private_bag_not_the_run() {
    let mut w = World::new(1);
    w.start();
    assert!(w.open_chest(0, 0, 50).is_err(), "must be adjacent");
    w.loot(0, 0, 50); // common
    let run = w.state(Ephemeral);
    assert_eq!(run.chests[0].state, ChestState::Opened as u8);
    assert_eq!(run.chests[0].tier, 0, "tier is NOT public");
    let bag = w.read_bag(Ephemeral, 0);
    assert_eq!((bag.points, bag.last_tier), (1, TIER_COMMON));
    assert!(w.open_chest(0, 0, 50).is_err(), "can't reopen");
    w.loot(0, 8, 99); // the (1,6) chest, legendary
    assert_eq!(w.read_bag(Ephemeral, 0).points, 9);
}

#[test]
fn the_vault_never_rolls_common() {
    let mut w = World::new(1);
    w.start();
    w.loot(0, map::VAULT, 10); // a roll that would be common anywhere else
    let bag = w.read_bag(Ephemeral, 0);
    assert_eq!((bag.points, bag.last_tier), (3, TIER_RARE), "vault rolls rare at worst");
    let mut w = World::new(1);
    w.start();
    w.loot(0, map::VAULT, 90);
    assert_eq!(w.read_bag(Ephemeral, 0).last_tier, TIER_LEGENDARY);
}

#[test]
fn exits_are_locked_for_the_first_quarter_of_the_run() {
    let mut w = World::new(1);
    w.start();
    w.walk_to(0, map::EXTRACTS[2]); // (9,1)
    let e = w.act(0, ixs::StartExtract {}).expect_err("locked early");
    assert!(err_code(&e, EXITS_LOCKED), "{e}");
    w.unlock_exits();
    w.extract(0).expect("unlocked");
    assert!(w.state(Ephemeral).players[0].extracted);
}

#[test]
fn extraction_is_channeled_and_cancelled_by_moving() {
    let mut w = World::new(1);
    w.start();
    w.unlock_exits();
    w.walk_to(0, map::EXTRACTS[2]);
    let e = w.act(0, ixs::Extract {}).expect_err("must start first");
    assert!(err_code(&e, NOT_CHANNELING), "{e}");
    w.act(0, ixs::StartExtract {}).unwrap();
    assert_ne!(w.state(Ephemeral).players[0].extract_start_slot, 0, "channel is public");
    w.advance_slots(EXTRACT_CHANNEL_SLOTS - 1);
    let e = w.act(0, ixs::Extract {}).expect_err("one slot early");
    assert!(err_code(&e, STILL_CHANNELING), "{e}");
    // Step off and back: the channel is gone.
    w.walk(0, &[LEFT, 1]);
    assert_eq!(w.state(Ephemeral).players[0].extract_start_slot, 0);
    w.advance_slots(EXTRACT_CHANNEL_SLOTS);
    assert!(err_code(&w.act(0, ixs::Extract {}).unwrap_err(), NOT_CHANNELING));
    w.extract(0).expect("a full uninterrupted channel works");
}

#[test]
fn a_hit_interrupts_an_extraction() {
    let mut w = World::new(2);
    w.start();
    w.unlock_exits();
    w.walk_to(0, map::EXTRACTS[0]); // (3,6)
    w.walk_to(1, (3, 5)); // right above it
    w.act(0, ixs::StartExtract {}).unwrap();
    w.advance_slots(EXTRACT_CHANNEL_SLOTS / 2);
    w.hit(1, DOWN).expect("hit");
    let s = w.state(Ephemeral);
    assert_eq!(s.players[0].extract_start_slot, 0, "interrupted");
    assert_eq!(s.players[0].hp, START_HP - 1);
    w.advance_slots(EXTRACT_CHANNEL_SLOTS);
    assert!(err_code(&w.act(0, ixs::Extract {}).unwrap_err(), NOT_CHANNELING));
}

#[test]
fn attacks_have_a_cooldown() {
    let mut w = World::new(2);
    w.start();
    w.walk_to(0, (3, 3));
    w.walk_to(1, (3, 4));
    w.hit(1, UP).expect("first hit");
    let e = w.hit(1, UP).expect_err("second hit inside the cooldown");
    assert!(err_code(&e, ATTACK_COOLDOWN), "{e}");
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
    w.loot(0, 0, 75); // rare: 3 pts
    w.walk_to(0, (3, 3));
    w.walk_to(1, (3, 4));
    w.hit_and_wait(1, UP);
    w.hit_and_wait(1, UP);
    w.hit_and_wait(1, UP);
    let s = w.state(Ephemeral);
    assert!(!s.players[0].alive);
    let sack = s.dropped[0];
    assert!(sack.present && (sack.x, sack.y) == (3, 3) && sack.points == 0, "sack public, contents not");
    assert_eq!(w.read_bag(Ephemeral, 0).dropped, 3);
    w.walk(1, &[UP]); // onto the sack
    assert_eq!(w.read_bag(Ephemeral, 1).points, 3);
    w.unlock_exits();
    w.walk_to(1, map::EXTRACTS[0]);
    w.extract(1).unwrap();
    let s1 = w.sessions[1].insecure_clone();
    w.end_as(&s1).unwrap();
    for seat in 0..2 {
        assert!(!is_delegated(&w.svm, &as_address(w.bag(seat))), "bag {seat} back on base");
    }
    let before = balance(&w.svm, Base, pk(&w.wallets[1]));
    w.settle().unwrap();
    assert_eq!(balance(&w.svm, Base, pk(&w.wallets[1])) - before, 2 * ENTRY);
    assert!(w.settle().is_err(), "no double settle");
}

#[test]
fn bags_cannot_be_swapped_between_seats() {
    let mut w = World::new(2);
    w.start();
    let into = w.walk_to_chest(0, 0);
    let _ = into;
    let s = w.sessions[0].insecure_clone();
    let (program_identity, _) = Pubkey::find_program_address(&[b"identity"], &w.program);
    let i = ix(w.program, ixs::OpenChest { chest: 0 }, acc::OpenChest {
        payer: pk(&s), run: w.run, bag: w.bag(1), oracle_queue: DEFAULT_EPHEMERAL_QUEUE,
        program_identity, vrf_program: VRF_PROGRAM_ID, slot_hashes: SLOT_HASHES, system_program: system_program::ID,
    });
    assert!(w.send(Ephemeral, &[&s], i).is_err(), "wrong bag rejected");
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
    let s0 = w.sessions[0].insecure_clone();
    assert!(w.end_as(&s0).is_err(), "too early for a player to end it");
    w.warp_seconds(DURATION as i64);
    assert!(w.act(0, ixs::MovePlayer { dir: DOWN }).is_err(), "time is up");
    w.end_as(&s0).unwrap();
    let house_before = balance(&w.svm, Base, pk(&w.authority));
    w.settle().unwrap();
    let gained = balance(&w.svm, Base, pk(&w.authority)) - house_before;
    assert!(gained > 2 * ENTRY - 10_000 && gained <= 2 * ENTRY, "house got {gained}");
}

#[test]
fn extracted_players_split_by_points() {
    let mut w = World::new(3);
    w.start();
    w.loot(0, 0, 10); // common, 1
    w.loot(1, 3, 80); // (16,11) rare, 3
    w.unlock_exits();
    w.walk_to(0, map::EXTRACTS[2]);
    w.extract(0).unwrap();
    w.walk_to(1, map::EXTRACTS[3]);
    w.extract(1).unwrap();
    let auth = w.authority.insecure_clone();
    w.end_as(&auth).unwrap();
    let before: Vec<u64> = w.wallets.iter().map(|k| balance(&w.svm, Base, pk(k))).collect();
    w.settle().unwrap();
    let gained: Vec<u64> = w.wallets.iter().zip(&before).map(|(k, b)| balance(&w.svm, Base, pk(k)) - b).collect();
    assert_eq!(gained, vec![3 * ENTRY / 4, 9 * ENTRY / 4, 0]);
}
