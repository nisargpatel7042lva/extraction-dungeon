// Phaser scene: renders the dungeon purely from on-chain Run state, using the AI-generated sprite set
// in public/sprites (see scripts/sprites.ts). Diffs consecutive states to drive feedback.
//
// Responsive: the canvas fills its container. On wide screens the camera fits the whole dungeon;
// on narrow ones (phones) it zooms in so tiles stay readable and follows your knight.
import Phaser from "phaser";
import { ChestState, EXTRACT_CHANNEL_MS, MAP, RunState, chainClock, exitsOpenAt } from "./chain";
import { sfx } from "./sound";

export const TILE = 56;
export const SEAT_COLORS = [0x5ab0ff, 0xff6ad5, 0xffa24a, 0xc9f24a];
export const TIER_COLORS: Record<number, number> = { 1: 0x9aa0ad, 2: 0x5ab0ff, 3: 0xf5c04a };
const UNKNOWN_TIER = 0x6b6280; // an opened chest someone else looted: you don't get to know what was in it
const VAULT_GOLD = 0xf5c04a;
const MIN_TILE_PX = 36; // never draw tiles smaller than this on screen; follow the player instead

const FLOOR_SPAN = TILE * 4; // one floor texture covers 4x4 tiles
const WALL_SPAN = TILE * 2; // one wall texture covers 2x2 tiles
const WORLD_W = MAP.W * TILE;
const WORLD_H = MAP.H * TILE;

const center = (t: number) => t * TILE + TILE / 2;
const hex = (c: number) => "#" + c.toString(16).padStart(6, "0");

export class DungeonScene extends Phaser.Scene {
  private state: RunState | null = null;
  private mySeat = -1;
  private players: Phaser.GameObjects.Container[] = [];
  private chests: Phaser.GameObjects.Image[] = [];
  private chestGlows: Phaser.GameObjects.Arc[] = [];
  private sacks: { img: Phaser.GameObjects.Image; label: Phaser.GameObjects.Text }[] = [];
  private exits: { portal: Phaser.GameObjects.Image; glow: Phaser.GameObjects.Arc; lock: Phaser.GameObjects.Text }[] = [];
  private openingTweens = new Map<number, Phaser.Tweens.Tween>();
  private channelRings!: Phaser.GameObjects.Graphics;
  /** When we first saw each seat start channeling (client clock, for the progress ring). */
  private channelSince = new Map<number, number>();
  /** Tiers of chests *you* opened (tiers are private, so only the opener learns them). */
  private knownTiers = new Map<number, number>();
  private exitsWereOpen = false;
  private following = false;
  /** Seat the camera is locked onto (-1: none yet, e.g. your hero wasn't drawn when it tried). */
  private followingSeat = -1;
  /** Which `MAPS` layout the scene was built for. */
  private builtLayout = -1;

  constructor() {
    super("dungeon");
  }

  preload() {
    const base = `${import.meta.env.BASE_URL}sprites/`;
    for (let i = 0; i < 4; i++) this.load.image(`hero${i}`, `${base}hero${i}.png`);
    for (const k of ["chest_closed", "chest_open", "sack", "exit", "floor", "wall"]) this.load.image(k, `${base}${k}.png`);
  }

