// Phaser scene: renders the dungeon purely from on-chain Run state.
// Diffs consecutive states to drive feedback (hit flashes, loot popups, deaths, extracts).
import Phaser from "phaser";
import { ChestState, MAP, RunState } from "./chain";

export const TILE = 56;
export const SEAT_COLORS = [0x5ab0ff, 0xff6ad5, 0xffa24a, 0xc9f24a];
const TIER_COLORS: Record<number, number> = { 1: 0x9aa0ad, 2: 0x5ab0ff, 3: 0xf5c04a };
const TIER_NAMES: Record<number, string> = { 1: "COMMON", 2: "RARE", 3: "LEGENDARY" };

export class DungeonScene extends Phaser.Scene {
  private state: RunState | null = null;
  private mySeat = -1;
  private dyn!: Phaser.GameObjects.Graphics;
  private players: Phaser.GameObjects.Container[] = [];
  private labels: Phaser.GameObjects.Text[] = [];
  private chestTime = 0;

  constructor() {
    super("dungeon");
  }

  create() {
    this.drawMap();
    this.dyn = this.add.graphics();
    for (let i = 0; i < 4; i++) {
      const body = this.add.circle(0, 0, TILE * 0.34, SEAT_COLORS[i]).setStrokeStyle(3, 0x0d0b12);
      const ring = this.add.circle(0, 0, TILE * 0.42).setStrokeStyle(3, 0xffffff).setVisible(false);
      const hp = this.add.text(0, -TILE * 0.62, "", { fontFamily: "Silkscreen", fontSize: "13px", color: "#ff5a6a", stroke: "#0d0b12", strokeThickness: 3 }).setOrigin(0.5);
      const c = this.add.container(0, 0, [ring, body, hp]).setVisible(false).setDepth(10);
      this.players.push(c);
    }
    // Input is handled in main.ts on `window`, independent of the render loop.
    if (this.state) this.render(null, this.state);
  }

  update(_t: number, dt: number) {
    this.chestTime += dt;
    if (this.state?.chests.some((c) => c.state === ChestState.Opening)) this.drawDynamic();
  }

  setState(next: RunState, mySeat: number) {
    const prev = this.state;
    this.state = next;
    this.mySeat = mySeat;
    if (this.sys?.isActive()) this.render(prev, next);
  }

  private drawMap() {
    const g = this.add.graphics();
    for (let y = 0; y < MAP.H; y++)
      for (let x = 0; x < MAP.W; x++) {
        const wall = MAP.LAYOUT[y][x] === "#";
        if (wall) {
          // Dark stone with a lit top edge, so walls read as solid at a glance.
          g.fillStyle(0x0b0910).fillRect(x * TILE, y * TILE, TILE, TILE);
          g.fillStyle(0x4a4163).fillRect(x * TILE, y * TILE, TILE, 7);
          g.fillStyle(0x2a2439).fillRect(x * TILE, y * TILE + 7, TILE, 3);
        } else {
          g.fillStyle((x + y) % 2 ? 0x3a3150 : 0x352d49).fillRect(x * TILE, y * TILE, TILE, TILE);
          g.lineStyle(1, 0x2b2540, 1).strokeRect(x * TILE + 0.5, y * TILE + 0.5, TILE - 1, TILE - 1);
        }
      }
    for (const [x, y] of MAP.EXTRACTS) {
      g.fillStyle(0x4ef0a0, 0.16).fillRect(x * TILE, y * TILE, TILE, TILE);
      g.lineStyle(2, 0x4ef0a0, 0.9).strokeRect(x * TILE + 4, y * TILE + 4, TILE - 8, TILE - 8);
      this.add.text(x * TILE + TILE / 2, y * TILE + TILE / 2, "EXIT", { fontFamily: "Silkscreen", fontSize: "14px", color: "#4ef0a0" }).setOrigin(0.5);
    }
  }

