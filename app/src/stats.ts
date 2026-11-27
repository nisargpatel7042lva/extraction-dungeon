// Public stats page: everything is read live from the devnet program's accounts, so the numbers
// are on-chain facts anyone can verify (no analytics service, no server).
import "./polyfill";
import "./style.css";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { Chain, MAPS, NETS, PROGRAM_ID } from "./chain";
import { initAnalytics } from "./analytics";

initAnalytics();
const net = NETS.devnet;
const chain = new Chain(net);
const base = new Connection(net.base, "confirmed");
const $ = (id: string) => document.getElementById(id)!;
const sol = (l: number) => (l / LAMPORTS_PER_SOL).toFixed(3);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const ago = (sec: number) => {
  const d = Date.now() / 1000 - sec;
  if (d < 90) return "just now";
  if (d < 5400) return `${Math.round(d / 60)} min ago`;
  if (d < 129600) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
};

type Row = {
  key: string;
  status: number; // 0 lobby, 1 live, 2 ended, 3 cancelled
  players: number;
  entry: number;
  pot: number;
  full?: {
    layout: number;
    createdAt: number;
    settled: boolean;
    escaped: number;
    slain: number;
    kills: number;
    chests: number;
    wallets: string[];
    authority: string;
    seats: { wallet: string; kills: number; extracted: boolean }[];
  };
};

/** Every Run account the program owns (runs being played right now are delegated to the rollup
 *  and show up once they're committed back). Older runs from before account upgrades can't be fully
 *  decoded, but their first fields (status, players, stake, pot) haven't moved, so they still count. */
async function loadRuns(): Promise<Row[]> {
  const disc = (chain.program.idl.accounts as { name: string; discriminator: number[] }[]).find((a) => a.name.toLowerCase() === "run")!.discriminator;
  const accounts = await base.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(disc)) } }] });
  return accounts.map(({ pubkey, account }) => {
    const d = account.data;
    const row: Row = {
      key: pubkey.toBase58(),
      status: d[48],
      players: d[49],
      entry: Number(d.readBigUInt64LE(50)),
      pot: Number(d.readBigUInt64LE(58)),
    };
    try {
      const s = chain.decode(d);
      const seated = s.players.slice(0, s.playerCount);
      row.full = {
        layout: s.layout,
        createdAt: Number(s.createdAt.toString()),
        settled: s.settled,
        escaped: seated.filter((p) => p.extracted).length,
        slain: seated.filter((p) => !p.alive).length,
        kills: seated.reduce((a, p) => a + p.kills, 0),
        chests: s.chests.filter((c) => c.state === 2).length,
        wallets: seated.map((p) => p.wallet.toBase58()),
        authority: s.authority.toBase58(),
        seats: seated.map((p) => ({ wallet: p.wallet.toBase58(), kills: p.kills, extracted: p.extracted })),
      };
    } catch {
      /* pre-upgrade layout: prefix fields only */
    }
    return row;
  });
}

