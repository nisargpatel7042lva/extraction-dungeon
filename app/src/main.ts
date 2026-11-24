import "./polyfill";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  ATTACK_COOLDOWN_MS,
  BagState,
  Chain,
  ChestState,
  EXTRACT_CHANNEL_MS,
  MAP,
  NETS,
  Net,
  RunState,
  Status,
  TIER_NAMES,
  LOBBY_TIMEOUT_SECS,
  WalletSigner,
  chainClock,
  exitsOpenAt,
  useLayout,
} from "./chain";
import { DungeonScene, SEAT_COLORS, startGame } from "./game";
import { connectPhantom, devWallet, hasPhantom, sessionKey } from "./wallet";
import { Bot, BotLevel, LEVELS } from "./bot";
import bs58 from "bs58";
import { initGuide } from "./guide";
import { isMuted, music, setMuted, sfx } from "./sound";

// ---------- setup ----------

const params = new URLSearchParams(location.search);
const isLocalHost = ["localhost", "127.0.0.1"].includes(location.hostname);
const net = (params.get("net") ?? (isLocalHost ? "local" : "devnet")) as Net;
const chain = new Chain(NETS[net]);
chain.onActionError = (m, signer) => {
  if (!session || !signer.equals(session.publicKey)) return; // a CPU bumped into something: it re-plans
  if (/6022|0x1786/.test(m)) return; // attack cooldown: the meter already shows it
  toast(friendly(new Error(m)), true);
};

const $ = (id: string) => document.getElementById(id)!;
const screen = $("screen");
const stage = $("stage");
const hud = $("hud");
const gameEl = $("game");

const isTouch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
document.body.classList.toggle("touch", isTouch);

let wallet: WalletSigner | null = null;
let runKey: PublicKey | null = params.get("run") ? new PublicKey(params.get("run")!) : null;
let state: RunState | null = null;
let onEr = false;
let session: Keypair | null = null;
let scene: DungeonScene | null = null;
let unsub: (() => void) | null = null;
let busy = false;
const queue: (() => Promise<unknown>)[] = [];

// Your private bag (only readable by your session key while the run is live).
let myBag: BagState | null = null;
let bagUnsub: (() => void) | null = null;
const revealedChests = new Set<number>();
let lastAttackAt = 0;

// ---------- AI bots (run by the host's tab) ----------
interface BotRec {
  seat: number;
  level: BotLevel;
  wallet: Keypair;
  session: Keypair;
  brain?: Bot;
}
let bots: BotRec[] = [];

function botKey(run: PublicKey) {
  return `ed:bots:${run.toBase58()}`;
}
function saveBots() {
  if (!runKey) return;
  try {
    sessionStorage.setItem(
      botKey(runKey),
      JSON.stringify(bots.map((b) => ({ seat: b.seat, level: b.level, wallet: bs58.encode(b.wallet.secretKey), session: bs58.encode(b.session.secretKey) }))),
    );
  } catch {
    /* storage blocked: bots won't survive a reload */
  }
}
function loadBots(run: PublicKey) {
  bots = [];
  try {
    const raw = sessionStorage.getItem(botKey(run));
    if (!raw) return;
    bots = (JSON.parse(raw) as { seat: number; level: BotLevel; wallet: string; session: string }[]).map((b) => ({
      seat: b.seat,
      level: b.level,
      wallet: Keypair.fromSecretKey(bs58.decode(b.wallet)),
      session: Keypair.fromSecretKey(bs58.decode(b.session)),
    }));
  } catch {
    bots = [];
  }
}
function botAt(seat: number) {
  return bots.find((b) => b.seat === seat);
}
function who(seat: number, wallet0: PublicKey) {
  const b = botAt(seat);
  return b ? `🤖 ${LEVELS[b.level].label} bot` : short(wallet0);
}

async function addBot(level: BotLevel) {
  const wallet0 = Keypair.generate();
  const session0 = Keypair.generate();
  const seat = await chain.joinBot(wallet!, runKey!, wallet0, session0.publicKey);
  bots.push({ seat, level, wallet: wallet0, session: session0 });
  saveBots();
  if (state?.status === Status.Lobby) showLobby(); // the chain update may have rendered before we knew it's a bot
  toast(`${LEVELS[level].label} bot joined. Making its bag private…`);
  await chain.ensureBagPermission(session0, runKey!, seat).catch((e) => toast(`Bot bag permission: ${friendly(e)}`, true));
}

function startBots() {
  for (const b of bots) {
    if (b.brain) continue;
    b.brain = new Bot(chain, runKey!, b.seat, b.session, b.level, () => state);
    b.brain.start();
  }
}

/** After the payout, send the bots' winnings and leftover fees back to the host's wallet. */
async function returnBotFunds() {
  if (!wallet || !bots.length) return;
  let total = 0;
  for (const b of bots) {
    b.brain?.stop();
    for (const kp of [b.wallet, b.session]) total += await chain.sweep(kp, wallet.publicKey).catch(() => 0);
  }
  if (total > 0) toast(`Returned ${sol(total)} SOL from your bots to your wallet`);
}

const sol = (lamports: { toString(): string } | number) => (Number(lamports.toString()) / LAMPORTS_PER_SOL).toFixed(3);
const short = (k: PublicKey) => k.toBase58().slice(0, 4) + "…" + k.toBase58().slice(-4);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const hexColor = (c: number) => "#" + c.toString(16).padStart(6, "0");
const clock = (secs: number) => `${Math.floor(secs / 60)}:${String(Math.max(0, secs) % 60).padStart(2, "0")}`;