  private drawDynamic() {
    const s = this.state;
    if (!s) return;
    const g = this.dyn.clear();
    s.chests.forEach((c, i) => {
      const [x, y] = MAP.CHESTS[i];
      const px = x * TILE, py = y * TILE;
      if (c.state === ChestState.Opened) {
        g.fillStyle(0x3a3046).fillRect(px + 10, py + 18, TILE - 20, TILE - 26);
        g.lineStyle(2, TIER_COLORS[c.tier] ?? 0xffffff).strokeRect(px + 10, py + 18, TILE - 20, TILE - 26);
      } else {
        const pulse = c.state === ChestState.Opening ? 0.5 + 0.5 * Math.sin(this.chestTime / 90) : 1;
        g.fillStyle(0x8a5a2b, pulse).fillRect(px + 10, py + 16, TILE - 20, TILE - 24);
        g.fillStyle(0xf5c04a, pulse).fillRect(px + 10, py + 26, TILE - 20, 4).fillRect(px + TILE / 2 - 4, py + 22, 8, 10);
      }
    });
    for (const b of s.dropped) {
      if (!b.present) continue;
      g.fillStyle(0xc89b3c).fillCircle(b.x * TILE + TILE / 2, b.y * TILE + TILE / 2 + 6, 12);
      g.fillStyle(0x7a5a1c).fillRect(b.x * TILE + TILE / 2 - 5, b.y * TILE + TILE / 2 - 10, 10, 6);
    }
  }

  private render(prev: RunState | null, s: RunState) {
    this.drawDynamic();
    // Dropped-bag point labels.
    this.labels.forEach((l) => l.destroy());
    this.labels = s.dropped
      .filter((b) => b.present)
      .map((b) =>
        this.add.text(b.x * TILE + TILE / 2, b.y * TILE + TILE / 2 + 6, `${b.points}`, { fontFamily: "Silkscreen", fontSize: "12px", color: "#1a1408" }).setOrigin(0.5).setDepth(5),
      );

    for (let i = 0; i < 4; i++) {
      const c = this.players[i];
      const p = s.players[i];
      if (i >= s.playerCount || !p.alive || p.extracted) {
        c.setVisible(false);
      } else {
        const tx = p.x * TILE + TILE / 2, ty = p.y * TILE + TILE / 2;
        const was = prev?.players[i];
        if (!c.visible || !was) c.setPosition(tx, ty);
        else this.tweens.add({ targets: c, x: tx, y: ty, duration: 70, ease: "Quad.easeOut" });
        c.setVisible(true);
        (c.list[0] as Phaser.GameObjects.Arc).setVisible(i === this.mySeat);
        (c.list[2] as Phaser.GameObjects.Text).setText("♥".repeat(p.hp));
      }
      if (!prev) continue;
      const was = prev.players[i];
      const at = (p.alive ? p : was);
      const cx = at.x * TILE + TILE / 2, cy = at.y * TILE + TILE / 2;
      if (p.hp < was.hp && p.alive) {
        this.cameras.main.shake(80, 0.004);
        this.pop(cx, cy, "-1", "#ff5a6a");
        this.tweens.add({ targets: c.list[1], alpha: 0.2, duration: 60, yoyo: true, repeat: 1 });
      }
      if (was.alive && !p.alive) {
        this.cameras.main.shake(180, 0.01);
        this.pop(cx, cy, "SLAIN", "#ff5a6a", 20);
      }
      if (!was.extracted && p.extracted) this.pop(cx, cy, "EXTRACTED", "#4ef0a0", 18);
      if (p.bag > was.bag) this.pop(cx, cy - 20, `+${p.bag - was.bag}`, "#f5c04a", 18);
    }
    prev?.chests.forEach((was, i) => {
      const c = s.chests[i];
      if (was.state !== ChestState.Opened && c.state === ChestState.Opened) {
        const [x, y] = MAP.CHESTS[i];
        const col = "#" + (TIER_COLORS[c.tier] ?? 0xffffff).toString(16).padStart(6, "0");
        this.pop(x * TILE + TILE / 2, y * TILE, TIER_NAMES[c.tier] ?? "?", col, c.tier === 3 ? 20 : 14);
        if (c.tier === 3) this.cameras.main.flash(200, 245, 192, 74);
      }
    });
  }

  private pop(x: number, y: number, text: string, color: string, size = 16) {
    const t = this.add.text(x, y, text, { fontFamily: "Silkscreen", fontSize: `${size}px`, color, stroke: "#0d0b12", strokeThickness: 4 }).setOrigin(0.5).setDepth(20);
    this.tweens.add({ targets: t, y: y - 36, alpha: 0, duration: 900, ease: "Cubic.easeOut", onComplete: () => t.destroy() });
  }
}

export function startGame(parent: HTMLElement): DungeonScene {
  const scene = new DungeonScene();
  new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: MAP.W * TILE,
    height: MAP.H * TILE,
    backgroundColor: "#0d0b12",
    scene: [],
    callbacks: { postBoot: (game) => game.scene.add("dungeon", scene, true) },
  });
  return scene;
}
