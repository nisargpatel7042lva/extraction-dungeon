// AI opponents. A bot is a real seated player: its own wallet joined the run on-chain, and it acts
// through its own session key on the rollup, exactly like a human. Only its "brain" runs here, in
// the host's browser tab, reading the public run state each tick.
import { Keypair, PublicKey } from "@solana/web3.js";
import { ATTACK_COOLDOWN_MS, Chain, ChestState, EXTRACT_CHANNEL_MS, MAP, RunState, Status, chainClock, exitsOpenAt } from "./chain";
import { Tile, dirTo, isExit, isOpen, manhattan, route, same, sides, DX, DY } from "./path";

export type BotLevel = "easy" | "medium" | "hard";

interface Personality {
  /** Milliseconds between decisions. */
  tick: number;
  /** Chance a decision is replaced by a random step. */
  wander: number;
  /** Chance it attacks an adjacent player when it could. */
  aggression: number;
  /** Will go hunt players within this many steps (0 = never hunts). */
  huntRange: number;
  /** Leaves once its bag reaches this many points... */
  greed: number;
  /** ...or once this fraction of the run is left. */
  leaveAt: number;
  /** Goes for sacks on the floor. */
  scavenges: boolean;
  /** Prefers the Vault over closer chests. */
  vault: boolean;
}

export const LEVELS: Record<BotLevel, Personality & { label: string; blurb: string }> = {
  easy: {
    label: "Easy", blurb: "Slow, wanders, rarely fights, leaves early.",
    tick: 950, wander: 0.35, aggression: 0.25, huntRange: 0, greed: 3, leaveAt: 0.55, scavenges: false, vault: false,
  },
  medium: {
    label: "Medium", blurb: "Loots steadily, fights back, grabs sacks.",
    tick: 480, wander: 0.08, aggression: 0.85, huntRange: 3, greed: 8, leaveAt: 0.35, scavenges: true, vault: false,
  },
  hard: {
    label: "Hard", blurb: "Fast, hunts you down, raids the Vault, camps exits.",
    tick: 230, wander: 0, aggression: 1, huntRange: 10, greed: 14, leaveAt: 0.22, scavenges: true, vault: true,
  },
};

export class Bot {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private lastAttack = 0;
  private channelAt = 0;
  private bagPoints = 0;
  private bagCheckedAt = 0;
  onLog: ((msg: string) => void) | null = null;

  constructor(
    private chain: Chain,
    private run: PublicKey,
    readonly seat: number,
    readonly session: Keypair,
    readonly level: BotLevel,
    private getState: () => RunState | null,
  ) {}

  get label() {
    return `🤖 ${LEVELS[this.level].label}`;
  }

