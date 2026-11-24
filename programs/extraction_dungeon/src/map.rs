//! The dungeon: 20 x 13 tiles, '#' = wall. Symmetric, four corner spawns, ten chests, a Vault in
//! the middle (reachable only from its left and right), and four exits.
//! Kept as consts so the client can mirror it byte-for-byte.

pub const W: u8 = 20;
pub const H: u8 = 13;

pub const LAYOUT: [&[u8; 20]; 13] = [
    b"####################",
    b"#....#........#....#",
    b"#.##.#..####..#.##.#",
    b"#..................#",
    b"###.##.##..##.##.###",
    b"#........##........#",
    b"#.#..#........#..#.#",
    b"#........##........#",
    b"###.##.##..##.##.###",
    b"#..................#",
    b"#.##.#..####..#.##.#",
    b"#....#........#....#",
    b"####################",
];

/// Spawn tiles, one per seat, in the four corners.
pub const SPAWNS: [(u8, u8); 4] = [(1, 1), (18, 11), (18, 1), (1, 11)];

/// Chest tiles. Chests are obstacles; open one from an adjacent tile. The last one is the Vault.
pub const NUM_CHESTS: usize = 11;
pub const VAULT: usize = NUM_CHESTS - 1;
pub const CHESTS: [(u8, u8); NUM_CHESTS] = [
    (3, 1), (16, 1), (3, 11), (16, 11),
    (5, 3), (14, 3), (5, 9), (14, 9),
    (1, 6), (18, 6),
    (9, 6), // Vault: rolls only rare or legendary
];

/// Extraction tiles. They unlock a quarter of the way into the run, and extracting is channeled.
pub const EXTRACTS: [(u8, u8); 4] = [(3, 6), (16, 6), (9, 1), (10, 11)];

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

#[cfg(test)]
mod tests {
    use super::*;

    /// Every floor tile (minus chests) must be reachable from every spawn, and every chest and
    /// exit must be next to a reachable tile, so no layout edit can wall anyone off.
    #[test]
    fn whole_map_is_connected() {
        let walkable = |x: u8, y: u8| !is_wall(x, y) && !is_chest(x, y);
        let mut seen = [[false; W as usize]; H as usize];
        let mut stack = vec![SPAWNS[0]];
        while let Some((x, y)) = stack.pop() {
            if seen[y as usize][x as usize] {
                continue;
            }
            seen[y as usize][x as usize] = true;
            for d in 0..4 {
                if let Some((nx, ny)) = step(x, y, d) {
                    if walkable(nx, ny) && !seen[ny as usize][nx as usize] {
                        stack.push((nx, ny));
                    }
                }
            }
        }
        for y in 0..H {
            for x in 0..W {
                if walkable(x, y) {
                    assert!(seen[y as usize][x as usize], "floor ({x},{y}) unreachable");
                }
            }
        }
        for &(cx, cy) in CHESTS.iter() {
            assert!(!is_wall(cx, cy), "chest ({cx},{cy}) in a wall");
            assert!((0..4).any(|d| step(cx, cy, d).is_some_and(|(x, y)| walkable(x, y))), "chest ({cx},{cy}) unreachable");
        }
        for &(ex, ey) in EXTRACTS.iter() {
            assert!(walkable(ex, ey), "exit ({ex},{ey}) not walkable");
        }
        for &(sx, sy) in SPAWNS.iter() {
            assert!(walkable(sx, sy), "spawn ({sx},{sy}) not walkable");
        }
    }
}
