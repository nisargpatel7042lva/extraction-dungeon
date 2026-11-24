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
  WalletSigner,
  chainClock,
  exitsOpenAt,
} from "./chain";
import { DungeonScene, SEAT_COLORS, startGame } from "./game";
import { connectPhantom, devWallet, hasPhantom, sessionKey } from "./wallet";
import { initGuide } from "./guide";
import { isMuted, setMuted, sfx } from "./sound";

// ---------- setup ----------

const params = new URLSearchParams(location.search);
const isLocalHost = ["localhost", "127.0.0.1"].includes(location.hostname);
const net = (params.get("net") ?? (isLocalHost ? "local" : "devnet")) as Net;
const chain = new Chain(NETS[net]);
chain.onActionError = (m) => {
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

const sol = (lamports: { toString(): string } | number) => (Number(lamports.toString()) / LAMPORTS_PER_SOL).toFixed(3);
const short = (k: PublicKey) => k.toBase58().slice(0, 4) + "…" + k.toBase58().slice(-4);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const hexColor = (c: number) => "#" + c.toString(16).padStart(6, "0");
const clock = (secs: number) => `${Math.floor(secs / 60)}:${String(Math.max(0, secs) % 60).padStart(2, "0")}`;

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
  const h = (document.querySelector(".topbar") as HTMLElement).offsetHeight;
  document.documentElement.style.setProperty("--topbar-h", `${h}px`);
}
window.addEventListener("resize", () => {
  const h = (document.querySelector(".topbar") as HTMLElement).offsetHeight;
  document.documentElement.style.setProperty("--topbar-h", `${h}px`);
});

const muteBtn = $("mute");
const renderMute = () => (muteBtn.textContent = isMuted() ? "🔇" : "🔊");
muteBtn.addEventListener("click", () => {
  setMuted(!isMuted());
  renderMute();
});
renderMute();

// ---------- screens ----------

function renderWallet() {
  $("wallet").innerHTML = wallet
    ? `<span class="tag">${net}</span><span class="mono">${short(wallet.publicKey)}</span>`
    : `<span class="tag">${net}</span>`;
}

function showConnect() {
  setMode("landing");
  screen.innerHTML = `
    <h2>Enter the dungeon</h2>
    <p class="muted">Connect a wallet to open a run or join one from an invite link.</p>
    <div class="row">
      ${NETS[net].airdrop || params.has("dev") ? `<button id="dev">Play with a dev wallet</button>` : ""}
      <button id="ph" class="${NETS[net].airdrop ? "ghost" : ""}" ${hasPhantom() ? "" : "disabled"}>Connect Phantom</button>
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
  screen.innerHTML = `
    <h2>Open a run</h2>
    <label>Entry stake (SOL)</label><input id="entry" type="number" min="0" step="0.01" value="0.05" inputmode="decimal" />
    <label>Run length</label>
    <div class="row" style="margin-top:0">
      <button class="ghost small dur" data-d="120">2 min</button>
      <button class="ghost small dur" data-d="180">3 min</button>
      <button class="ghost small dur" data-d="300">5 min</button>
    </div>
    <input id="dur" type="hidden" value="180" />
    <div class="row"><button id="create">Create run</button></div>
    <p class="muted">You'll get a link to share with up to 3 friends. Join your own run to play in it.</p>`;
  const durs = [...screen.querySelectorAll<HTMLButtonElement>(".dur")];
  const pick = (b: HTMLButtonElement) => {
    durs.forEach((x) => (x.style.borderColor = x === b ? "var(--gold)" : ""));
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
  screen.innerHTML = `<h2>Opening the dungeon…</h2><p class="muted">Handing the run to the Private Ephemeral Rollup.</p>`;
  try {
    if (mySeat() >= 0 && session) await chain.ensureRunPermission(session, runKey!).catch(() => {});
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
  screen.innerHTML = `<h2>Run over</h2><p class="muted">Committing the run and every bag back to Solana…</p>`;
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
        return `<div class="seat"><span class="dot" style="background:${col}"></span><span class="mono">${i === me ? "you" : short(p.wallet)}</span>${tag}<span style="margin-left:auto">${stat}</span></div>`;
      })
      .join("") || `<p class="muted">Nobody yet.</p>`
  );
}