/** Every Bag account, keyed "run:seat" → points (bags are public once the run is over). */
async function loadBagPoints(): Promise<Map<string, number>> {
  const disc = (chain.program.idl.accounts as { name: string; discriminator: number[] }[]).find((a) => a.name.toLowerCase() === "bag")!.discriminator;
  const accounts = await base.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(disc)) } }] });
  const out = new Map<string, number>();
  for (const { account } of accounts) {
    try {
      const b = chain.decodeBag(account.data);
      out.set(`${b.run.toBase58()}:${b.seat}`, b.points);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Mirrors Run::payouts: escaped players split the pot by loot (equal if nobody looted);
 *  if nobody escaped, nobody is paid (the pot goes to the treasury). Rounding dust is ignored here. */
function payouts(pot: number, seats: { extracted: boolean }[], points: number[]): number[] {
  const out = seats.map(() => 0);
  const esc = seats.map((p, i) => ({ p, i })).filter(({ p }) => p.extracted);
  if (!seats.length) return out;
  if (!esc.length) return out;
  const total = esc.reduce((a, { i }) => a + points[i], 0);
  for (const { i } of esc) out[i] = total === 0 ? Math.floor(pot / esc.length) : Math.floor((pot * points[i]) / total);
  return out;
}

type Player = { wallet: string; games: number; escapes: number; kills: number; won: number; staked: number; bestBag: number };

async function leaderboard(runs: Row[]) {
  const bags = await loadBagPoints();
  const players = new Map<string, Player>();
  for (const r of runs) {
    if (!r.full || r.status !== 2 || !r.full.settled) continue; // finished and paid out
    const pts = r.full.seats.map((_, i) => bags.get(`${r.key}:${i}`) ?? 0);
    const shares = payouts(r.pot, r.full.seats, pts);
    r.full.seats.forEach((s, i) => {
      const p = players.get(s.wallet) ?? { wallet: s.wallet, games: 0, escapes: 0, kills: 0, won: 0, staked: 0, bestBag: 0 };
      p.games += 1;
      p.escapes += s.extracted ? 1 : 0;
      p.kills += s.kills;
      p.won += shares[i];
      p.staked += r.entry;
      if (s.extracted) p.bestBag = Math.max(p.bestBag, pts[i]);
      players.set(s.wallet, p);
    });
  }
  const top = [...players.values()].sort((a, b) => b.won - b.staked - (a.won - a.staked) || b.escapes - a.escapes || b.kills - a.kills).slice(0, 10);
  const medal = (i: number) => ["🥇", "🥈", "🥉"][i] ?? `${i + 1}`;
  $("leaders").innerHTML =
    top
      .map(
        (p, i) => `<tr class="${i === 0 ? "win" : ""}">
          <td><span class="rank r${i + 1}">${medal(i)}</span></td>
          <td><a href="https://explorer.solana.com/address/${p.wallet}?cluster=devnet" target="_blank" rel="noopener">${p.wallet.slice(0, 4)}…${p.wallet.slice(-4)}</a></td>
          <td class="r">${p.games}</td>
          <td class="r">${p.escapes}</td>
          <td class="r">${p.kills}</td>
          <td class="r">${p.bestBag}</td>
          <td class="r" style="color:${p.won - p.staked >= 0 ? "var(--green)" : "var(--red)"}">${p.won - p.staked >= 0 ? "+" : ""}${sol(p.won - p.staked)}</td>
        </tr>`,
      )
      .join("") || `<tr><td colspan="7" class="muted">No finished games yet.</td></tr>`;
}

async function health() {
  const checks: [string, () => Promise<string>][] = [
    ["Solana devnet RPC", async () => `slot ${(await base.getSlot()).toLocaleString()}`],
    [
      "Game program deployed",
      async () => {
        const a = await base.getAccountInfo(PROGRAM_ID);
        if (!a?.executable) throw new Error("not executable");
        return "executable";
      },
    ],
    [
      "MagicBlock Private Ephemeral Rollup (TEE)",
      async () => {
        const r = await fetch(net.er, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion" }) });
        const j = await r.json();
        return `magicblock-core ${j.result?.["magicblock-core"] ?? j.result?.core ?? "?"}`;
      },
    ],
  ];
  $("health").innerHTML = checks.map(([name]) => `<li><span class="tag">…</span> ${esc(name)}</li>`).join("");
  const items = [...$("health").querySelectorAll("li")];
  await Promise.all(
    checks.map(async ([name, f], i) => {
      try {
        const detail = await f();
        items[i].innerHTML = `<span class="tag out">PASS</span> ${esc(name)} <small class="muted">${esc(detail)}</small>`;
      } catch (e) {
        items[i].innerHTML = `<span class="tag dead">FAIL</span> ${esc(name)} <small class="muted">${esc(String((e as Error).message ?? e)).slice(0, 80)}</small>`;
      }
    }),
  );
}

function tile(label: string, value: string, color = "var(--gold)") {
  return `<div class="stat-tile"><small>${label}</small><b style="color:${color}">${value}</b></div>`;
}

async function render() {
  const runs = await loadRuns();
  const started = runs.filter((r) => r.status === 1 || r.status === 2);
  const finished = runs.filter((r) => r.status === 2);
  const cancelled = runs.filter((r) => r.status === 3);
  const full = runs.filter((r) => r.full);
  const hosts = new Set(full.map((r) => r.full!.authority));
  const wallets = new Set(full.flatMap((r) => r.full!.wallets));
  const seats = started.reduce((a, r) => a + r.players, 0);
  const staked = started.reduce((a, r) => a + r.entry * r.players, 0);
  const settled = full.filter((r) => r.full!.settled && r.status === 2);
  const unclaimed = settled.filter((r) => !r.full!.seats.some((s) => s.extracted));
  const paid = settled.filter((r) => r.full!.seats.some((s) => s.extracted)).reduce((a, r) => a + r.pot, 0);
  const lost = unclaimed.reduce((a, r) => a + r.pot, 0);
  const refunded = cancelled.reduce((a, r) => a + r.entry * r.players, 0);
  const sum = (k: "escaped" | "slain" | "kills" | "chests") => full.filter((r) => r.status === 2).reduce((a, r) => a + r.full![k], 0);

  $("tiles").innerHTML = [
    tile("GAMES CREATED", String(runs.length), "var(--cyan)"),
    tile("GAMES PLAYED", String(started.length), "var(--pink)"),
    tile("GAMES FINISHED", String(finished.length), "var(--green)"),
    tile("SEATS FILLED", String(seats), "var(--gold)"),
    tile("UNIQUE HOSTS", String(hosts.size), "var(--cyan)"),
    tile("UNIQUE WALLETS", String(wallets.size), "var(--pink)"),
    tile("SOL STAKED", sol(staked), "var(--gold)"),
    tile("SOL PAID OUT", sol(paid), "var(--green)"),
    tile("SOL LOST TO THE DUNGEON", `${sol(lost)} · ${unclaimed.length} runs`, "var(--red)"),
    tile("ESCAPES", String(sum("escaped")), "var(--green)"),
    tile("KILLS", String(sum("kills")), "var(--red)"),
    tile("CHESTS OPENED (VRF)", String(sum("chests")), "var(--gold)"),
    tile("LOBBIES REFUNDED", `${cancelled.length} · ${sol(refunded)} SOL`, "var(--cyan)"),
  ].join("");

  const maps = MAPS.map((m, i) => ({ name: m.name, n: full.filter((r) => r.full!.layout === i && r.status !== 3).length }));
  const max = Math.max(1, ...maps.map((m) => m.n));
  $("maps").innerHTML = maps
    .map((m) => `<div class="bar-row"><span>${m.name}</span><i style="width:${(m.n / max) * 100}%"></i><b>${m.n}</b></div>`)
    .join("");

  const recent = full
    .filter((r) => r.full!.createdAt > 0)
    .sort((a, b) => b.full!.createdAt - a.full!.createdAt)
    .slice(0, 15);
  const statusName = (r: Row) => ["LOBBY", "LIVE", r.full?.settled ? "PAID" : "ENDED", "REFUNDED"][r.status] ?? "?";
  $("recent").innerHTML =
    recent
      .map(
        (r) => `<tr>
          <td>${ago(r.full!.createdAt)}</td>
          <td>${MAPS[r.full!.layout]?.name ?? "?"}</td>
          <td class="r">${r.entry ? sol(r.entry) : "FREE"}</td>
          <td class="r">${r.players}</td>
          <td class="r">${r.full!.escaped}</td>
          <td><span class="tag ${r.status === 2 ? "out" : r.status === 3 ? "cpu" : ""}">${statusName(r)}</span></td>
          <td><a href="https://explorer.solana.com/address/${r.key}?cluster=devnet" target="_blank" rel="noopener">${r.key.slice(0, 4)}…${r.key.slice(-4)} ↗</a></td>
        </tr>`,
      )
      .join("") || `<tr><td colspan="7" class="muted">No games yet.</td></tr>`;
  await leaderboard(runs).catch((e) => ($("leaders").innerHTML = `<tr><td colspan="7" class="muted">${esc(String((e as Error).message))}</td></tr>`));
  $("updated").textContent = `Read from the program's accounts on Solana devnet at ${new Date().toLocaleTimeString()}. ${runs.length - full.length} older games predate the latest account format and count only in the totals.`;
}

$("program").innerHTML = `<a href="https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet" target="_blank" rel="noopener">${PROGRAM_ID.toBase58()} ↗</a>`;
void health();
render().catch((e) => ($("updated").textContent = `Couldn't load stats: ${(e as Error).message}`));
setInterval(() => void render().catch(() => {}), 60_000);
