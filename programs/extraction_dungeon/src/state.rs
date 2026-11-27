use anchor_lang::prelude::*;

use crate::{
    map::{self, NUM_CHESTS},
    DungeonError,
};

pub const MAX_PLAYERS: usize = 4;
/// The house treasury: when nobody escapes a run, its pot goes here (nobody earned it).
pub const TREASURY: Pubkey = pubkey!("3fTVWVBgm8yYh8XXd7qTBCBuLNP4nMKsCAgesHHCBnA5");
pub const START_HP: u8 = 3;
/// Lamports moved from the wallet to the session key at join, for ER/TEE fees.
pub const SESSION_TOPUP: u64 = 4_000_000;
/// ER slots are ~11ms on devnet, so 36 slots is ~400ms between attacks.
pub const ATTACK_COOLDOWN_SLOTS: u64 = 36;
/// Extracting is channeled: stand still on an exit for 180 slots (~2s). Moving, attacking or
/// getting hit cancels it, and everyone can see you doing it.
pub const EXTRACT_CHANNEL_SLOTS: u64 = 180;

/// Vault Guardians: two monsters that spawn beside the Vault, chase players who come near,
/// bite, and walk back home. Anyone seated can drive them with `tick_monsters`.
pub const MAX_MONSTERS: usize = 2;
pub const MONSTER_HP: u8 = 3;
/// Monsters act at most once per tick, and ticks are at least this many ER slots apart (~0.75 s),
/// so a player (who can step every transaction) can always outrun one.
pub const MONSTER_TICK_SLOTS: u64 = 70;
/// A monster bites at most once per this many ER slots (~2 s): killing a full-health player takes
/// ~4 s of biting, while a player kills a guardian in ~1.2 s, so a fair fight is winnable.
pub const MONSTER_ATTACK_SLOTS: u64 = 180;
/// A guardian locks onto a player who comes within this many steps of it.
pub const MONSTER_LEASH: u8 = 3;
/// Once locked on, it hunts that player anywhere within this many steps of its post (Pac-Man
/// style), and gives up when they escape past it, die or extract.
pub const MONSTER_CHASE: u8 = 8;
/// How often the rollup's scheduler (a MagicBlock crank) ticks the guardians.
pub const GUARDIAN_CRANK_MILLIS: i64 = 700;
/// The ER validator's crank executor; scheduled instructions are signed by the PDA
/// `[CRANK_SEED, task authority]` under it.
pub const CRANK_PROGRAM_ID: Pubkey = pubkey!("Crank11111111111111111111111111111111111111");
pub const CRANK_SEED: &[u8] = b"crank-executor";
/// Private loot for killing one.
pub const MONSTER_BOUNTY: u16 = 2;

pub fn dist(a: (u8, u8), b: (u8, u8)) -> u8 {
    a.0.abs_diff(b.0) + a.1.abs_diff(b.1)
}

#[repr(u8)]
pub enum RunStatus {
    Lobby = 0,
    Live = 1,
    Ended = 2,
    /// Never started; every stake was refunded.
    Cancelled = 3,
}

#[repr(u8)]
pub enum ChestState {
    Closed = 0,
    /// VRF requested, callback pending.
    Opening = 1,
    Opened = 2,
}

/// Loot tiers, rolled 1..=100 by VRF.
pub const TIER_COMMON: u8 = 1;
pub const TIER_RARE: u8 = 2;
pub const TIER_LEGENDARY: u8 = 3;
/// A chest that bites back: no loot, and 1 damage to whoever opened it.
pub const TIER_MIMIC: u8 = 4;

/// Regular chests: 10% mimic, 50% common, 30% rare, 10% legendary.
pub fn tier_for_roll(roll: u8) -> u8 {
    match roll {
        0..=10 => TIER_MIMIC,
        11..=60 => TIER_COMMON,
        61..=90 => TIER_RARE,
        _ => TIER_LEGENDARY,
    }
}

/// The Vault never rolls common (or a mimic): 55% rare, 45% legendary.
pub fn vault_tier_for_roll(roll: u8) -> u8 {
    match roll {
        0..=55 => TIER_RARE,
        _ => TIER_LEGENDARY,
    }
}