function showLobby() {
  const s = state!;
  setMode("landing");
  const me = mySeat();
  const isHost = wallet!.publicKey.equals(s.authority);
  screen.innerHTML = `
    <h2>Lobby</h2>
    <div class="pot">
      <div><small class="muted">Pot</small><b>${sol(s.pot)}</b></div>
      <div><small class="muted">Entry</small><b>${sol(s.entryLamports)}</b></div>
      <div><small class="muted">Run</small><b>${clock(s.durationSecs)}</b></div>
    </div>
    ${seatsHtml(s)}
    <div class="row">
      ${me < 0 && s.playerCount < 4 ? `<button id="join">Join (${sol(s.entryLamports)} SOL)</button>` : ""}
      ${isHost ? `<button id="start" ${s.playerCount ? "" : "disabled"}>Start run</button>` : ""}
      <button id="copy" class="ghost">Copy invite link</button>
    </div>
    ${me >= 0 ? `<p class="muted">🔒 Your bag is private: only this browser tab can see what you carry.</p>` : ""}
    ${isHost ? "" : `<p class="muted">Waiting for the host to start.</p>`}`;
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
  if (s.settled) void returnSessionFunds();
  const me = mySeat();
  // After the run every bag is back on base and public: now everyone sees what everyone had.
  const bags = await Promise.all(s.players.slice(0, s.playerCount).map((_, i) => chain.fetchBag(runKey!, i)));
  const points = bags.map((b) => b?.points ?? 0);
  const extracted = s.players.slice(0, s.playerCount).map((p, i) => ({ p, i })).filter(({ p }) => p.extracted);
  const total = extracted.reduce((a, { i }) => a + points[i], 0);
  const pot = Number(s.pot.toString());
  const share = (i: number) => {
    if (!s.players[i].extracted) return 0;
    return total === 0 ? Math.floor(pot / extracted.length) : Math.floor((pot * points[i]) / total);
  };
  const best = extracted.sort((a, b) => share(b.i) - share(a.i))[0];
  screen.innerHTML = `
    <h2>Run over</h2>
    ${best ? `<p class="winner">${best.i === me ? "You win" : `${short(best.p.wallet)} wins`} ${sol(share(best.i))} SOL</p>` : `<p class="winner" style="color:var(--red)">Nobody got out</p>`}
    ${s.players
      .slice(0, s.playerCount)
      .map((p, i) => {
        const fate = p.extracted
          ? `<span class="tag out">extracted · ${points[i]} pts</span>`
          : !p.alive
            ? `<span class="tag dead">slain</span>`
            : `<span class="tag dead">trapped · lost ${points[i]} pts</span>`;
        return `<div class="seat"><span class="dot" style="background:${hexColor(SEAT_COLORS[i])}"></span><span class="mono">${i === me ? "you" : short(p.wallet)}</span>${fate}<b style="margin-left:auto">${sol(share(i))} SOL</b></div>`;
      })
      .join("")}
    <p class="muted">${extracted.length ? "Extracted players split the pot by loot points. Bags are revealed now that the run is over." : "The pot goes to the house."}</p>
    <div class="row">
      ${s.settled ? `<span class="tag out">Paid out</span>` : `<button id="settle">Settle payouts</button>`}
      <button id="again" class="ghost">New run</button>
    </div>`;
  $("settle")?.addEventListener("click", () =>
    guarded("Settle", async () => {
      ($("settle") as HTMLButtonElement).disabled = true;
      await chain.settleRun(wallet!, runKey!, s);
      toast("Paid out");
      await returnSessionFunds();
    }),
  );
  $("again").addEventListener("click", () => {
    history.replaceState(null, "", location.pathname + (params.get("net") ? `?net=${net}` : "") + (params.has("dev") ? `${params.get("net") ? "&" : "?"}dev=1` : ""));
    runKey = null;
    state = null;
    myBag = null;
    revealedChests.clear();
    unsub?.();
    showCreate();
  });
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