/** Arcade coin shower over the whole page. */
function coinRain(n: number) {
  const box = document.createElement("div");
  box.className = "coinrain";
  for (let i = 0; i < n; i++) {
    const c = document.createElement("i");
    c.style.left = `${Math.random() * 100}vw`;
    c.style.animationDuration = `${1.4 + Math.random() * 1.6}s`;
    c.style.animationDelay = `${Math.random() * 0.9}s`;
    const size = 12 + Math.random() * 14;
    c.style.width = c.style.height = `${size}px`;
    box.appendChild(c);
  }
  document.body.appendChild(box);
  for (let i = 0; i < 6; i++) setTimeout(() => sfx.coin(), i * 180);
  setTimeout(() => box.remove(), 4000);
}

// Every button blips like a cabinet button (D-pad and EXIT have their own game sounds).
document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest?.("button");
  if (b && !b.disabled && !b.closest("#touch")) sfx.select();
});

function toast(msg: string, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = err ? "err" : "";
  t.hidden = false;
  clearTimeout((toast as any).h);
  (toast as any).h = setTimeout(() => (t.hidden = true), err ? 5000 : 2500);
}

function friendly(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  const custom = m.match(/"Custom":(\d+)/)?.[1] ?? m.match(/custom program error: 0x([0-9a-f]+)/i)?.[1];
  const code = custom ? (m.includes("0x") ? parseInt(custom, 16) : Number(custom)) : null;
  if (code !== null) {
    const errors = chain.program.idl.errors as { code: number; name: string; msg?: string }[] | undefined;
    const err = errors?.find((x) => x.code === code);
    if (err) return err.msg ?? err.name;
  }
  if (/429|rate limit/i.test(m)) return "The network is busy, try again in a moment.";
  return m.length > 160 ? m.slice(0, 160) + "…" : m;
}

async function guarded(label: string, f: () => Promise<unknown>) {
  try {
    await f();
  } catch (e) {
    console.error(label, e);
    toast(`${label}: ${friendly(e)}`, true);
  }
}

function mySeat(): number {
  if (!state || !wallet) return -1;
  return state.players.slice(0, state.playerCount).findIndex((p) => p.wallet.equals(wallet!.publicKey));
}

// ---------- layout modes ----------

function setMode(mode: "landing" | "live") {
  document.body.classList.toggle("mode-live", mode === "live");
  document.body.classList.toggle("mode-landing", mode === "landing");
  stage.hidden = mode !== "live";
  if (mode === "live") music.start();
  else music.stop();
  const h = (document.querySelector(".topbar") as HTMLElement).offsetHeight;
  document.documentElement.style.setProperty("--topbar-h", `${h}px`);
}
window.addEventListener("resize", () => {
  const h = (document.querySelector(".topbar") as HTMLElement).offsetHeight;
  document.documentElement.style.setProperty("--topbar-h", `${h}px`);
});

// Sprites for every seat up front: the lobby and HUD rebuild often, and a hero image that first
// loads mid-rebuild (the 4th seat is often the first time hero3 is needed) shows up blank.
for (let i = 0; i < 4; i++) new Image().src = `/sprites/hero${i}.png`;

// ---------- sound, music and fullscreen toggles (topbar + in-game HUD) ----------

function renderToggles() {
  document.querySelectorAll<HTMLElement>("[data-act=mute]").forEach((b) => (b.textContent = isMuted() ? "🔇" : "🔊"));
  document.querySelectorAll<HTMLElement>("[data-act=music]").forEach((b) => b.classList.toggle("off", !music.isOn()));
  document.querySelectorAll<HTMLElement>("[data-act=fs]").forEach((b) => {
    b.hidden = !fsSupported();
    b.textContent = document.fullscreenElement ? "🗗" : "⛶";
    b.title = document.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
  });
}

// Fullscreen by default: browsers only allow it from a user gesture, so the first tap, click or key
// press anywhere goes fullscreen. If the player leaves it (Esc, or the button), we respect that
// until they press the fullscreen button again.
const fsSupported = () => !!document.documentElement.requestFullscreen && document.fullscreenEnabled !== false;
let fsOptOut = false;
function enterFullscreen() {
  if (!fsSupported() || document.fullscreenElement) return;
  document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
}
["pointerdown", "keydown"].forEach((ev) =>
  window.addEventListener(
    ev,
    (e) => {
      if (fsOptOut || (e as KeyboardEvent).key === "Escape") return;
      if ((e.target as HTMLElement)?.closest?.("[data-act=fs]")) return; // the button handles itself
      enterFullscreen();
    },
    { passive: true },
  ),
);
let fsWasOn = false;
document.addEventListener("fullscreenchange", () => {
  if (fsWasOn && !document.fullscreenElement) fsOptOut = true; // the player left fullscreen on purpose
  fsWasOn = !!document.fullscreenElement;
  renderToggles();
});

document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest?.<HTMLElement>("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "mute") setMuted(!isMuted());
  else if (act === "music") music.setOn(!music.isOn());
  else if (act === "fs") {
    if (document.fullscreenElement) {
      fsOptOut = true;
      void document.exitFullscreen();
    } else {
      fsOptOut = false;
      enterFullscreen();
    }
  }
  renderToggles();
});
renderToggles();

// ---------- screens ----------

function renderWallet() {
  $("wallet").innerHTML = wallet
    ? `<span class="tag">${net}</span><span class="mono">${short(wallet.publicKey)}</span>`
    : `<span class="tag">${net}</span>`;
}

