//! The dungeons: 20 x 13 tiles, '#' = wall. Every run picks one of the maps below at creation, so rounds
//! don't all play the same. Each map is mirror-symmetric (fair for all four corner spawns), has
//! ten chests plus a Vault in the middle, and four exits.
//! Kept as consts so the client can mirror them byte-for-byte (app/src/chain.ts).

pub const W: u8 = 20;
pub const H: u8 = 13;

/// Spawn tiles, one per seat, in the four corners (the same on every map).
pub const SPAWNS: [(u8, u8); 4] = [(1, 1), (18, 11), (18, 1), (1, 11)];

/// Chests are obstacles; open one from an adjacent tile. The last one is the Vault.
pub const NUM_CHESTS: usize = 11;
pub const VAULT: usize = NUM_CHESTS - 1;

pub const NUM_MAPS: u8 = 5;

// Plain per-field tables, not an array of structs: on the SBF target, tuple fields read out of a
// struct table in read-only data came back zeroed for some entries.
pub const NAMES: [&str; NUM_MAPS as usize] = ["CROSSROADS", "PILLARS", "ROOMS", "SERPENT", "RING"];

pub const LAYOUTS: [[&[u8; 20]; 13]; NUM_MAPS as usize] = [
    [
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
    ], // CROSSROADS
    [
        b"####################",
        b"#..................#",
        b"#.#.#.#.#..#.#.#.#.#",
        b"#..................#",
        b"#.#.#.#.#..#.#.#.#.#",
        b"#..................#",
        b"#.#...#......#...#.#",
        b"#..................#",
        b"#.#.#.#.#..#.#.#.#.#",
        b"#..................#",
        b"#.#.#.#.#..#.#.#.#.#",
        b"#..................#",
        b"####################",
    ], // PILLARS
    [
        b"####################",
        b"#....#........#....#",
        b"#....#........#....#",
        b"#....#.##..##.#....#",
        b"##.###.#....#.###.##",
        b"#..................#",
        b"#...##........##...#",
        b"#..................#",
        b"##.###.#....#.###.##",
        b"#....#.##..##.#....#",
        b"#....#........#....#",
        b"#....#........#....#",
        b"####################",
    ], // ROOMS
    [
        b"####################",
        b"#...#..........#...#",
        b"#.#.#.###..###.#.#.#",
        b"#.#...#......#...#.#",
        b"#.###.#.####.#.###.#",
        b"#..................#",
        b"###.##.#....#.##.###",
        b"#..................#",
        b"#.###.#.####.#.###.#",
        b"#.#...#......#...#.#",
        b"#.#.#.###..###.#.#.#",
        b"#...#..........#...#",
        b"####################",
    ], // SERPENT
    [
        b"####################",
        b"#..................#",
        b"#.######....######.#",
        b"#.#..............#.#",
        b"#.#.####.##.####.#.#",
        b"#.....#......#.....#",
        b"##.#............#.##",
        b"#.....#......#.....#",
        b"#.#.####.##.####.#.#",
        b"#.#..............#.#",
        b"#.######....######.#",
        b"#..................#",
        b"####################",
    ], // RING
];

/// Chest tiles per map; the last one is the Vault.
pub const CHESTS: [[(u8, u8); NUM_CHESTS]; NUM_MAPS as usize] = [
    [(3, 1), (16, 1), (3, 11), (16, 11), (5, 3), (14, 3), (5, 9), (14, 9), (1, 6), (18, 6), (9, 6)],
    [(4, 1), (15, 1), (4, 11), (15, 11), (3, 4), (16, 4), (3, 8), (16, 8), (3, 6), (16, 6), (9, 6)],
    [(4, 2), (15, 2), (4, 10), (15, 10), (8, 4), (11, 4), (8, 8), (11, 8), (2, 6), (17, 6), (9, 6)],
    [(3, 1), (16, 1), (3, 11), (16, 11), (7, 3), (12, 3), (7, 9), (12, 9), (3, 6), (16, 6), (9, 6)],
    [(3, 3), (16, 3), (3, 9), (16, 9), (7, 5), (12, 5), (7, 7), (12, 7), (4, 6), (15, 6), (9, 6)],
];

/// Extraction tiles per map. They unlock a quarter of the way into the run; extracting is channeled.
pub const EXTRACTS: [[(u8, u8); 4]; NUM_MAPS as usize] = [
    [(3, 6), (16, 6), (9, 1), (10, 11)],
    [(1, 6), (18, 6), (9, 3), (10, 9)],
    [(6, 6), (13, 6), (9, 1), (10, 11)],
    [(1, 5), (18, 5), (5, 1), (14, 11)],
    [(2, 6), (17, 6), (9, 2), (10, 10)],
];

/// One run's dungeon (an index into the tables above).
#[derive(Clone, Copy)]
pub struct Map(usize);

/// The map for a run's `layout` index.
pub fn get(layout: u8) -> Map {
    Map(layout as usize % NUM_MAPS as usize)
}

impl Map {
    pub fn name(&self) -> &'static str {
        NAMES[self.0]
    }

    pub fn chest(&self, c: usize) -> (u8, u8) {
        CHESTS[self.0][c]
    }

    pub fn extract(&self, e: usize) -> (u8, u8) {
        EXTRACTS[self.0][e]
    }

    pub fn is_wall(&self, x: u8, y: u8) -> bool {
        x >= W || y >= H || LAYOUTS[self.0][y as usize][x as usize] == b'#'
    }

    pub fn is_chest(&self, x: u8, y: u8) -> bool {
        (0..NUM_CHESTS).any(|c| self.chest(c) == (x, y))
    }

    pub fn is_extract(&self, x: u8, y: u8) -> bool {
        (0..4).any(|e| self.extract(e) == (x, y))
    }
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

    /// On every map, every floor tile (minus chests) must be reachable from every spawn, and every
    /// chest and exit must be next to a reachable tile, so no layout edit can wall anyone off.
    #[test]
    fn every_map_is_connected() {
        for l in 0..NUM_MAPS {
            let m = get(l);
            let walkable = |x: u8, y: u8| !m.is_wall(x, y) && !m.is_chest(x, y);
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
            let name = m.name();
            for y in 0..H {
                for x in 0..W {
                    if walkable(x, y) {
                        assert!(seen[y as usize][x as usize], "{name}: floor ({x},{y}) unreachable");
                    }
                }
            }
            for (cx, cy) in (0..NUM_CHESTS).map(|c| m.chest(c)) {
                assert!(!m.is_wall(cx, cy), "{name}: chest ({cx},{cy}) in a wall");
                assert!(
                    (0..4).any(|d| step(cx, cy, d).is_some_and(|(x, y)| walkable(x, y))),
                    "{name}: chest ({cx},{cy}) unreachable"
                );
            }
            for (ex, ey) in (0..4).map(|e| m.extract(e)) {
                assert!(walkable(ex, ey), "{name}: exit ({ex},{ey}) not walkable");
            }
            for &(sx, sy) in SPAWNS.iter() {
                assert!(walkable(sx, sy), "{name}: spawn ({sx},{sy}) not walkable");
            }
        }
    }
}
