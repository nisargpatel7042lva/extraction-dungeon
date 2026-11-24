// Phaser scene: renders the dungeon purely from on-chain Run state, using the AI-generated sprite set
// in public/sprites (see scripts/sprites.ts). Diffs consecutive states to drive feedback
// (hit flashes, loot popups, deaths, extracts).
import Phaser from "phaser";
import { ChestState, MAP, RunState } from "./chain";

export const TILE = 56;
export const SEAT_COLORS = [0x5ab0ff, 0xff6ad5, 0xffa24a, 0xc9f24a];
export const TIER_COLORS: Record<number, number> = { 1: 0x9aa0ad, 2: 0x5ab0ff, 3: 0xf5c04a };
const UNKNOWN_TIER = 0x6b6280; // an opened chest someone else looted: you don't get to know what was in it

const FLOOR_SPAN = TILE * 4; // one floor texture covers 4x4 tiles
const WALL_SPAN = TILE * 2; // one wall texture covers 2x2 tiles

const center = (t: number) => t * TILE + TILE / 2;
const hex = (c: number) => "#" + c.toString(16).padStart(6, "0");

export class DungeonScene extends Phaser.Scene {
  private state: RunState | null = null;
  private mySeat = -1;
  private players: Phaser.GameObjects.Container[] = [];
  private chests: Phaser.GameObjects.Image[] = [];
  private chestGlows: Phaser.GameObjects.Arc[] = [];
  private sacks: { img: Phaser.GameObjects.Image; label: Phaser.GameObjects.Text }[] = [];
  private openingTweens = new Map<number, Phaser.Tweens.Tween>();
  /** Tiers of chests *you* opened (tiers are private, so only the opener learns them). */
  private knownTiers = new Map<number, number>();

  constructor() {
    super("dungeon");
  }

  /** Records the tier of a chest you opened and shows it. */
  revealChest(chest: number, tier: number, name: string) {
    this.knownTiers.set(chest, tier);
    if (!this.players.length) return;
    const [x, y] = MAP.CHESTS[chest];
    this.pop(center(x), y * TILE, name, hex(TIER_COLORS[tier] ?? 0xffffff), tier === 3 ? 20 : 15);
    if (tier === 3) this.cameras.main.flash(200, 245, 192, 74);
    if (this.state) this.renderObjects(this.state);
  }

  /** A floating label over a seat's hero (e.g. your own private loot gains). */
  popAtSeat(seat: number, text: string, color: string, size = 18) {
    const c = this.players[seat];
    if (c?.visible) this.pop(c.x, c.y - 20, text, color, size);
  }

  preload() {
    const base = `${import.meta.env.BASE_URL}sprites/`;
    for (let i = 0; i < 4; i++) this.load.image(`hero${i}`, `${base}hero${i}.png`);
    for (const k of ["chest_closed", "chest_open", "sack", "exit", "floor", "wall"]) this.load.image(k, `${base}${k}.png`);
  }

  create() {
    this.drawMap();

    MAP.CHESTS.forEach(([x, y]) => {
      this.chestGlows.push(this.add.circle(center(x), center(y) + 4, TILE * 0.42, 0xffffff, 0).setDepth(2));
      this.chests.push(this.add.image(center(x), center(y), "chest_closed").setDisplaySize(TILE * 0.82, TILE * 0.82).setDepth(3));
    });

    for (let i = 0; i < 4; i++) {
      const img = this.add.image(0, 0, "sack").setDisplaySize(TILE * 0.62, TILE * 0.62).setDepth(4).setVisible(false);
      const label = this.add
        .text(0, 0, "", { fontFamily: "Silkscreen", fontSize: "12px", color: "#f5c04a", stroke: "#0d0b12", strokeThickness: 3 })
        .setOrigin(0.5)
        .setDepth(6)
        .setVisible(false);
      this.sacks.push({ img, label });
    }

    for (let i = 0; i < 4; i++) {
      // [0] "you" marker under the feet, [1] hero sprite, [2] hearts
      const ring = this.add.ellipse(0, TILE * 0.36, TILE * 0.74, TILE * 0.26).setStrokeStyle(3, 0xffffff, 0.9).setFillStyle(0xffffff, 0.12).setVisible(false);
      const body = this.add.image(0, -2, `hero${i}`).setDisplaySize(TILE * 1.04, TILE * 1.04);
      const hp = this.add
        .text(0, -TILE * 0.62, "", { fontFamily: "Silkscreen", fontSize: "13px", color: "#ff5a6a", stroke: "#0d0b12", strokeThickness: 3 })
        .setOrigin(0.5);
      this.players.push(this.add.container(0, 0, [ring, body, hp]).setVisible(false).setDepth(10));
    }

    if (this.state) this.render(null, this.state);
  }

  setState(next: RunState, mySeat: number) {
    const prev = this.state;
    this.state = next;
    this.mySeat = mySeat;
    if (this.sys?.isActive() && this.players.length) this.render(prev, next);
  }

