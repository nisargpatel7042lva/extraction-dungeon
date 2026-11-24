//! The single hand-made room. 12 x 9 tiles, '#' = wall.
//! Kept as consts so the client can mirror it byte-for-byte.

pub const W: u8 = 12;
pub const H: u8 = 9;

pub const LAYOUT: [&[u8; 12]; 9] = [
    b"############",
    b"#..........#",
    b"#.##....##.#",
    b"#..........#",
    b"#....##....#",
    b"#..........#",
    b"#.##....##.#",
    b"#..........#",
    b"############",
];

/// Spawn tiles, one per seat, in the four corners.
pub const SPAWNS: [(u8, u8); 4] = [(1, 1), (10, 7), (10, 1), (1, 7)];

/// Chest tiles. Chests are obstacles; open one from an adjacent tile.
pub const NUM_CHESTS: usize = 6;
pub const CHESTS: [(u8, u8); NUM_CHESTS] = [(3, 1), (8, 1), (1, 4), (10, 4), (3, 7), (8, 7)];

/// Extraction tiles, flanking the central pillar so the exits are contested.
pub const EXTRACTS: [(u8, u8); 2] = [(5, 3), (6, 5)];

pub fn is_wall(x: u8, y: u8) -> bool {
    x >= W || y >= H || LAYOUT[y as usize][x as usize] == b'#'
}

pub fn is_chest(x: u8, y: u8) -> bool {
    CHESTS.contains(&(x, y))
}

pub fn is_extract(x: u8, y: u8) -> bool {
    EXTRACTS.contains(&(x, y))
}

pub fn step(x: u8, y: u8, dir: u8) -> Option<(u8, u8)> {
    match dir {
        0 => Some((x, y.checked_sub(1)?)),
        1 => Some((x.checked_add(1)?, y)),
        2 => Some((x, y.checked_add(1)?)),
        3 => Some((x.checked_sub(1)?, y)),
        _ => None,
    }
}

pub fn adjacent(a: (u8, u8), b: (u8, u8)) -> bool {
    a.0.abs_diff(b.0) + a.1.abs_diff(b.1) == 1
}