pub fn points_for_tier(tier: u8) -> u16 {
    match tier {
        TIER_COMMON => 1,
        TIER_RARE => 3,
        TIER_LEGENDARY => 8,
        _ => 0,
    }
}

/// Public per-player state, readable by everyone. Loot lives in the private `Bag`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct PlayerSlot {
    /// Wallet that staked and receives payouts.
    pub wallet: Pubkey,
    /// Browser session key allowed to act for this player inside the ER.
    pub signer: Pubkey,
    pub x: u8,
    pub y: u8,
    pub hp: u8,
    pub alive: bool,
    pub extracted: bool,
    pub kills: u8,
    /// ER slot of this player's last attack (cooldown).
    pub last_attack_slot: u64,
    /// ER slot this player started channeling an extraction, or 0 if not channeling.
    pub extract_start_slot: u64,
}

impl PlayerSlot {
    /// On the board: alive and not yet extracted.
    pub fn active(&self) -> bool {
        self.alive && !self.extracted
    }
}

/// Public chest state. The rolled tier is private: it is written into the opener's `Bag`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Chest {
    pub state: u8,
    pub tier: u8,
    /// Seat index of the player who opened it.
    pub opener: u8,
}

/// A Vault Guardian. Public: everyone sees where it is and how hurt it is.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Monster {
    pub x: u8,
    pub y: u8,
    pub home_x: u8,
    pub home_y: u8,
    pub hp: u8,
    pub alive: bool,
    /// ER slot of its last bite (cooldown).
    pub last_attack_slot: u64,
    /// Seat it's hunting, plus one (0: none).
    pub target: u8,
}

/// Where a dead player's sack lies. What's inside is private (the victim's `Bag.dropped`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct DroppedBag {
    pub x: u8,
    pub y: u8,
    pub points: u16,
    pub present: bool,
}

#[account]
#[derive(InitSpace)]
pub struct Run {
    pub authority: Pubkey,
    pub run_id: u64,
    pub status: u8,
    pub player_count: u8,
    pub entry_lamports: u64,
    /// Total stakes held in the vault.
    pub pot: u64,
    pub duration_secs: u32,
    pub ends_at: i64,
    pub players: [PlayerSlot; MAX_PLAYERS],
    pub chests: [Chest; NUM_CHESTS],
    pub dropped: [DroppedBag; MAX_PLAYERS],
    pub settled: bool,
    pub bump: u8,
    pub vault_bump: u8,
    /// Which of `map::MAPS` this run is played on (picked by the client at creation).
    pub layout: u8,
    /// Unix time the run was created; lobbies that never start can be cancelled after a timeout.
    pub created_at: i64,
    /// Vault Guardians, spawned at start.
    pub monsters: [Monster; MAX_MONSTERS],
    /// ER slot of the last monster tick (rate limit).
    pub last_tick_slot: u64,
    /// The session key that scheduled the guardian crank (its task authority), and the crank
    /// signer PDA the rollup's scheduler signs `tick_monsters` with. Default until scheduled.
    pub crank_authority: Pubkey,
    pub crank_signer: Pubkey,
}

/// One player's loot. Delegated to the TEE rollup with a permission that only that player's
/// session key can read, so opponents can't see what anyone is carrying until the run ends.
#[account]
#[derive(InitSpace)]
pub struct Bag {
    pub run: Pubkey,
    pub seat: u8,
    /// Points carried.
    pub points: u16,
    /// Points in this player's sack on the floor (after death), until someone picks it up.
    pub dropped: u16,
    /// Tier of the last chest this player opened (so only they see what they got).
    pub last_tier: u8,
    pub bump: u8,
}

/// Holds the stakes on the base layer. Never delegated, so payouts can't be touched by the ER.
#[account]
#[derive(InitSpace)]
pub struct Vault {}

impl Run {
    pub fn seated(&self) -> &[PlayerSlot] {
        &self.players[..self.player_count as usize]
    }

    pub fn slot_of_signer(&self, signer: &Pubkey) -> Result<usize> {
        self.seated()
            .iter()
            .position(|p| p.signer == *signer)
            .ok_or_else(|| error!(DungeonError::UnknownSigner))
    }