  private drawMap() {
    const W = MAP.W * TILE, H = MAP.H * TILE;
    // Seamless floor under everything, slightly brightened so sprites still pop.
    this.add
      .tileSprite(0, 0, W, H, "floor")
      .setOrigin(0)
      .setTileScale(FLOOR_SPAN / 256)
      .setTint(0xd8d0ee);

    const g = this.add.graphics().setDepth(1);
    for (let y = 0; y < MAP.H; y++)
      for (let x = 0; x < MAP.W; x++) {
        if (MAP.LAYOUT[y][x] !== "#") continue;
        // Each wall tile samples the wall texture at its world position, so bricks line up across tiles.
        this.add
          .tileSprite(x * TILE, y * TILE, TILE, TILE, "wall")
          .setOrigin(0)
          .setTileScale(WALL_SPAN / 256)
          .setTilePosition((x * TILE) / (WALL_SPAN / 256), (y * TILE) / (WALL_SPAN / 256))
          .setTint(0x9a92b4)
          .setDepth(1);
        // A shadow on the floor tile below a wall gives the room some depth.
        if (y + 1 < MAP.H && MAP.LAYOUT[y + 1][x] !== "#") g.fillStyle(0x000000, 0.28).fillRect(x * TILE, (y + 1) * TILE, TILE, 8);
      }

    for (const [x, y] of MAP.EXTRACTS) {
      const glow = this.add.circle(center(x), center(y), TILE * 0.5, 0x4ef0a0, 0.18).setDepth(1);
      const portal = this.add.image(center(x), center(y), "exit").setDisplaySize(TILE * 0.92, TILE * 0.92).setDepth(2);
      this.tweens.add({ targets: portal, angle: 360, duration: 9000, repeat: -1 });
      this.tweens.add({ targets: glow, alpha: 0.05, scale: 1.15, duration: 900, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    }
  }

  private renderObjects(s: RunState) {
    s.chests.forEach((c, i) => {
      const img = this.chests[i];
      const glow = this.chestGlows[i];
      if (c.state === ChestState.Opened) {
        this.openingTweens.get(i)?.stop();
        this.openingTweens.delete(i);
        img.setTexture("chest_open").setAlpha(0.85).setDisplaySize(TILE * 0.82, TILE * 0.82);
        const tier = this.knownTiers.get(i);
        glow.setFillStyle(tier ? TIER_COLORS[tier] : UNKNOWN_TIER, tier ? 0.32 : 0.18);
      } else if (c.state === ChestState.Opening) {
        if (!this.openingTweens.has(i))
          this.openingTweens.set(i, this.tweens.add({ targets: img, alpha: 0.45, duration: 180, yoyo: true, repeat: -1 }));
        glow.setFillStyle(0xf5c04a, 0.22);
      } else {
        img.setTexture("chest_closed").setAlpha(1);
        glow.setFillStyle(0xffffff, 0);
      }
    });

    s.dropped.forEach((b, i) => {
      const { img, label } = this.sacks[i];
      img.setVisible(b.present).setPosition(center(b.x), center(b.y) + 4);
      // What's inside a sack is private: everyone sees "?" until someone grabs it.
      label.setVisible(b.present).setPosition(center(b.x) + TILE * 0.26, center(b.y) - TILE * 0.22).setText("?");
    });
  }

  private render(prev: RunState | null, s: RunState) {
    this.renderObjects(s);

    for (let i = 0; i < 4; i++) {
      const c = this.players[i];
      const p = s.players[i];
      if (i >= s.playerCount || !p.alive || p.extracted) {
        c.setVisible(false);
      } else {
        const tx = center(p.x), ty = center(p.y);
        const was = prev?.players[i];
        if (!c.visible || !was) c.setPosition(tx, ty);
        else if (c.x !== tx || c.y !== ty) {
          this.tweens.add({ targets: c, x: tx, y: ty, duration: 80, ease: "Quad.easeOut" });
          // A little hop sells the step.
          this.tweens.add({ targets: c.list[1], y: -8, duration: 40, yoyo: true, ease: "Quad.easeOut" });
          if (tx !== c.x) (c.list[1] as Phaser.GameObjects.Image).setFlipX(tx < c.x);
        }
        c.setVisible(true);
        (c.list[0] as Phaser.GameObjects.Ellipse).setVisible(i === this.mySeat);
        (c.list[2] as Phaser.GameObjects.Text).setText("♥".repeat(p.hp));
      }
      if (!prev) continue;
      const was = prev.players[i];
      const at = p.alive ? p : was;
      const cx = center(at.x), cy = center(at.y);
      if (p.hp < was.hp && p.alive) {
        this.cameras.main.shake(80, 0.004);
        this.pop(cx, cy, "-1", "#ff5a6a");
        const body = c.list[1] as Phaser.GameObjects.Image;
        body.setTintFill(0xffffff);
        this.time.delayedCall(70, () => body.clearTint());
        this.tweens.add({ targets: body, alpha: 0.3, duration: 60, yoyo: true, repeat: 1 });
      }
      if (was.alive && !p.alive) {
        this.cameras.main.shake(180, 0.01);
        this.pop(cx, cy, "SLAIN", "#ff5a6a", 20);
      }
      if (!was.extracted && p.extracted) {
        this.pop(cx, cy, "EXTRACTED", "#4ef0a0", 18);
        const ghost = this.add.image(cx, cy - 2, `hero${i}`).setDisplaySize(TILE * 1.04, TILE * 1.04).setDepth(11);
        this.tweens.add({ targets: ghost, alpha: 0, scale: ghost.scale * 0.2, angle: 180, duration: 600, ease: "Cubic.easeIn", onComplete: () => ghost.destroy() });
      }
    }

    // Chests other players open: everyone sees it opened, nobody but the opener learns the tier.
    prev?.chests.forEach((was, i) => {
      const c = s.chests[i];
      if (was.state !== ChestState.Opened && c.state === ChestState.Opened && c.opener !== this.mySeat) {
        const [x, y] = MAP.CHESTS[i];
        this.pop(center(x), y * TILE, "LOOTED ?", hex(UNKNOWN_TIER + 0x303030), 13);
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