function showConnect() {
  setMode("landing");
  screen.className = "card";
  screen.innerHTML = `
    <h2>▶ Press start</h2>
    <p class="muted">Connect a wallet to open a run, or join one from an invite link.</p>
    <div class="row">
      ${NETS[net].airdrop || params.has("dev") ? `<button id="dev" class="big">Dev wallet</button>` : ""}
      <button id="ph" class="big ${NETS[net].airdrop || params.has("dev") ? "ghost" : ""}" ${hasPhantom() ? "" : "disabled"}>Connect Phantom</button>
      <button class="ghost" data-guide>How to play</button>
    </div>
    ${hasPhantom() ? "" : `<p class="muted">Phantom not detected. <a href="https://phantom.com/download" target="_blank" rel="noopener">Get Phantom</a>${isTouch ? " and open this page in Phantom's built-in browser" : ""}.</p>`}
    ${net === "devnet" ? `<p class="muted">Runs on Solana <b>devnet</b>: switch Phantom to devnet (Settings → Developer settings → Testnet mode) and grab free devnet SOL at <a href="https://faucet.solana.com" target="_blank" rel="noopener">faucet.solana.com</a>. A run costs about 0.02 SOL plus your stake.</p>` : ""}`;
  $("dev")?.addEventListener("click", () => guarded("Dev wallet", async () => connected(await devWallet(chain))));
  $("ph").addEventListener("click", () => guarded("Phantom", async () => connected(await connectPhantom())));
}

async function connected(w: WalletSigner) {
  wallet = w;
  renderWallet();
  if (runKey) await openRun(runKey);
  else showCreate();
}

function showCreate() {
  setMode("landing");
  screen.className = "card";
  screen.innerHTML = `
    <h2>★ New game</h2>
    <label>Insert coins · stake (SOL)</label>
    <div class="chips" id="stakes">
      ${["0", "0.01", "0.05", "0.1"].map((v) => `<button class="chip stake" data-v="${v}"><span class="coin"></span>${v === "0" ? "FREE" : v}</button>`).join("")}
    </div>
    <input id="entry" type="number" min="0" step="0.01" value="0.05" inputmode="decimal" style="margin-top:10px" aria-label="Custom stake" />
    <label>Timer</label>
    <div class="chips">
      <button class="chip dur" data-d="120">2:00</button>
      <button class="chip dur" data-d="180">3:00</button>
      <button class="chip dur" data-d="300">5:00</button>
    </div>
    <input id="dur" type="hidden" value="180" />
    <div class="row"><button id="create" class="big pink">Create game</button></div>
    <p class="muted">Share the invite link with up to 3 friends, or add CPU bots in the lobby. FREE runs are practice: no stake, just glory.</p>`;
  const pickIn = (sel: string, b: HTMLButtonElement) => screen.querySelectorAll<HTMLButtonElement>(sel).forEach((x) => x.classList.toggle("on", x === b));
  const stakes = [...screen.querySelectorAll<HTMLButtonElement>(".stake")];
  stakes.forEach((b) =>
    b.addEventListener("click", () => {
      pickIn(".stake", b);
      ($("entry") as HTMLInputElement).value = b.dataset.v!;
      sfx.coin();
    }),
  );
  ($("entry") as HTMLInputElement).addEventListener("input", (e) => {
    const v = (e.target as HTMLInputElement).value;
    stakes.forEach((x) => x.classList.toggle("on", Number(x.dataset.v) === Number(v)));
  });
  pickIn(".stake", stakes[2]);
  const durs = [...screen.querySelectorAll<HTMLButtonElement>(".dur")];
  const pick = (b: HTMLButtonElement) => {
    pickIn(".dur", b);
    ($("dur") as HTMLInputElement).value = b.dataset.d!;
  };
  durs.forEach((b) => b.addEventListener("click", () => pick(b)));
  pick(durs[1]);
  $("create").addEventListener("click", () =>
    guarded("Create", async () => {
      const entry = Math.round(Number(($("entry") as HTMLInputElement).value) * LAMPORTS_PER_SOL);
      const dur = Number(($("dur") as HTMLInputElement).value);
      ($("create") as HTMLButtonElement).disabled = true;
      try {
        const { run } = await chain.createRun(wallet!, entry, dur);
        const url = new URL(location.href);
        url.searchParams.set("run", run.toBase58());
        history.replaceState(null, "", url);
        runKey = run;
        await openRun(run);
      } finally {
        ($("create") as HTMLButtonElement | null)?.removeAttribute("disabled");
      }
    }),
  );
}

async function openRun(run: PublicKey) {
  session = sessionKey(run);
  loadBots(run);
  const got = await chain.fetchRun(run);
  if (!got) {
    setMode("landing");
    screen.innerHTML = `<h2>Run not found</h2><p class="muted mono">${run.toBase58()}</p><p class="muted">If the host just started it, give it a few seconds and reload.</p>`;
    return;
  }
  apply(got.state, got.onEr);
  watch();
  const me = mySeat();
  if (me >= 0 && got.state.status !== Status.Ended) void protectBag(me);
}

/** Subscribe to wherever the run lives now. Re-run when it moves (delegation / commit). */
function watch() {
  unsub?.();
  unsub = chain.subscribe(onEr ? "er" : "base", runKey!, (s) => apply(s, onEr), () => void waitForEr());
}

function apply(s: RunState, isEr: boolean) {
  const wasLive = state?.status === Status.Live && onEr;
  state = s;
  onEr = isEr;
  useLayout(s.layout ?? 0);
  if (s.status === Status.Lobby) return showLobby();
  if (s.status === Status.Live) {
    if (!isEr) return void waitForEr();
    if (!wasLive) sfx.start();
    revealMyChests();
    return showLive();
  }
  if (s.status === Status.Ended) {
    if (isEr) return void waitForBase();
    return void showEnded();
  }
  if (s.status === Status.Cancelled) return void showCancelled();
}

/** A lobby that never started: every stake went back. */
function showCancelled() {
  const s = state!;
  setMode("landing");
  void returnSessionFunds();
  void returnBotFunds();
  screen.className = "card red";
  screen.innerHTML = `
    <div class="gameover">
      <div class="go-title neon-red">CANCELLED</div>
      <div class="go-sub">This lobby never started</div>
      <p>${Number(s.entryLamports.toString()) > 0 ? `Every player got their <b class="neon-gold">${sol(s.entryLamports)} SOL</b> stake back.` : "It was a free run: nothing was staked."}</p>
      <div class="row" style="justify-content:center"><button id="again" class="big pink">▶ New game</button></div>
    </div>`;
  $("again").addEventListener("click", newGame);
}