    /// Seat index of the active player standing on (x, y), if any.
    pub fn active_at(&self, x: u8, y: u8) -> Option<usize> {
        self.seated()
            .iter()
            .position(|p| p.active() && p.x == x && p.y == y)
    }

    /// Index of the living monster standing on (x, y), if any.
    pub fn monster_at(&self, x: u8, y: u8) -> Option<usize> {
        self.monsters.iter().position(|m| m.alive && m.x == x && m.y == y)
    }

    /// Spawns the two Vault Guardians on the tiles left and right of the Vault.
    pub fn spawn_monsters(&mut self) {
        let (vx, vy) = map::get(self.layout).chest(map::VAULT);
        for (i, x) in [vx - 1, vx + 1].into_iter().enumerate() {
            self.monsters[i] = Monster { x, y: vy, home_x: x, home_y: vy, hp: MONSTER_HP, alive: true, last_attack_slot: 0, target: 0 };
        }
    }

    /// One step for monster `mi` along the shortest path to `goal` (breadth-first search around
    /// walls, chests, players and the other monster), never leaving its chase radius. Stays put when
    /// it's already next to the goal; falls back to a greedy step if the goal can't be reached.
    pub fn monster_step(&mut self, mi: usize, goal: (u8, u8)) {
        let m = self.monsters[mi];
        if (m.x, m.y) == goal {
            return;
        }
        if let Some(d) = self.monster_path_dir(mi, goal) {
            if let Some((nx, ny)) = map::step(m.x, m.y, d) {
                self.monsters[mi].x = nx;
                self.monsters[mi].y = ny;
            }
            return;
        }
        self.monster_greedy_step(mi, goal);
    }

    /// First direction of a shortest path from monster `mi` to `goal`; None if the goal is adjacent
    /// (no move needed) or unreachable within the chase radius.
    fn monster_path_dir(&self, mi: usize, goal: (u8, u8)) -> Option<u8> {
        const W: usize = map::W as usize;
        const N: usize = map::W as usize * map::H as usize;
        const UNSEEN: u8 = u8::MAX;
        const BLOCKED: u8 = 9;
        let m = self.monsters[mi];
        let home = (m.home_x, m.home_y);
        let tiles = map::get(self.layout);
        // first[i]: the first step (0..=3) on the way to tile i; UNSEEN or BLOCKED otherwise.
        let mut first = [UNSEEN; N];
        let mut queue = [0u16; N];
        let (mut head, mut tail) = (0usize, 0usize);
        let start = m.y as usize * W + m.x as usize;
        first[start] = BLOCKED;
        queue[tail] = start as u16;
        tail += 1;
        while head < tail {
            let cur = queue[head] as usize;
            head += 1;
            let (cx, cy) = ((cur % W) as u8, (cur / W) as u8);
            for d in 0..4u8 {
                let Some(t) = map::step(cx, cy, d) else { continue };
                if t.0 >= map::W || t.1 >= map::H {
                    continue;
                }
                let ti = t.1 as usize * W + t.0 as usize;
                if first[ti] != UNSEEN {
                    continue;
                }
                let via = if cur == start { d } else { first[cur] };
                if t == goal {
                    return if cur == start { None } else { Some(via) };
                }
                if tiles.is_wall(t.0, t.1)
                    || tiles.is_chest(t.0, t.1)
                    || self.active_at(t.0, t.1).is_some()
                    || self.monster_at(t.0, t.1).is_some()
                    || dist(t, home) > MONSTER_CHASE
                {
                    first[ti] = BLOCKED;
                    continue;
                }
                first[ti] = via;
                queue[tail] = ti as u16;
                tail += 1;
            }
        }
        None
    }