  create() {
    // create() runs again on restart (new layout / new run): start from a clean slate.
    this.players = [];
    this.chests = [];
    this.chestGlows = [];
    this.sacks = [];
    this.exits = [];
    this.openingTweens.clear();
    this.channelSince.clear();
    this.knownTiers.clear();
    this.exitsWereOpen = false;
    this.followingSeat = -1;
    this.builtLayout = MAP.layout;
    this.drawMap();

    MAP.CHESTS.forEach(([x, y], i) => {
      const vault = i === MAP.VAULT;
      this.chestGlows.push(this.add.circle(center(x), center(y) + 4, TILE * (vault ? 0.62 : 0.42), vault ? VAULT_GOLD : 0xffffff, vault ? 0.25 : 0).setDepth(2));
      const img = this.add.image(center(x), center(y), "chest_closed").setDisplaySize(TILE * (vault ? 1.0 : 0.82), TILE * (vault ? 1.0 : 0.82)).setDepth(3);
      if (vault) {
        img.setTint(0xffe9a8);
        this.tweens.add({ targets: this.chestGlows[i], alpha: 0.45, scale: 1.15, duration: 1100, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
        this.add.text(center(x), y * TILE - 2, "VAULT", { fontFamily: "Silkscreen", fontSize: "12px", color: hex(VAULT_GOLD), stroke: "#0d0b12", strokeThickness: 3 }).setOrigin(0.5).setDepth(6);
      }
      this.chests.push(img);
    });

    for (let i = 0; i < 4; i++) {
      const img = this.add.image(0, 0, "sack").setDisplaySize(TILE * 0.62, TILE * 0.62).setDepth(4).setVisible(false);
      const label = this.add
        .text(0, 0, "?", { fontFamily: "Silkscreen", fontSize: "12px", color: "#f5c04a", stroke: "#0d0b12", strokeThickness: 3 })
        .setOrigin(0.5)
        .setDepth(6)
        .setVisible(false);
      this.sacks.push({ img, label });
    }

    this.channelRings = this.add.graphics().setDepth(9);

    for (let i = 0; i < 4; i++) {
      // [0] "you" marker under the feet, [1] hero sprite, [2] hearts, [3] "YOU" tag
      const ring = this.add.ellipse(0, TILE * 0.36, TILE * 0.74, TILE * 0.26).setStrokeStyle(3, 0xffffff, 0.9).setFillStyle(0xffffff, 0.12).setVisible(false);
      const body = this.add.image(0, -2, `hero${i}`).setDisplaySize(TILE * 1.04, TILE * 1.04);
      const hp = this.add
        .text(0, -TILE * 0.62, "", { fontFamily: "Silkscreen", fontSize: "13px", color: "#ff5a6a", stroke: "#0d0b12", strokeThickness: 3 })
        .setOrigin(0.5);
      const you = this.add
        .text(0, TILE * 0.62, "YOU", { fontFamily: "Silkscreen", fontSize: "10px", color: "#ffffff", stroke: "#0d0b12", strokeThickness: 3 })
        .setOrigin(0.5)
        .setVisible(false);
      this.players.push(this.add.container(0, 0, [ring, body, hp, you]).setVisible(false).setDepth(10));
    }

    this.scale.off("resize", this.onResize, this);
    this.scale.on("resize", this.onResize, this);
    this.fitCamera();

    if (this.state) this.render(null, this.state);
  }

  private onResize() {
    this.fitCamera();
  }

  /** Rebuilds the dungeon for a new run (another layout, fresh chests and private tier memory). */
  resetRun() {
    if (this.sys?.isActive()) this.scene.restart();
  }

  /** Whole dungeon on screen when it fits with readable tiles; otherwise zoom in and follow you. */
  private fitCamera() {
    const cam = this.cameras.main;
    const { width, height } = this.scale.gameSize;
    cam.setViewport(0, 0, width, height);
    const fit = Math.min(width / WORLD_W, height / WORLD_H);
    if (fit * TILE >= MIN_TILE_PX) {
      // No bounds in fit mode: bounds clamp the scroll so a map narrower than the screen hugs the
      // left edge. Without them, centerOn puts the dungeon in the middle of any aspect ratio.
      cam.removeBounds();
      cam.setZoom(fit);
      cam.stopFollow();
      cam.centerOn(WORLD_W / 2, WORLD_H / 2);
      this.following = false;
      this.followingSeat = -1;
    } else {
      cam.setBounds(0, 0, WORLD_W, WORLD_H);
      cam.setZoom(Math.max(fit, MIN_TILE_PX / TILE));
      this.following = true;
      this.followMe();
    }
  }

  private followMe() {
    if (!this.following) return;
    const me = this.players[this.mySeat];
    if (me?.visible) {
      this.cameras.main.startFollow(me, true, 0.15, 0.15);
      this.followingSeat = this.mySeat;
    } else {
      this.cameras.main.centerOn(WORLD_W / 2, WORLD_H / 2);
      this.followingSeat = -1;
    }
  }

  update() {
    const s = this.state;
    if (!s) return;
    // Exits: locked (dim + padlock) until a quarter of the run has passed.
    const open = chainClock.now() >= exitsOpenAt(s);
    if (open !== this.exitsWereOpen) {
      this.exitsWereOpen = open;
      this.exits.forEach((e) => {
        e.portal.setAlpha(open ? 1 : 0.35);
        e.glow.setVisible(open);
        e.lock.setVisible(!open);
      });
      if (open && s.status === 1) {
        sfx.exitsOpen();
        this.flashText("EXITS OPEN", "#4ef0a0");
      }
    }
    // Extraction channels: a ring filling around anyone standing on an exit channeling.
    const g = this.channelRings.clear();
    const now = performance.now();
    this.channelSince.forEach((since, seat) => {
      const c = this.players[seat];
      if (!c?.visible) return;
      const t = Math.min(1, (now - since) / EXTRACT_CHANNEL_MS);
      g.lineStyle(5, 0x0d0b12, 0.8).strokeCircle(c.x, c.y, TILE * 0.56);
      g.lineStyle(4, 0x4ef0a0, 1).beginPath();
      g.arc(c.x, c.y, TILE * 0.56, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2);
      g.strokePath();
    });
  }

  setState(next: RunState, mySeat: number) {
    const prev = this.state;
    this.state = next;
    const seatChanged = mySeat !== this.mySeat;
    this.mySeat = mySeat;
    if (this.sys?.isActive() && this.builtLayout !== MAP.layout) {
      this.scene.restart(); // create() renders this.state on the new map
      return;
    }
    if (this.sys?.isActive() && this.players.length) {
      this.render(prev, next);
      if (seatChanged) this.followMe();
    }
  }

  /** Records the tier of a chest you opened and shows it. */
  revealChest(chest: number, tier: number, name: string) {
    this.knownTiers.set(chest, tier);
    sfx.chest(tier);
    if (!this.players.length) return;
    const [x, y] = MAP.CHESTS[chest];
    this.pop(center(x), y * TILE, name, hex(TIER_COLORS[tier] ?? 0xffffff), tier === 3 ? 22 : 15);
    if (tier === 3) this.cameras.main.flash(220, 245, 192, 74);
    if (this.state) this.renderObjects(this.state);
  }

  /** A floating label over a seat's hero (e.g. your own private loot gains). */
  popAtSeat(seat: number, text: string, color: string, size = 18) {
    const c = this.players[seat];
    if (c?.visible) this.pop(c.x, c.y - 20, text, color, size);
  }

  /** A big centered banner in screen space. */
  flashText(text: string, color: string) {
    const cam = this.cameras.main;
    const t = this.add
      .text(cam.midPoint.x, cam.midPoint.y - 40 / cam.zoom, text, { fontFamily: "Silkscreen", fontSize: `${Math.round(30 / cam.zoom)}px`, color, stroke: "#0d0b12", strokeThickness: 6 })
      .setOrigin(0.5)
      .setDepth(30);
    this.tweens.add({ targets: t, alpha: 0, y: t.y - 30, delay: 900, duration: 700, onComplete: () => t.destroy() });
  }

  private drawMap() {
    // Seamless floor under everything, slightly brightened so sprites still pop.
    this.add.tileSprite(0, 0, WORLD_W, WORLD_H, "floor").setOrigin(0).setTileScale(FLOOR_SPAN / 256).setTint(0xd8d0ee);

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
        if (y + 1 < MAP.H && MAP.LAYOUT[y + 1][x] !== "#") g.fillStyle(0x000000, 0.28).fillRect(x * TILE, (y + 1) * TILE, TILE, 8);
      }

    for (const [x, y] of MAP.EXTRACTS) {
      const glow = this.add.circle(center(x), center(y), TILE * 0.5, 0x4ef0a0, 0.18).setDepth(1).setVisible(false);
      const portal = this.add.image(center(x), center(y), "exit").setDisplaySize(TILE * 0.92, TILE * 0.92).setDepth(2).setAlpha(0.35);
      const lock = this.add.text(center(x), center(y), "🔒", { fontSize: "20px" }).setOrigin(0.5).setDepth(3);
      this.tweens.add({ targets: portal, angle: 360, duration: 9000, repeat: -1 });
      this.tweens.add({ targets: glow, alpha: 0.05, scale: 1.15, duration: 900, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      this.exits.push({ portal, glow, lock });
    }
  }

  private renderObjects(s: RunState) {
    s.chests.forEach((c, i) => {
      const img = this.chests[i];
      const glow = this.chestGlows[i];
      const vault = i === MAP.VAULT;
      if (c.state === ChestState.Opened) {
        this.openingTweens.get(i)?.stop();
        this.openingTweens.delete(i);
        img.setTexture("chest_open").setAlpha(0.85);
        const tier = this.knownTiers.get(i);
        glow.setFillStyle(tier ? TIER_COLORS[tier] : UNKNOWN_TIER, tier ? 0.32 : 0.18);
      } else if (c.state === ChestState.Opening) {
        if (!this.openingTweens.has(i))
          this.openingTweens.set(i, this.tweens.add({ targets: img, alpha: 0.45, duration: 180, yoyo: true, repeat: -1 }));
        glow.setFillStyle(0xf5c04a, 0.22);
      } else {
        img.setTexture("chest_closed").setAlpha(1);
        glow.setFillStyle(vault ? VAULT_GOLD : 0xffffff, vault ? 0.25 : 0);
      }
    });

    s.dropped.forEach((b, i) => {
      const { img, label } = this.sacks[i];
      img.setVisible(b.present).setPosition(center(b.x), center(b.y) + 4);
      // What's inside a sack is private: everyone sees "?" until someone grabs it.
      label.setVisible(b.present).setPosition(center(b.x) + TILE * 0.26, center(b.y) - TILE * 0.22);
    });
  }

  private render(prev: RunState | null, s: RunState) {
    this.renderObjects(s);
    this.time.delayedCall(0, () => {
      if (this.following && this.followingSeat !== this.mySeat) this.followMe();
    });

    for (let i = 0; i < 4; i++) {
      const c = this.players[i];
      const p = s.players[i];
      const me = i === this.mySeat;
      if (i >= s.playerCount || !p.alive || p.extracted) {
        c.setVisible(false);
        this.channelSince.delete(i);
      } else {
        const tx = center(p.x), ty = center(p.y);
        const was = prev?.players[i];
        if (!c.visible || !was) c.setPosition(tx, ty);
        else if (c.x !== tx || c.y !== ty) {
          this.tweens.add({ targets: c, x: tx, y: ty, duration: 80, ease: "Quad.easeOut" });
          this.tweens.add({ targets: c.list[1], y: -8, duration: 40, yoyo: true, ease: "Quad.easeOut" });
          if (tx !== c.x) (c.list[1] as Phaser.GameObjects.Image).setFlipX(tx < c.x);
          if (me) sfx.step();
        }
        c.setVisible(true);
        (c.list[0] as Phaser.GameObjects.Ellipse).setVisible(me);
        (c.list[3] as Phaser.GameObjects.Text).setVisible(me);
        (c.list[2] as Phaser.GameObjects.Text).setText("♥".repeat(p.hp));
        // Channel ring bookkeeping.
        const channeling = p.extractStartSlot.toString() !== "0";
        if (channeling && !this.channelSince.has(i)) {
          this.channelSince.set(i, performance.now());
          if (me) sfx.extractStart();
        } else if (!channeling && this.channelSince.has(i)) {
          this.channelSince.delete(i);
          if (me && p.alive && !p.extracted) sfx.extractCancel();
        }
      }
      if (!prev) continue;
      const was = prev.players[i];
      const at = p.alive ? p : was;
      const cx = center(at.x), cy = center(at.y);
      if (p.hp < was.hp && p.alive) {
        this.cameras.main.shake(me ? 140 : 80, me ? 0.008 : 0.004);
        (me ? sfx.hurt : sfx.hit)();
        this.pop(cx, cy, "-1", "#ff5a6a");
        const body = c.list[1] as Phaser.GameObjects.Image;
        body.setTintFill(0xffffff);
        this.time.delayedCall(70, () => body.clearTint());
        this.tweens.add({ targets: body, alpha: 0.3, duration: 60, yoyo: true, repeat: 1 });
      }
      if (was.alive && !p.alive) {
        this.cameras.main.shake(180, 0.01);
        sfx.death();
        this.pop(cx, cy, "SLAIN", "#ff5a6a", 20);
      }
      if (!was.extracted && p.extracted) {
        sfx.extracted();
        this.pop(cx, cy, "EXTRACTED", "#4ef0a0", 18);
        const ghost = this.add.image(cx, cy - 2, `hero${i}`).setDisplaySize(TILE * 1.04, TILE * 1.04).setDepth(11);
        this.tweens.add({ targets: ghost, alpha: 0, scale: ghost.scale * 0.2, angle: 180, duration: 600, ease: "Cubic.easeIn", onComplete: () => ghost.destroy() });
      }
    }

    prev?.chests.forEach((was, i) => {
      const c = s.chests[i];
      if (was.state === ChestState.Closed && c.state === ChestState.Opening) sfx.chestOpening();
      // Chests other players open: everyone sees it opened, nobody but the opener learns the tier.
      if (was.state !== ChestState.Opened && c.state === ChestState.Opened && c.opener !== this.mySeat) {
        const [x, y] = MAP.CHESTS[i];
        sfx.looted();
        this.pop(center(x), y * TILE, i === MAP.VAULT ? "VAULT LOOTED ?" : "LOOTED ?", hex(UNKNOWN_TIER + 0x303030), 13);
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
    backgroundColor: "#0d0b12",
    scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
    scene: [],
    callbacks: {
      postBoot: (game) => {
        game.scene.add("dungeon", scene, true);
        // Phaser's RESIZE mode only re-measures on window resizes. The stage box also changes size
        // when the page layout shifts, which left the canvas stuck small with empty space to its
        // right. Track the container itself (only once booted: resizing earlier breaks WebGL).
        let last = `${game.scale.width}x${game.scale.height}`;
        new ResizeObserver(() => {
          const w = parent.clientWidth, h = parent.clientHeight;
          if (!w || !h || `${w}x${h}` === last) return;
          last = `${w}x${h}`;
          game.scale.resize(w, h);
        }).observe(parent);
      },
    },
  });
  return scene;
}