/** Makes your bag private on the TEE. Idempotent; safe to call again after a reload. */
let protecting: Promise<unknown> | null = null;
function protectBag(seat: number) {
  if (!session || !runKey) return;
  protecting ??= chain
    .ensureBagPermission(session, runKey, seat)
    .catch((e) => toast(`Couldn't make your bag private yet: ${friendly(e)}`, true))
    .finally(() => (protecting = null));
  return protecting;
}

let waitingForEr = false;
async function waitForEr() {
  if (waitingForEr || onEr) return;
  waitingForEr = true;
  unsub?.();
  setMode("landing");
  screen.className = "card pink";
  screen.innerHTML = `<div class="loading"><h2 class="blink">Loading stage…</h2><div class="bar"><i></i></div><p class="muted">Handing the dungeon to the Private Ephemeral Rollup.</p></div>`;
  try {
    // Any seated identity can set the run's public permission: you, or one of your bots.
    const setter = mySeat() >= 0 ? session : bots[0]?.session;
    if (setter) await chain.ensureRunPermission(setter, runKey!).catch(() => {});
    const s = await chain.waitForEr(runKey!);
    apply(s, true);
    watch();
  } catch (e) {
    screen.innerHTML += `<p class="muted">${esc(friendly(e))}</p><div class="row"><button onclick="location.reload()">Retry</button></div>`;
  } finally {
    waitingForEr = false;
  }
}

async function waitForBase() {
  unsub?.();
  bagUnsub?.();
  bagUnsub = null;
  setMode("landing");
  screen.className = "card gold";
  screen.innerHTML = `<div class="loading"><h2 class="blink">Counting the loot…</h2><div class="bar"><i></i></div><p class="muted">Committing the run and every bag back to Solana.</p></div>`;
  try {
    const s = await chain.waitForBase(runKey!, Status.Ended, 90_000, state?.playerCount ?? 0);
    apply(s, false);
    watch();
  } catch (e) {
    screen.innerHTML += `<p class="muted">${esc(friendly(e))}</p>`;
  }
}

function seatsHtml(s: RunState, compact = false) {
  const me = mySeat();
  return (
    s.players
      .slice(0, s.playerCount)
      .map((p, i) => {
        const col = hexColor(SEAT_COLORS[i]);
        const tag = p.extracted ? `<span class="tag out">out</span>` : !p.alive ? `<span class="tag dead">slain</span>` : "";
        const bag = i === me ? `${myBag?.points ?? 0}` : "?";
        const stat = s.status === Status.Lobby ? "" : `<span class="muted">${compact ? "" : "bag "}${bag} · ♥${p.hp} · ⚔${p.kills}</span>`;
        const bot = botAt(i);
        const name = i === me ? "you" : bot ? `🤖 ${LEVELS[bot.level].label} bot` : short(p.wallet);
        return `<div class="seat"><span class="dot" style="background:${col}"></span><span class="nm ${i === me ? "you" : bot ? "" : "mono"}">${name}</span>${tag}<span style="margin-left:auto">${stat}</span></div>`;
      })
      .join("") || `<p class="muted">Nobody yet.</p>`
  );
}

/** Anyone may cancel a lobby once it has waited LOBBY_TIMEOUT_SECS (by the chain's clock). */
function lobbyExpired(s: RunState) {
  return chainClock.now() >= Number(s.createdAt.toString()) + LOBBY_TIMEOUT_SECS;
}