    /// The open neighbouring tile that gets closest to `goal`, within the chase radius; doesn't move
    /// if none gets closer.
    fn monster_greedy_step(&mut self, mi: usize, goal: (u8, u8)) {
        let m = self.monsters[mi];
        let home = (m.home_x, m.home_y);
        let here = dist((m.x, m.y), goal);
        let tiles = map::get(self.layout);
        let mut best: Option<((u8, u8), u8)> = None;
        for d in 0..4 {
            let Some(t) = map::step(m.x, m.y, d) else { continue };
            if tiles.is_wall(t.0, t.1) || tiles.is_chest(t.0, t.1) || self.active_at(t.0, t.1).is_some() || self.monster_at(t.0, t.1).is_some() {
                continue;
            }
            if dist(t, home) > MONSTER_CHASE {
                continue;
            }
            let dg = dist(t, goal);
            if dg < here && best.map_or(true, |(_, bd)| dg < bd) {
                best = Some((t, dg));
            }
        }
        if let Some((t, _)) = best {
            self.monsters[mi].x = t.0;
            self.monsters[mi].y = t.1;
        }
    }

    /// The nearest active player near monster `mi`'s home (within its leash, plus one so it can
    /// bite someone standing at the edge), with their distance to the monster.
    pub fn monster_target(&self, mi: usize) -> Option<(usize, u8)> {
        let m = self.monsters[mi];
        let home = (m.home_x, m.home_y);
        // Keep hunting the locked-on player while they're active and inside the chase radius.
        if m.target > 0 {
            let j = (m.target - 1) as usize;
            if let Some(p) = self.seated().get(j) {
                if p.active() && dist((p.x, p.y), home) <= MONSTER_CHASE {
                    return Some((j, dist((p.x, p.y), (m.x, m.y))));
                }
            }
        }
        // Otherwise lock onto the nearest active player within sight (MONSTER_LEASH of it, or of its
        // post) and inside the chase radius.
        let mut best: Option<(usize, u8)> = None;
        for (j, p) in self.seated().iter().enumerate() {
            let near = dist((p.x, p.y), (m.x, m.y)) <= MONSTER_LEASH || dist((p.x, p.y), home) <= MONSTER_LEASH + 1;
            if !p.active() || !near || dist((p.x, p.y), home) > MONSTER_CHASE {
                continue;
            }
            let d = dist((p.x, p.y), (m.x, m.y));
            if best.map_or(true, |(_, bd)| d < bd) {
                best = Some((j, d));
            }
        }
        best
    }

    /// Exits unlock once a quarter of the run has passed, so nobody can loot one chest and leave.
    pub fn exits_open(&self, now: i64) -> bool {
        now >= self.ends_at - (self.duration_secs as i64) * 3 / 4
    }

    /// Every seated player is dead or extracted.
    pub fn all_resolved(&self) -> bool {
        self.seated().iter().all(|p| !p.active())
    }

    /// Kills seat `i` and marks its sack on its tile. Moving the points is the caller's job.
    pub fn kill(&mut self, i: usize) {
        let p = &mut self.players[i];
        p.alive = false;
        p.hp = 0;
        self.dropped[i] = DroppedBag { x: p.x, y: p.y, points: 0, present: true };
    }

    /// Seats whose sacks lie on (x, y).
    pub fn sacks_at(&self, x: u8, y: u8) -> Vec<usize> {
        (0..MAX_PLAYERS)
            .filter(|&j| self.dropped[j].present && self.dropped[j].x == x && self.dropped[j].y == y)
            .collect()
    }

