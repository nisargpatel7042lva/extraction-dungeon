import "./polyfill";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  ATTACK_COOLDOWN_MS,
  BagState,
  Chain,
  ChestState,
  MAP,
  NETS,
  Net,
  RunState,
  Status,
  TIER_NAMES,
  WalletSigner,
} from "./chain";
import { DungeonScene, SEAT_COLORS, startGame } from "./game";
import { connectPhantom, devWallet, hasPhantom, sessionKey } from "./wallet";
import { initGuide } from "./guide";

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
const hud = $("hud");
const gameEl = $("game");

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

function toast(msg: string, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = err ? "err" : "";
  t.hidden = false;
  clearTimeout((toast as any).h);
  (toast as any).h = setTimeout(() => (t.hidden = true), err ? 6000 : 2500);
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

// ---------- screens ----------

function renderWallet() {
  $("wallet").innerHTML = wallet
    ? `<span class="tag">${net}</span> <span class="mono">${short(wallet.publicKey)}</span>`
    : `<span class="tag">${net}</span>`;
}

function showConnect() {
  hud.hidden = true;
  screen.innerHTML = `
    <h2>Enter the dungeon</h2>
    <p class="muted">Stake SOL, loot chests, fight other players, and get out alive. Whatever you extract with is yours.
    Every move runs on a MagicBlock Private Ephemeral Rollup: VRF decides what's in each chest, and nobody can see what you're carrying.</p>
    <div class="row">
      ${NETS[net].airdrop || params.has("dev") ? `<button id="dev">Play with a dev wallet</button>` : ""}
      <button id="ph" class="${NETS[net].airdrop ? "ghost" : ""}" ${hasPhantom() ? "" : "disabled"}>Connect Phantom</button>
      <button class="ghost" data-guide>How to play</button>
    </div>
    ${hasPhantom() ? "" : `<p class="muted">Phantom not detected. <a href="https://phantom.com/download" target="_blank" rel="noopener">Get Phantom</a>.</p>`}
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
  screen.innerHTML = `
    <h2>Open a run</h2>
    <label>Entry stake (SOL)</label><input id="entry" type="number" min="0" step="0.01" value="0.05" />
    <label>Run length (seconds)</label><input id="dur" type="number" min="30" step="10" value="90" />
    <div class="row"><button id="create">Create run</button><button class="ghost" data-guide>How to play</button></div>
    <p class="muted">You'll get a link to share. Up to 4 players. Join your own run to play in it.</p>`;
  $("create").addEventListener("click", () =>
    guarded("Create", async () => {
      const entry = Math.round(Number(($("entry") as HTMLInputElement).value) * LAMPORTS_PER_SOL);
      const dur = Number(($("dur") as HTMLInputElement).value);
      ($("create") as HTMLButtonElement).disabled = true;
      const { run } = await chain.createRun(wallet!, entry, dur);
      const url = new URL(location.href);
      url.searchParams.set("run", run.toBase58());
      history.replaceState(null, "", url);
      runKey = run;
      await openRun(run);
    }),
  );
}

async function openRun(run: PublicKey) {
  session = sessionKey(run);
  const got = await chain.fetchRun(run);
  if (!got) {
    screen.innerHTML = `<h2>Run not found</h2><p class="muted mono">${run.toBase58()}</p><p class="muted">If the host just started it, give it a few seconds and reload.</p>`;
    return;
  }
  apply(got.state, got.onEr);
  watch();
  // Re-entering a run you're seated in (e.g. after a reload): make sure your bag is private.
  const me = mySeat();
  if (me >= 0 && got.state.status !== Status.Ended) void protectBag(me);
}

/** Subscribe to wherever the run lives now. Re-run when it moves (delegation / commit). */
function watch() {
  unsub?.();
  unsub = chain.subscribe(onEr ? "er" : "base", runKey!, (s) => apply(s, onEr), () => void waitForEr());
}

function apply(s: RunState, isEr: boolean) {
  state = s;
  onEr = isEr;
  if (s.status === Status.Lobby) return showLobby();
  if (s.status === Status.Live) {
    if (!isEr) return void waitForEr();
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
  screen.innerHTML = `<h2>Opening the dungeon…</h2><p class="muted">Handing the run to the Private Ephemeral Rollup.</p>`;
  try {
    // The run's public permission lets every client read it on the TEE. Any seated player can set it.
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
  hud.hidden = true;
  gameEl.hidden = true;
  screen.innerHTML = `<h2>Run over</h2><p class="muted">Committing the run and every bag back to Solana…</p>`;
  try {
    const s = await chain.waitForBase(runKey!, Status.Ended, 90_000, state?.playerCount ?? 0);
    apply(s, false);
    watch();
  } catch (e) {
    screen.innerHTML += `<p class="muted">${esc(friendly(e))}</p>`;
  }
}

function seatsHtml(s: RunState) {
  const me = mySeat();
  return (
    s.players
      .slice(0, s.playerCount)
      .map((p, i) => {
        const col = hexColor(SEAT_COLORS[i]);
        const tag = p.extracted ? `<span class="tag out">extracted</span>` : !p.alive ? `<span class="tag dead">slain</span>` : "";
        const bag = i === me ? `${myBag?.points ?? 0}` : "?";
        const stat = s.status === Status.Lobby ? "" : `<span class="muted">bag ${bag} · ♥${p.hp} · ⚔${p.kills}</span>`;
        return `<div class="seat"><span class="dot" style="background:${col}"></span><span class="mono">${short(p.wallet)}</span>${i === me ? `<span class="tag">you</span>` : ""}${tag}<span style="margin-left:auto">${stat}</span></div>`;
      })
      .join("") || `<p class="muted">Nobody yet.</p>`
  );
}

function showLobby() {
  const s = state!;
  hud.hidden = true;
  gameEl.hidden = true;
  const me = mySeat();
  const isHost = wallet!.publicKey.equals(s.authority);
  screen.innerHTML = `
    <h2>Lobby</h2>
    <p class="muted">Entry <b>${sol(s.entryLamports)} SOL</b> · pot <b>${sol(s.pot)} SOL</b> · ${s.durationSecs}s run</p>
    ${seatsHtml(s)}
    <div class="row">
      ${me < 0 && s.playerCount < 4 ? `<button id="join">Join (${sol(s.entryLamports)} SOL)</button>` : ""}
      ${isHost ? `<button id="start" ${s.playerCount ? "" : "disabled"}>Start run</button>` : ""}
      <button id="copy" class="ghost">Copy invite link</button>
      <button class="ghost" data-guide>How to play</button>
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
  $("copy").addEventListener("click", () => navigator.clipboard.writeText(location.href).then(() => toast("Invite link copied")));
}

function showLive() {
  screen.innerHTML = "";
  gameEl.hidden = false;
  hud.hidden = false;
  if (!scene) scene = startGame(gameEl);
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
    if (prev && b.points > prev.points) scene?.popAtSeat(me, `+${b.points - prev.points}`, "#f5c04a");
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
      scene?.revealChest(i, myBag!.lastTier, TIER_NAMES[myBag!.lastTier] ?? "?");
    }
  });
}

function secondsLeft(): number {
  return state ? Math.max(0, Number(state.endsAt.toString()) - Math.floor(Date.now() / 1000)) : 0;
}

function attackReady(): number {
  return Math.min(1, (performance.now() - lastAttackAt) / ATTACK_COOLDOWN_MS);
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
  const onExit = p && MAP.EXTRACTS.some(([x, y]) => x === p.x && y === p.y) && p.alive && !p.extracted;
  hud.innerHTML = `
    <div class="muted">Time</div>
    <div class="big timer ${left <= 15 ? "low" : ""}">${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}</div>
    <div class="row" style="margin-top:8px">
      <div><div class="muted">Pot</div><b>${sol(s.pot)} SOL</b></div>
      ${p ? `<div><div class="muted">Your bag 🔒</div><b>${pts} pts</b></div>` : ""}
    </div>
    ${p && p.alive && !p.extracted ? `<div class="cooldown"><span class="muted">Attack</span><div class="bar"><i style="width:${attackReady() * 100}%"></i></div></div>` : ""}
    <div style="margin-top:14px">${seatsHtml(s)}</div>
    ${onExit ? `<p style="color:var(--green)">On the exit: press <kbd>E</kbd> to extract with ${pts} pts.</p>` : ""}
    ${p && !p.alive ? `<p style="color:var(--red)">You were slain. Your bag is on the floor as a sack.</p>` : ""}
    ${p?.extracted ? `<p style="color:var(--green)">You got out with ${pts} pts.</p>` : ""}
    ${canEnd ? `<div class="row"><button id="end">End run</button></div>` : ""}
    <div class="keys"><kbd>WASD</kbd>/<kbd>arrows</kbd> move · walk into a player to hit · walk into a chest to open · <kbd>E</kbd> extract · <a href="#" data-guide>guide</a></div>`;
  $("end")?.addEventListener("click", () =>
    guarded("End", async () => {
      ($("end") as HTMLButtonElement).disabled = true;
      await chain.endRun(session!, runKey!, s.playerCount);
      await waitForBase();
    }),
  );
}

// Tick the clock and the attack meter in place: rebuilding the HUD every second would swallow clicks.
let hudTimeWasZero = false;
setInterval(() => {
  if (state?.status !== Status.Live || !onEr) return;
  const left = secondsLeft();
  if (left === 0 && !hudTimeWasZero) {
    hudTimeWasZero = true;
    return renderHud(); // "End run" becomes available to everyone
  }
  const el = hud.querySelector(".timer");
  if (el) {
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    el.classList.toggle("low", left <= 15);
  }
}, 1000);
setInterval(() => {
  const bar = hud.querySelector<HTMLElement>(".cooldown i");
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
  gameEl.hidden = true;
  hud.hidden = true;
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
  screen.innerHTML = `
    <h2>Run over</h2>
    ${s.players
      .slice(0, s.playerCount)
      .map((p, i) => {
        const fate = p.extracted
          ? `<span class="tag out">extracted · ${points[i]} pts</span>`
          : !p.alive
            ? `<span class="tag dead">slain</span>`
            : `<span class="tag dead">trapped · lost ${points[i]} pts</span>`;
        return `<div class="seat"><span class="dot" style="background:${hexColor(SEAT_COLORS[i])}"></span><span class="mono">${short(p.wallet)}</span>${i === me ? `<span class="tag">you</span>` : ""}${fate}<b style="margin-left:auto">${sol(share(i))} SOL</b></div>`;
      })
      .join("")}
    <p class="muted">${extracted.length ? "Extracted players split the pot by loot points. Bags are revealed now that the run is over." : "Nobody got out: the pot goes to the house."}</p>
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
    history.replaceState(null, "", location.pathname + (params.get("net") ? `?net=${net}` : ""));
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

/** One action in flight at a time, so they land in order. Taps while busy are buffered instead of
 *  dropped. Key-repeat is already throttled to one step per 120ms, so 8 only overflows if
 *  the ER stalls; dropping input there is better than a long tail of stale moves. */
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
// Moves take ~150ms to land on the TEE. We draw our own move immediately when the target tile is
// walkable, and trust chain state again once it agrees or after 1.5s (rubber-band).
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

/** The state the scene should draw: chain state, with our own position overridden by a fresh prediction. */
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
setInterval(() => predicted && pushToScene(), 250); // lets an expired prediction snap back

/** Walking into a chest opens it, into a player hits them, otherwise moves. Decided when the
 *  action actually runs (not when the key was pressed), against the freshest state, including
 *  our own predicted position. */
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
    // The program enforces the cooldown; skipping early saves a doomed transaction.
    if (attackReady() < 1) return;
    lastAttackAt = performance.now();
    await chain.attack(session!, runKey!, s.playerCount, dir, false);
    return;
  }
  predict(tx, ty);
  // Fire-and-forget: the queue moves on once the ER has the tx; the websocket state is the truth
  // and a later failure (e.g. someone stepped into that tile first) shows up as a toast.
  await chain.move(session!, runKey!, s.playerCount, dir, false);
}

function onExtract() {
  if (session && runKey) act(() => chain.extract(session!, runKey!));
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
  if (dir === undefined && e.code !== "KeyE") return;
  e.preventDefault();
  // Holding a key repeats ~30/s; one step per 120ms is plenty and keeps the queue honest.
  const now = performance.now();
  if (e.repeat && now - lastKeyAt < 120) return;
  lastKeyAt = now;
  if (dir !== undefined) onDir(dir);
  else onExtract();
});

// ---------- go ----------

// Read-only debug handle for testing in the browser console.
(window as any).__ed = {
  get seats() {
    return state?.players.slice(0, state.playerCount).map((p) => ({ x: p.x, y: p.y, hp: p.hp, alive: p.alive, out: p.extracted }));
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
};

initGuide();
renderWallet();
showConnect();