let lastLobbyHtml = "";
function showLobby() {
  const s = state!;
  setMode("landing");
  const me = mySeat();
  const isHost = wallet!.publicKey.equals(s.authority);
  const slots = [0, 1, 2, 3]
    .map((i) => {
      const col = hexColor(SEAT_COLORS[i]);
      if (i >= s.playerCount)
        return `<div class="slot empty"><span class="pn">P${i + 1}</span><small class="blink">INSERT<br/>COIN</small><span></span></div>`;
      const p = s.players[i];
      const bot = botAt(i);
      const name = i === me ? "YOU" : bot ? `CPU<br/>${LEVELS[bot.level].label}` : short(p.wallet);
      return `<div class="slot ${i === me ? "me" : ""}"><span class="pn" style="color:${col}">P${i + 1}</span><img src="/sprites/hero${i}.png" alt="" /><span class="nm">${name}</span></div>`;
    })
    .join("");
  const html = `
    <h2>Player select</h2>
    <p class="stage-name">STAGE ${MAP.layout + 1} · <b class="neon-cyan">${MAP.name}</b></p>
    <div class="pot">
      <div><small>POT</small><b>${sol(s.pot)}</b></div>
      <div><small>ENTRY</small><b>${sol(s.entryLamports)}</b></div>
      <div><small>TIMER</small><b>${clock(s.durationSecs)}</b></div>
    </div>
    <div class="slots" data-lobby>${slots}</div>
    <div class="row">
      ${me < 0 && s.playerCount < 4 ? `<button id="join" class="big">Join · ${sol(s.entryLamports)} SOL</button>` : ""}
      ${isHost ? `<button id="start" class="big green ${s.playerCount > 1 ? "blink-btn" : ""}" ${s.playerCount ? "" : "disabled"}>Start game</button>` : ""}
      <button id="copy" class="ghost">Copy invite</button>
    </div>
    ${
      isHost && s.playerCount < 4
        ? `<div class="bots">
            <label style="margin-top:0">No player 2? Add a CPU</label>
            <div class="bot-levels">
              ${(Object.keys(LEVELS) as BotLevel[]).map((l) => `<button class="ghost bot-add" data-level="${l}">+ CPU ${LEVELS[l].label}<small>${LEVELS[l].blurb}</small></button>`).join("")}
            </div>
            <p class="muted" style="margin-bottom:0">CPUs stake from your wallet and everything they win comes back to you. They run in this tab, so keep it open.</p>
          </div>`
        : ""
    }
    ${me >= 0 ? `<p class="muted">🔒 Your bag is private: only this tab can see what you carry.</p>` : ""}
    ${isHost ? "" : `<p class="muted blink">Waiting for the host to press start…</p>`}
    ${
      s.playerCount && (isHost || lobbyExpired(s))
        ? `<div class="row"><button id="cancel" class="ghost small">✖ Cancel &amp; refund everyone</button></div>`
        : s.playerCount
          ? `<p class="muted" style="font-size:16px">If the host never starts, anyone can cancel and refund every stake from ${new Date((Number(s.createdAt.toString()) + LOBBY_TIMEOUT_SECS) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p>`
          : ""
    }`;
  // Chain updates re-render the lobby often; skipping identical rebuilds keeps sprites from flashing.
  if (screen.querySelector("[data-lobby]") && lastLobbyHtml === html) return;
  lastLobbyHtml = html;
  screen.className = "card";
  screen.innerHTML = html;
  $("cancel")?.addEventListener("click", () =>
    guarded("Cancel", async () => {
      if (!confirm("Cancel this lobby and refund every stake?")) return;
      ($("cancel") as HTMLButtonElement).disabled = true;
      await chain.cancelRun(wallet!, runKey!, s);
      toast("Lobby cancelled: every stake refunded");
    }),
  );
  screen.querySelectorAll<HTMLButtonElement>(".bot-add").forEach((b) =>
    b.addEventListener("click", () =>
      guarded("Add bot", async () => {
        screen.querySelectorAll<HTMLButtonElement>(".bot-add").forEach((x) => (x.disabled = true));
        try {
          await addBot(b.dataset.level as BotLevel);
        } finally {
          screen.querySelectorAll<HTMLButtonElement>(".bot-add").forEach((x) => (x.disabled = false));
        }
      }),
    ),
  );
  $("join")?.addEventListener("click", () =>
    guarded("Join", async () => {
      ($("join") as HTMLButtonElement).disabled = true;
      const seat = await chain.joinRun(wallet!, runKey!, session!.publicKey);
      toast("Joined. Making your bag private…");
      await protectBag(seat);
    }),
  );
  $("start")?.addEventListener("click", () =>
    guarded("Start", async () => {
      ($("start") as HTMLButtonElement).disabled = true;
      await chain.startRun(wallet!, runKey!, s.runId);
      await waitForEr();
    }),
  );
  $("copy").addEventListener("click", () => {
    const url = new URL(location.href);
    url.searchParams.delete("dev");
    navigator.clipboard.writeText(url.toString()).then(() => toast("Invite link copied"));
  });
}

function showLive() {
  setMode("live");
  screen.innerHTML = "";
  if (!scene) scene = startGame(gameEl);
  startClockSync();
  startBots();
  watchMyBag();
  pushToScene();
  renderHud();
}

/** Subscribes to your private bag through your session key's TEE connection. */
function watchMyBag() {
  const me = mySeat();
  if (me < 0 || !session || bagUnsub) return;
  const onBag = (b: BagState) => {
    const prev = myBag;
    myBag = b;
    if (prev && b.points > prev.points) {
      scene?.popAtSeat(me, `+${b.points - prev.points}`, "#f5c04a");
      if (b.lastTier === prev.lastTier) sfx.pickup(); // a sack, not a chest
    }
    revealMyChests();
    renderHud();
  };
  bagUnsub = chain.subscribeBag(session, runKey!, me, onBag);
  void chain.fetchBag(runKey!, me, session).then((b) => b && onBag(b));
}

/** Chests you opened: once the VRF result is in your bag, show its tier (to you only). */
function revealMyChests() {
  const me = mySeat();
  if (!state || me < 0 || !myBag?.lastTier) return;
  state.chests.forEach((c, i) => {
    if (c.state === ChestState.Opened && c.opener === me && !revealedChests.has(i)) {
      revealedChests.add(i);
      scene?.revealChest(i, myBag!.lastTier, `${i === MAP.VAULT ? "VAULT: " : ""}${TIER_NAMES[myBag!.lastTier] ?? "?"}`);
    }
  });
}

// Countdowns follow the rollup's clock, not the device's (they differ by seconds).
function secondsLeft(): number {
  return state ? Math.max(0, Math.ceil(Number(state.endsAt.toString()) - chainClock.now())) : 0;
}
function exitsIn(): number {
  return state ? Math.max(0, Math.ceil(exitsOpenAt(state) - chainClock.now())) : 0;
}
let clockTimer: ReturnType<typeof setInterval> | null = null;
function startClockSync() {
  if (clockTimer) return;
  const sync = () => chain.syncClock().catch(() => {});
  void sync();
  clockTimer = setInterval(sync, 30_000);
}
function attackReady(): number {
  return Math.min(1, (performance.now() - lastAttackAt) / ATTACK_COOLDOWN_MS);
}
function channeling(): boolean {
  const me = mySeat();
  return !!state && me >= 0 && state.players[me].extractStartSlot.toString() !== "0";
}

function renderHud() {
  const s = state;
  if (!s || s.status !== Status.Live) return;
  const me = mySeat();
  const p = me >= 0 ? s.players[me] : null;
  const left = secondsLeft();
  const resolved = s.players.slice(0, s.playerCount).every((x) => !x.alive || x.extracted);
  const canEnd = left === 0 || resolved;
  const pts = myBag?.points ?? 0;
  const active = p && p.alive && !p.extracted;
  const onExit = active && MAP.EXTRACTS.some(([x, y]) => x === p.x && y === p.y);
  const xIn = exitsIn();

  let msg = "";
  if (p && !p.alive) msg = `<span style="color:var(--red)">You were slain. Your bag is on the floor as a sack.</span>`;
  else if (p?.extracted) msg = `<span style="color:var(--green)">You got out with ${pts} pts.</span>`;
  else if (channeling()) msg = `<span style="color:var(--green)">Extracting… hold still!</span>`;
  else if (onExit && xIn > 0) msg = `<span class="muted">Exits unlock in <b class="xin">${clock(xIn)}</b></span>`;
  else if (onExit) msg = `<span style="color:var(--green)">On the exit: press ${isTouch ? "<b>EXIT</b>" : "<kbd>E</kbd>"} and hold still for 2 s.</span>`;

  hud.innerHTML = `
    <div class="hud-box hud-main">
      <div class="stat"><small>Time</small><b class="timer ${left <= 15 ? "low" : ""}">${clock(left)}</b></div>
      <div class="stat"><small>Pot</small><b>${sol(s.pot)}</b></div>
      ${p ? `<div class="stat"><small>Your bag 🔒</small><b>${pts}</b></div>` : ""}
      <div class="stat"><small>Exits</small><b class="exits ${xIn ? "" : "open"}">${xIn ? clock(xIn) : "OPEN"}</b></div>
      ${active ? `<div class="stat"><small>Attack</small><div class="meter"><i></i></div></div>` : ""}
    </div>
    <div class="hud-box hud-side"><div class="muted roster-title">Players</div>${seatsHtml(s, true)}</div>
    <div class="hud-tools">
      <button class="ghost small icon" data-act="mute" aria-label="Sound"></button>
      <button class="ghost small icon" data-act="music" aria-label="Music">♪</button>
      <button class="ghost small icon" data-act="fs" aria-label="Fullscreen"></button>
    </div>
    <div class="hud-msg"><div class="hud-box">
      ${msg}
      ${canEnd ? `<button id="end" class="small">End run</button>` : ""}
      ${!msg && !canEnd ? `<span class="keys"><kbd>WASD</kbd>/<kbd>arrows</kbd> move · bump to hit or open · <kbd>E</kbd> extract · <a href="#" data-guide>guide</a></span>` : ""}
    </div></div>`;
  if (!msg && !canEnd && isTouch) (hud.querySelector(".hud-msg") as HTMLElement).style.display = "none";
  $("end")?.addEventListener("click", () =>
    guarded("End", async () => {
      ($("end") as HTMLButtonElement).disabled = true;
      await chain.endRun(session!, runKey!, s.playerCount);
      await waitForBase();
    }),
  );
  document.getElementById("touch-extract")?.classList.toggle("locked", xIn > 0 || !active);
  renderToggles();
  // The phone layout sizes the dungeon around the HUD (portrait), so publish its height.
  document.documentElement.style.setProperty("--hud-h", `${hud.offsetHeight}px`);
}

// Tick the clock, exits countdown and attack meter in place: rebuilding the HUD would swallow clicks.
let hudZeroed = false;
let exitsWereLocked = true;
setInterval(() => {
  if (state?.status !== Status.Live || !onEr) return;
  const left = secondsLeft();
  const xIn = exitsIn();
  if ((left === 0 && !hudZeroed) || (xIn === 0 && exitsWereLocked)) {
    hudZeroed = left === 0;
    exitsWereLocked = xIn > 0;
    return renderHud();
  }
  exitsWereLocked = xIn > 0;
  const t = hud.querySelector(".timer");
  if (t) {
    t.textContent = clock(left);
    t.classList.toggle("low", left <= 15);
  }
  const x = hud.querySelector(".exits");
  if (x) x.textContent = xIn ? clock(xIn) : "OPEN";
  hud.querySelectorAll(".xin").forEach((e) => (e.textContent = clock(xIn)));
  if (left > 0 && left <= 10) sfx.tick();
  music.setHurry(left > 0 && left <= 30);
}, 1000);
setInterval(() => {
  const bar = hud.querySelector<HTMLElement>(".meter i");
  if (bar) {
    const r = attackReady();
    bar.style.width = `${r * 100}%`;
    bar.classList.toggle("ready", r >= 1);
  }
}, 50);

/** The session key got a small top-up at join for fees. Once the run is over, send what's left
 *  back to the player's wallet. Best effort: it's only ~0.004 SOL. */
async function returnSessionFunds() {
  if (!session || !wallet) return;
  try {
    const sig = await chain.sweepSession(session, wallet.publicKey);
    if (sig) toast("Returned your session key's leftover SOL to your wallet");
  } catch (e) {
    console.warn("session sweep failed", e);
  }
}

async function showEnded() {
  const s = state!;
  setMode("landing");
  bots.forEach((b) => b.brain?.stop());
  if (s.settled) {
    void returnSessionFunds();
    void returnBotFunds();
  }
  const me = mySeat();
  // After the run every bag is back on base and public: now everyone sees what everyone had.
  const bags = await Promise.all(s.players.slice(0, s.playerCount).map((_, i) => chain.fetchBag(runKey!, i)));
  const points = bags.map((b) => b?.points ?? 0);
  const extracted = s.players.slice(0, s.playerCount).map((p, i) => ({ p, i })).filter(({ p }) => p.extracted);
  const total = extracted.reduce((a, { i }) => a + points[i], 0);
  const pot = Number(s.pot.toString());
  // Mirrors Run::payouts: extracted players split by loot; if nobody got out, every stake goes back.
  const share = (i: number) => {
    if (!extracted.length) return Math.floor(pot / s.playerCount);
    if (!s.players[i].extracted) return 0;
    return total === 0 ? Math.floor(pot / extracted.length) : Math.floor((pot * points[i]) / total);
  };
  const best = [...extracted].sort((a, b) => share(b.i) - share(a.i) || points[b.i] - points[a.i])[0];
  const myShare = me >= 0 ? share(me) : 0;
  const iWon = me >= 0 && s.players[me].extracted;
  const iTopped = !!best && best.i === me;
  const practice = pot === 0;
  const title = !best
    ? { t: "GAME OVER", cls: "neon-red", sub: practice ? "Nobody made it out" : "Nobody made it out: every stake is refunded" }
    : iWon
      ? { t: iTopped ? (practice ? "STAGE CLEAR!" : "YOU WIN!") : "YOU ESCAPED!", cls: "neon-gold", sub: practice ? `Practice run · ${points[me]} pts banked` : "Extracted players split the pot by loot" }
      : me >= 0
        ? { t: "GAME OVER", cls: "neon-red", sub: s.players[me].alive ? "Trapped when the timer hit zero" : "You were slain in the dungeon" }
        : { t: "RUN OVER", cls: "neon-pink", sub: `${who(best.i, best.p.wallet)} took the top prize` };

  // High-score table: extracted players by payout, then everyone else by loot.
  const order = s.players
    .slice(0, s.playerCount)
    .map((p, i) => ({ p, i }))
    .sort((a, b) => Number(b.p.extracted) - Number(a.p.extracted) || share(b.i) - share(a.i) || points[b.i] - points[a.i]);
  const rows = order
    .map(({ p, i }, rank) => {
      const fate = p.extracted ? `<span class="tag out">ESCAPED</span>` : !p.alive ? `<span class="tag dead">SLAIN</span>` : `<span class="tag dead">TRAPPED</span>`;
      const r = p.extracted ? `<span class="rank r${rank + 1}">${["1ST", "2ND", "3RD", "4TH"][rank]}</span>` : `<span class="rank">--</span>`;
      const name = i === me ? "YOU" : who(i, p.wallet).replace("🤖 ", "");
      return `<tr class="${best && i === best.i ? "win" : ""} ${i === me ? "me" : ""}">
        <td>${r}</td>
        <td><span class="who"><img src="/sprites/hero${i}.png" alt="" />${name}</span></td>
        <td>${fate}</td>
        <td class="r">${points[i]}</td>
        <td class="r">${practice ? "-" : sol(share(i))}</td>
      </tr>`;
    })
    .join("");

  const bigNumber = practice ? (me >= 0 ? points[me] : best ? points[best.i] : 0) : me >= 0 ? myShare : best ? share(best.i) : 0;
  const bigUnit = practice ? "PTS" : "SOL";
  screen.className = `card ${best && (iWon || me < 0) ? "gold" : "red"}`;
  screen.innerHTML = `
    <div class="gameover">
      <div class="go-title ${title.cls}">${title.t}</div>
      <div class="go-sub">${title.sub}</div>
      ${best && (iWon || me < 0) ? `<div class="payout-big"><span id="countup">0</span><small>${bigUnit}</small></div>` : ""}
      <table class="scores">
        <thead><tr><th>RANK</th><th>PLAYER</th><th>FATE</th><th class="r">PTS</th><th class="r">${practice ? "" : "SOL"}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="muted">🔓 Every bag is public now that the run is over.</p>
      <div class="row" style="justify-content:center">
        ${
          s.settled
            ? `<span class="stamp">PAID ✓</span>`
            : `<button id="settle" class="big ${iWon && myShare > 0 ? "gold-btn blink-btn" : "cyan"}">${iWon && myShare > 0 ? "💰 Claim winnings" : "Settle payouts"}</button>`
        }
      </div>
      <div class="row" style="justify-content:center">
        <button id="again" class="big pink">▶ Play again</button>
      </div>
      <div class="continue blink">INSERT COIN TO CONTINUE</div>
    </div>`;

  // Count the big number up like an arcade score tally.
  const el = $("countup");
  if (el) {
    const target = bigNumber;
    const fmt = (v: number) => (practice ? String(Math.round(v)) : sol(Math.round(v)));
    const t0 = performance.now();
    const dur = 1400;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      el.textContent = fmt(target * (1 - Math.pow(1 - k, 3)));
      if (k < 1) {
        if (Math.random() < 0.35) sfx.tick();
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  }
  if (iWon) sfx.win();
  else if (me >= 0) sfx.lose();
  if (s.settled && iWon && myShare > 0) coinRain(40);

  $("settle")?.addEventListener("click", () =>
    guarded("Settle", async () => {
      const btn = $("settle") as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Paying out…";
      await chain.settleRun(wallet!, runKey!, s);
      sfx.coin();
      if (iWon && myShare > 0) coinRain(60);
      btn.outerHTML = `<span class="stamp">PAID ✓</span>`;
      toast(iWon && myShare > 0 ? `${sol(myShare)} SOL sent to your wallet` : "Paid out");
      await returnSessionFunds();
      await returnBotFunds();
    }),
  );
  $("again").addEventListener("click", newGame);
}

/** Back to the create screen for a fresh run. */
function newGame() {
  {
    history.replaceState(null, "", location.pathname + (params.get("net") ? `?net=${net}` : "") + (params.has("dev") ? `${params.get("net") ? "&" : "?"}dev=1` : ""));
    runKey = null;
    state = null;
    myBag = null;
    bots = [];
    revealedChests.clear();
    unsub?.();
    scene?.resetRun();
    showCreate();
  }
}

// ---------- input ----------

function step(x: number, y: number, dir: number): [number, number] {
  return [x + [0, 1, 0, -1][dir], y + [-1, 0, 1, 0][dir]];
}

/** One action in flight at a time, so they land in order. Taps while busy are buffered. */
const MAX_QUEUE = 8;
let actionsSent = 0;
function act(f: () => Promise<unknown>) {
  if (busy) {
    if (queue.length < MAX_QUEUE) queue.push(f);
    return;
  }
  busy = true;
  actionsSent++;
  f()
    .catch((e) => {
      queue.length = 0; // a rejected move invalidates the rest of the planned path
      toast(friendly(e), true);
    })
    .finally(() => {
      busy = false;
      const next = queue.shift();
      if (next) act(next);
    });
}

function onDir(dir: number) {
  if (mySeat() < 0 || !session) return;
  act(() => directed(dir));
}

// ---------- client-side prediction ----------
let predicted: { x: number; y: number; at: number } | null = null;
const PREDICT_MS = 1500;

function walkable(x: number, y: number) {
  return MAP.LAYOUT[y]?.[x] === "." && !MAP.CHESTS.some(([cx, cy]) => cx === x && cy === y);
}

function predict(x: number, y: number) {
  if (!walkable(x, y)) return;
  predicted = { x, y, at: performance.now() };
  pushToScene();
}

/** Chain state, with our own position overridden by a fresh prediction. */
function viewState(): RunState | null {
  const s = state;
  const me = mySeat();
  if (!s || me < 0 || !predicted) return s;
  const p = s.players[me];
  const agreed = p.x === predicted.x && p.y === predicted.y;
  if (agreed || !p.alive || performance.now() - predicted.at > PREDICT_MS) {
    predicted = null;
    return s;
  }
  const players = s.players.map((q, i) => (i === me ? { ...q, x: predicted!.x, y: predicted!.y } : q));
  return { ...s, players };
}

function pushToScene() {
  const v = viewState();
  if (scene && v) scene.setState(v, mySeat());
}
setInterval(() => predicted && pushToScene(), 250);

/** Walking into a chest opens it, into a player hits them, otherwise moves. Decided when the
 *  action runs, against the freshest state (including our predicted position). */
async function directed(dir: number) {
  const s = viewState();
  const me = mySeat();
  if (!s || me < 0) return;
  const p = s.players[me];
  if (!p.alive || p.extracted || secondsLeft() === 0) return;
  const [tx, ty] = step(p.x, p.y, dir);
  const chest = MAP.CHESTS.findIndex(([cx, cy]) => cx === tx && cy === ty);
  if (chest >= 0) {
    if (s.chests[chest].state === ChestState.Closed) await chain.openChest(session!, runKey!, me, chest);
    return;
  }
  const target = s.players.slice(0, s.playerCount).some((o) => o.alive && !o.extracted && o.x === tx && o.y === ty);
  if (target) {
    if (attackReady() < 1) return; // the program enforces the cooldown; skip doomed txs
    lastAttackAt = performance.now();
    sfx.swing();
    await chain.attack(session!, runKey!, s.playerCount, dir, false);
    return;
  }
  if (!walkable(tx, ty)) {
    sfx.bump();
    return;
  }
  predict(tx, ty);
  await chain.move(session!, runKey!, s.playerCount, dir, false);
}

/** E / EXIT: start channeling, then finish automatically after ~2s if still channeling. */
let finishing = false;
function onExtract() {
  if (!session || !runKey || !state) return;
  const me = mySeat();
  const p = me >= 0 ? state.players[me] : null;
  if (!p || !p.alive || p.extracted) return;
  if (!MAP.EXTRACTS.some(([x, y]) => x === p.x && y === p.y)) return toast("Stand on a green EXIT portal first");
  if (exitsIn() > 0) return toast(`Exits unlock in ${clock(exitsIn())}`);
  if (channeling() || finishing) return;
  act(async () => {
    await chain.startExtract(session!, runKey!);
    finishing = true;
    renderHud();
    setTimeout(() => void finish(0), EXTRACT_CHANNEL_MS);
  });
}

async function finish(attempt: number): Promise<void> {
  if (!channeling()) {
    finishing = false; // moved or got hit: the program already cancelled it
    renderHud();
    return;
  }
  try {
    await chain.finishExtract(session!, runKey!);
    finishing = false;
  } catch (e) {
    if (/6027|0x178b/.test((e as Error).message) && attempt < 8) {
      setTimeout(() => void finish(attempt + 1), 250); // slot jitter: a little longer
      return;
    }
    finishing = false;
    if (!/6026|0x178a/.test((e as Error).message)) toast(friendly(e), true);
  }
}

const KEY_DIRS: Record<string, number> = {
  ArrowUp: 0, KeyW: 0,
  ArrowRight: 1, KeyD: 1,
  ArrowDown: 2, KeyS: 2,
  ArrowLeft: 3, KeyA: 3,
};
let lastKeyAt = 0;
window.addEventListener("keydown", (e) => {
  if (state?.status !== Status.Live || !onEr) return;
  if ((e.target as HTMLElement)?.tagName === "INPUT" || document.querySelector("dialog[open]")) return;
  const dir = KEY_DIRS[e.code];
  if (dir === undefined && e.code !== "KeyE" && e.code !== "Space") return;
  e.preventDefault();
  const now = performance.now();
  if (e.repeat && now - lastKeyAt < 120) return;
  lastKeyAt = now;
  if (dir !== undefined) onDir(dir);
  else onExtract();
});

// Touch: D-pad with hold-to-repeat, and the EXIT button.
document.querySelectorAll<HTMLButtonElement>("#touch .dpad button").forEach((b) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    b.classList.remove("held");
  };
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    b.classList.add("held");
    const dir = Number(b.dataset.dir);
    onDir(dir);
    timer = setInterval(() => onDir(dir), 170);
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => b.addEventListener(ev, stop));
});
$("touch-extract").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  onExtract();
});

// ---------- go ----------

// Read-only debug handle for testing in the browser console.
(window as any).__ed = {
  get seats() {
    return state?.players.slice(0, state.playerCount).map((p) => ({ x: p.x, y: p.y, hp: p.hp, alive: p.alive, out: p.extracted, ch: p.extractStartSlot.toString() !== "0" }));
  },
  get myBag() {
    return myBag && { points: myBag.points, dropped: myBag.dropped, lastTier: myBag.lastTier };
  },
  get status() {
    return state?.status;
  },
  get sent() {
    return actionsSent;
  },
  get wallet() {
    return wallet?.publicKey.toBase58();
  },
  get dropped() {
    return state?.dropped.filter((b) => b.present);
  },
  exitsIn,
};

initGuide();
renderWallet();
showConnect();