    /// Splits the pot given each seat's bag points. Every lamport goes back to the players: the
    /// host never takes a cut, so ending or abandoning a run can't profit them.
    /// - Extracted players share the pot in proportion to bag points.
    /// - Extracted with empty bags only: equal split.
    /// - Nobody extracted: nobody gets anything; `settle_run` sends the pot to the treasury.
    /// Integer dust goes to the best-scoring extracted player, so payouts sum to the pot exactly.
    pub fn payouts(&self, points: &[u16; MAX_PLAYERS]) -> [u64; MAX_PLAYERS] {
        let mut out = [0u64; MAX_PLAYERS];
        let seated = self.seated();
        let n = seated.len();
        if n == 0 {
            return out;
        }
        let pot = self.pot as u128;
        let n_ext = seated.iter().filter(|p| p.extracted).count() as u128;
        if n_ext == 0 {
            return out;
        }
        let total: u128 = seated
            .iter()
            .enumerate()
            .filter(|(_, p)| p.extracted)
            .map(|(i, _)| points[i] as u128)
            .sum();
        let mut paid = 0u128;
        let mut best: Option<usize> = None;
        for (i, p) in seated.iter().enumerate() {
            if !p.extracted {
                continue;
            }
            let share = if total == 0 { pot / n_ext } else { pot * points[i] as u128 / total };
            out[i] = share as u64;
            paid += share;
            if best.map_or(true, |b| points[i] > points[b]) {
                best = Some(i);
            }
        }
        if let Some(b) = best {
            out[b] += (pot - paid) as u64;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_with(pot: u64, seats: &[(bool, u16)]) -> (Run, [u16; MAX_PLAYERS]) {
        let mut players = [PlayerSlot::default(); MAX_PLAYERS];
        let mut points = [0u16; MAX_PLAYERS];
        for (i, &(extracted, bag)) in seats.iter().enumerate() {
            players[i] = PlayerSlot { extracted, alive: true, ..Default::default() };
            points[i] = bag;
        }
        let run = Run {
            authority: Pubkey::default(),
            run_id: 0,
            status: RunStatus::Ended as u8,
            player_count: seats.len() as u8,
            entry_lamports: 0,
            pot,
            duration_secs: 1,
            ends_at: 0,
            players,
            chests: Default::default(),
            dropped: Default::default(),
            settled: false,
            bump: 0,
            vault_bump: 0,
            layout: 0,
            created_at: 0,
            monsters: Default::default(),
            last_tick_slot: 0,
            crank_authority: Pubkey::default(),
            crank_signer: Pubkey::default(),
        };
        (run, points)
    }

    fn conserved(r: &Run, pts: &[u16; MAX_PLAYERS]) -> [u64; MAX_PLAYERS] {
        let s = r.payouts(pts);
        assert_eq!(s.iter().sum::<u64>(), r.pot, "payouts must equal the pot");
        s
    }

    #[test]
    fn proportional_to_bag_points_among_extracted() {
        let (r, p) = run_with(400, &[(true, 3), (true, 1), (false, 8)]);
        assert_eq!(conserved(&r, &p), [300, 100, 0, 0]);
    }

    #[test]
    fn empty_bags_split_equally() {
        let (r, p) = run_with(300, &[(true, 0), (false, 5), (true, 0)]);
        assert_eq!(conserved(&r, &p), [150, 0, 150, 0]);
    }

    #[test]
    fn nobody_extracted_pays_no_player() {
        let (r, p) = run_with(250, &[(false, 3), (false, 0)]);
        assert_eq!(r.payouts(&p), [0, 0, 0, 0], "the whole pot is left for the treasury");
    }

    #[test]
    fn integer_dust_goes_to_the_best_bag() {
        let (r, p) = run_with(100, &[(true, 1), (true, 1), (true, 1)]);
        assert_eq!(conserved(&r, &p), [34, 33, 33, 0]);
        let (r, p) = run_with(100, &[(true, 1), (true, 2), (false, 9)]);
        assert_eq!(conserved(&r, &p), [33, 67, 0, 0]);
    }

    #[test]
    fn vault_never_rolls_common() {
        for roll in 1..=100u8 {
            assert_ne!(vault_tier_for_roll(roll), TIER_COMMON, "roll {roll}");
            assert_ne!(vault_tier_for_roll(roll), TIER_MIMIC, "roll {roll}");
        }
        assert_eq!(vault_tier_for_roll(55), TIER_RARE);
        assert_eq!(vault_tier_for_roll(56), TIER_LEGENDARY);
    }

    #[test]
    fn mimics_pay_nothing() {
        assert_eq!(points_for_tier(TIER_MIMIC), 0);
    }

    #[test]
    fn tiers_cover_the_whole_roll_range() {
        assert_eq!(tier_for_roll(1), TIER_MIMIC);
        assert_eq!(tier_for_roll(10), TIER_MIMIC);
        assert_eq!(tier_for_roll(11), TIER_COMMON);
        assert_eq!(tier_for_roll(60), TIER_COMMON);
        assert_eq!(tier_for_roll(61), TIER_RARE);
        assert_eq!(tier_for_roll(90), TIER_RARE);
        assert_eq!(tier_for_roll(91), TIER_LEGENDARY);
        assert_eq!(tier_for_roll(100), TIER_LEGENDARY);
    }
}
