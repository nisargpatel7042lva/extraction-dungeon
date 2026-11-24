use anchor_lang::prelude::*;

use crate::{map::NUM_CHESTS, DungeonError};

pub const MAX_PLAYERS: usize = 4;
pub const START_HP: u8 = 3;
/// Lamports moved from the wallet to the session key at join, for ER/TEE fees.
pub const SESSION_TOPUP: u64 = 4_000_000;
/// ER slots are ~11ms on devnet, so 36 slots is ~400ms between attacks.
pub const ATTACK_COOLDOWN_SLOTS: u64 = 36;

#[repr(u8)]
pub enum RunStatus {
    Lobby = 0,
    Live = 1,
    Ended = 2,
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

pub fn tier_for_roll(roll: u8) -> u8 {
    match roll {
        0..=60 => TIER_COMMON,
        61..=90 => TIER_RARE,
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

    /// Splits the pot given each seat's bag points. Returns (per-seat payout, house remainder).
    /// - Extracted players share the pot in proportion to bag points.
    /// - Extracted with empty bags only: equal split.
    /// - Nobody extracted: everything to the house.
    /// Integer dust goes to the house, so payouts + house == pot exactly.
    pub fn payouts(&self, points: &[u16; MAX_PLAYERS]) -> ([u64; MAX_PLAYERS], u64) {
        let mut out = [0u64; MAX_PLAYERS];
        let seated = self.seated();
        let n_ext = seated.iter().filter(|p| p.extracted).count() as u128;
        if n_ext == 0 {
            return (out, self.pot);
        }
        let total: u128 = seated
            .iter()
            .enumerate()
            .filter(|(_, p)| p.extracted)
            .map(|(i, _)| points[i] as u128)
            .sum();
        let pot = self.pot as u128;
        let mut paid = 0u128;
        for (i, p) in seated.iter().enumerate() {
            if !p.extracted {
                continue;
            }
            let share = if total == 0 { pot / n_ext } else { pot * points[i] as u128 / total };
            out[i] = share as u64;
            paid += share;
        }
        (out, (pot - paid) as u64)
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
        };
        (run, points)
    }

    fn conserved(r: &Run, pts: &[u16; MAX_PLAYERS]) -> ([u64; MAX_PLAYERS], u64) {
        let (s, h) = r.payouts(pts);
        assert_eq!(s.iter().sum::<u64>() + h, r.pot, "payouts + house must equal pot");
        (s, h)
    }

    #[test]
    fn proportional_to_bag_points_among_extracted() {
        let (r, p) = run_with(400, &[(true, 3), (true, 1), (false, 8)]);
        assert_eq!(conserved(&r, &p), ([300, 100, 0, 0], 0));
    }

    #[test]
    fn empty_bags_split_equally() {
        let (r, p) = run_with(300, &[(true, 0), (false, 5), (true, 0)]);
        assert_eq!(conserved(&r, &p), ([150, 0, 150, 0], 0));
    }

    #[test]
    fn nobody_extracted_goes_to_house() {
        let (r, p) = run_with(250, &[(false, 3), (false, 0)]);
        assert_eq!(conserved(&r, &p), ([0; MAX_PLAYERS], 250));
    }

    #[test]
    fn integer_dust_goes_to_house() {
        let (r, p) = run_with(100, &[(true, 1), (true, 1), (true, 1)]);
        assert_eq!(conserved(&r, &p), ([33, 33, 33, 0], 1));
    }

    #[test]
    fn tiers_cover_the_whole_roll_range() {
        assert_eq!(tier_for_roll(1), TIER_COMMON);
        assert_eq!(tier_for_roll(60), TIER_COMMON);
        assert_eq!(tier_for_roll(61), TIER_RARE);
        assert_eq!(tier_for_roll(90), TIER_RARE);
        assert_eq!(tier_for_roll(91), TIER_LEGENDARY);
        assert_eq!(tier_for_roll(100), TIER_LEGENDARY);
    }
}
