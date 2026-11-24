// Grid pathfinding over the dungeon map (mirrors the program's movement rules).
import { MAP } from "./chain";

export type Tile = [number, number];
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];

export const isChest = (x: number, y: number) => MAP.CHESTS.some(([cx, cy]) => cx === x && cy === y);
/** Floor that can be stood on (not wall, not chest). */
export const isOpen = (x: number, y: number) => MAP.LAYOUT[y]?.[x] === "." && !isChest(x, y);
export const isExit = (x: number, y: number) => MAP.EXTRACTS.some(([ex, ey]) => ex === x && ey === y);
export const same = (a: Tile, b: Tile) => a[0] === b[0] && a[1] === b[1];
export const manhattan = (a: Tile, b: Tile) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

/** Direction from `a` to an adjacent tile `b`, or -1. */
export function dirTo(a: Tile, b: Tile): number {
  for (let d = 0; d < 4; d++) if (a[0] + DX[d] === b[0] && a[1] + DY[d] === b[1]) return d;
  return -1;
}

/** Open tiles next to `t`, with the direction from each of them into `t`. */
export function sides(t: Tile): { tile: Tile; dir: number }[] {
  const out: { tile: Tile; dir: number }[] = [];
  for (let d = 0; d < 4; d++) {
    const tile: Tile = [t[0] + DX[d], t[1] + DY[d]];
    if (isOpen(...tile)) out.push({ tile, dir: (d + 2) % 4 });
  }
  return out;
}

/** BFS from `from` to the nearest of `goals`, avoiding `blocked`. Returns the directions to walk,
 *  or null if unreachable. An empty array means you're already on a goal. */
export function route(from: Tile, goals: Tile[], blocked: Tile[] = []): number[] | null {
  if (!goals.length) return null;
  const W = MAP.W;
  const k = (t: Tile) => t[1] * W + t[0];
  const goalSet = new Set(goals.map(k));
  const blockedSet = new Set(blocked.map(k));
  const prev = new Map<number, [number, number]>([[k(from), [-1, -1]]]);
  const q: Tile[] = [from];
  while (q.length) {
    const cur = q.shift()!;
    if (goalSet.has(k(cur))) {
      const dirs: number[] = [];
      let at = k(cur);
      while (prev.get(at)![0] !== -1) {
        const [p, d] = prev.get(at)!;
        dirs.push(d);
        at = p;
      }
      return dirs.reverse();
    }
    for (let d = 0; d < 4; d++) {
      const n: Tile = [cur[0] + DX[d], cur[1] + DY[d]];
      const nk = k(n);
      if (!isOpen(...n) || blockedSet.has(nk) || prev.has(nk)) continue;
      prev.set(nk, [k(cur), d]);
      q.push(n);
    }
  }
  return null;
}