  start() {
    if (this.timer) return;
    // Stagger so several bots don't act in lockstep.
    const p = LEVELS[this.level];
    setTimeout(() => (this.timer = setInterval(() => void this.tick(), p.tick)), Math.random() * p.tick);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.busy) return;
    const s = this.getState();
    if (!s || s.status !== Status.Live) return;
    const me = s.players[this.seat];
    if (!me || !me.alive || me.extracted) return this.stop();
    this.busy = true;
    try {
      await this.decide(s);
    } catch (e) {
      // A move into a tile someone just took, a chest someone just opened...: think again next tick.
      void e;
    } finally {
      this.busy = false;
    }
  }

  private async refreshBag() {
    if (Date.now() - this.bagCheckedAt < 2500) return;
    this.bagCheckedAt = Date.now();
    const b = await this.chain.fetchBag(this.run, this.seat, this.session).catch(() => null);
    if (b) this.bagPoints = b.points;
  }

  private async decide(s: RunState) {
    const p = LEVELS[this.level];
    const me = s.players[this.seat];
    const pos: Tile = [me.x, me.y];
    const now = chainClock.now();
    const left = Number(s.endsAt.toString()) - now;
    const exitsOpen = now >= exitsOpenAt(s);
    const enemies = s.players
      .slice(0, s.playerCount)
      .map((q, i) => ({ q, i }))
      .filter(({ q, i }) => i !== this.seat && q.alive && !q.extracted);
    const guardians = (s.monsters ?? []).filter((g) => g.alive);
    const blocked: Tile[] = [...enemies.map(({ q }) => [q.x, q.y] as Tile), ...guardians.map((g) => [g.x, g.y] as Tile)];
    await this.refreshBag();

    // 1. Mid-extraction: finish it when the channel is done (Hard will fight off an attacker instead).
    const channeling = me.extractStartSlot.toString() !== "0";
    if (channeling) {
      const adjacentEnemy = enemies.find(({ q }) => manhattan(pos, [q.x, q.y]) === 1);
      if (!(this.level === "hard" && adjacentEnemy)) {
        if (Date.now() - this.channelAt >= EXTRACT_CHANNEL_MS) await this.chain.finishExtract(this.session, this.run);
        return;
      }
    }

    // 2. Someone adjacent: fight (cooldown permitting).
    const adj = enemies.find(({ q }) => manhattan(pos, [q.x, q.y]) === 1);
    if (adj && Math.random() < p.aggression) {
      if (Date.now() - this.lastAttack >= ATTACK_COOLDOWN_MS) {
        this.lastAttack = Date.now();
        await this.chain.attack(this.session, this.run, s.playerCount, dirTo(pos, [adj.q.x, adj.q.y]), false);
      }
      return;
    }

    // 2b. A Vault Guardian next to us: fight it for the bounty only when healthy enough (Medium at
    // full health, Hard with 2+ hearts); otherwise back off. Easy always backs off.
    const adjG = guardians.find((g) => manhattan(pos, [g.x, g.y]) === 1);
    if (adjG) {
      const brave = this.level === "hard" ? me.hp >= 2 : this.level === "medium" ? me.hp >= 3 : false;
      if (brave) {
        if (Date.now() - this.lastAttack >= ATTACK_COOLDOWN_MS) {
          this.lastAttack = Date.now();
          await this.chain.attack(this.session, this.run, s.playerCount, dirTo(pos, [adjG.x, adjG.y]), false);
        }
        return;
      }
      return this.randomStep(s, pos, blocked);
    }

    // Random wandering (mostly Easy).
    if (Math.random() < p.wander) return this.randomStep(s, pos, blocked);

    // 3. Time to leave?
    const closedChests = s.chests.map((c, i) => ({ c, i })).filter(({ c }) => c.state === ChestState.Closed);
    const wantOut = left < s.durationSecs * p.leaveAt || this.bagPoints >= p.greed || (!closedChests.length && this.bagPoints > 0);
    if (exitsOpen && wantOut) {
      if (isExit(...pos)) {
        await this.chain.startExtract(this.session, this.run);
        this.channelAt = Date.now();
        return;
      }
      return this.walk(s, pos, MAP.EXTRACTS as Tile[], blocked);
    }

    // 4. Hunt: anyone channeling an extraction is a juicy target; otherwise the nearest player in range.
    if (p.huntRange > 0 && enemies.length) {
      const prey = [...enemies]
        .map((e) => ({ ...e, d: manhattan(pos, [e.q.x, e.q.y]), ch: e.q.extractStartSlot.toString() !== "0" }))
        .filter((e) => e.ch || e.d <= p.huntRange)
        .sort((a, b) => Number(b.ch) - Number(a.ch) || a.d - b.d)[0];
      if (prey) {
        const goals = sides([prey.q.x, prey.q.y]).map((x) => x.tile);
        if (await this.walk(s, pos, goals, blocked)) return;
      }
    }

    // 4b. Hard goes after a guardian standing between it and a closed Vault.
    if (this.level === "hard" && me.hp >= 2 && guardians.length && s.chests[MAP.VAULT].state === ChestState.Closed && this.bagPoints < p.greed) {
      const g = [...guardians].sort((a, b) => manhattan(pos, [a.x, a.y]) - manhattan(pos, [b.x, b.y]))[0];
      if (manhattan(pos, [g.x, g.y]) <= 8 && (await this.walk(s, pos, sides([g.x, g.y]).map((x) => x.tile), blocked))) return;
    }

    // 5. Sacks on the floor: free loot (contents unknown, but never empty of risk).
    if (p.scavenges) {
      const sacks = s.dropped.filter((b) => b.present).map((b) => [b.x, b.y] as Tile);
      if (sacks.length && (await this.walk(s, pos, sacks, blocked))) return;
    }

    // 6. Chests: open one if adjacent, else head for the nearest (Hard prefers the Vault).
    for (const { i } of closedChests) {
      const d = dirTo(pos, MAP.CHESTS[i] as Tile);
      if (d >= 0) {
        await this.chain.openChest(this.session, this.run, this.seat, i);
        return;
      }
    }
    if (closedChests.length) {
      const vault = closedChests.find(({ i }) => i === MAP.VAULT);
      const targets = p.vault && vault ? [vault] : closedChests;
      const goals = targets.flatMap(({ i }) => sides(MAP.CHESTS[i] as Tile).map((x) => x.tile));
      if (await this.walk(s, pos, goals, blocked)) return;
    }

    // 7. Nothing to do yet (e.g. waiting for exits): drift toward the nearest exit, or wander.
    if (!(await this.walk(s, pos, MAP.EXTRACTS as Tile[], blocked))) await this.randomStep(s, pos, blocked);
  }

  /** One step along the BFS route to the nearest goal. Returns false if there's no route. */
  private async walk(s: RunState, pos: Tile, goals: Tile[], blocked: Tile[]): Promise<boolean> {
    const dirs = route(pos, goals, blocked);
    if (!dirs) return false;
    if (!dirs.length) return true; // already there
    await this.chain.move(this.session, this.run, s.playerCount, dirs[0], false);
    return true;
  }

  private async randomStep(s: RunState, pos: Tile, blocked: Tile[]) {
    const options = [0, 1, 2, 3].filter((d) => {
      const n: Tile = [pos[0] + DX[d], pos[1] + DY[d]];
      return isOpen(...n) && !blocked.some((b) => same(b, n));
    });
    if (!options.length) return;
    await this.chain.move(this.session, this.run, s.playerCount, options[Math.floor(Math.random() * options.length)], false);
  }
}
