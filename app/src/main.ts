import "./polyfill";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { Chain, ChestState, MAP, NETS, Net, RunState, Status, WalletSigner } from "./chain";
import { DungeonScene, SEAT_COLORS, startGame } from "./game";
import { connectPhantom, devWallet, hasPhantom, sessionKey } from "./wallet";

// ---------- setup ----------

const params = new URLSearchParams(location.search);
const isLocalHost = ["localhost", "127.0.0.1"].includes(location.hostname);
const net = (params.get("net") ?? (isLocalHost ? "local" : "devnet")) as Net;
const chain = new Chain(NETS[net]);
chain.onActionError = (m) => toast(friendly(new Error(m)), true);

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

const sol = (lamports: { toString(): string } | number) => (Number(lamports.toString()) / LAMPORTS_PER_SOL).toFixed(3);
const short = (k: PublicKey) => k.toBase58().slice(0, 4) + "…" + k.toBase58().slice(-4);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

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
    Every move runs on a MagicBlock Ephemeral Rollup, and VRF decides what's in each chest.</p>
    <div class="row">
      ${NETS[net].airdrop ? `<button id="dev">Play with a dev wallet</button>` : ""}
      <button id="ph" class="${NETS[net].airdrop ? "ghost" : ""}" ${hasPhantom() ? "" : "disabled"}>Connect Phantom</button>
    </div>
    ${hasPhantom() ? "" : `<p class="muted">Phantom not detected. <a href="https://phantom.com/download" target="_blank" rel="noopener">Get Phantom</a>.</p>`}
    ${net === "devnet" ? `<p class="muted">Runs on Solana <b>devnet</b>: switch Phantom to devnet (Settings → Developer settings → Testnet mode) and grab free devnet SOL at <a href="https://faucet.solana.com" target="_blank" rel="noopener">faucet.solana.com</a>. A run costs about 0.01 SOL plus your stake.</p>` : ""}`;
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
    <div class="row"><button id="create">Create run</button></div>
    <p class="muted">You'll get a link to share. Up to 4 players.</p>`;
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
    screen.innerHTML = `<h2>Run not found</h2><p class="muted mono">${run.toBase58()}</p>`;
    return;
  }
  apply(got.state, got.onEr);
  watch();
}

/** Subscribe to wherever the run lives now. Re-run when it moves (delegation / commit). */
function watch() {
  unsub?.();
  unsub = chain.subscribe(
    onEr ? "er" : "base",
    runKey!,
    (s) => apply(s, onEr),
    () => void waitForEr(),
  );
}

function apply(s: RunState, isEr: boolean) {
  const prevStatus = state?.status;
  state = s;
  onEr = isEr;
  if (s.status === Status.Lobby) return showLobby();
  if (s.status === Status.Live) {
    if (!isEr) return void waitForEr();
    return showLive();
  }
  if (s.status === Status.Ended) {
    if (isEr) return void waitForBase();
    if (prevStatus !== Status.Ended || !screen.innerHTML) return showEnded();
    return showEnded();
  }
}

let waitingForEr = false;
async function waitForEr() {
  if (waitingForEr || onEr) return;
  waitingForEr = true;
  unsub?.();
  screen.innerHTML = `<h2>Opening the dungeon…</h2><p class="muted">Handing the run to the Ephemeral Rollup.</p>`;
  try {
    const s = await chain.waitForEr(runKey!);
    apply(s, true);
    watch();
  } finally {
    waitingForEr = false;
  }
}

async function waitForBase() {
  unsub?.();
  hud.hidden = true;
  screen.innerHTML = `<h2>Run over</h2><p class="muted">Committing the final state back to Solana…</p>`;
  try {
    const s = await chain.waitForBase(runKey!, Status.Ended, 60_000);
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
        const col = "#" + SEAT_COLORS[i].toString(16).padStart(6, "0");
        const tag = p.extracted ? `<span class="tag out">extracted</span>` : !p.alive ? `<span class="tag dead">slain</span>` : "";
        const stat = s.status === Status.Lobby ? "" : `<span class="muted">bag ${p.bag} · ♥${p.hp} · ⚔${p.kills}</span>`;
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
    </div>
    ${isHost ? "" : `<p class="muted">Waiting for the host to start.</p>`}`;
  $("join")?.addEventListener("click", () =>
    guarded("Join", async () => {
      ($("join") as HTMLButtonElement).disabled = true;
      await chain.joinRun(wallet!, runKey!, session!.publicKey);
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
  pushToScene();
  renderHud();
}

function secondsLeft(): number {
  return state ? Math.max(0, Number(state.endsAt.toString()) - Math.floor(Date.now() / 1000)) : 0;
}

function renderHud() {
  const s = state!;
  const me = mySeat();
  const p = me >= 0 ? s.players[me] : null;
  const left = secondsLeft();
  const resolved = s.players.slice(0, s.playerCount).every((x) => !x.alive || x.extracted);
  const canEnd = wallet!.publicKey.equals(s.authority) || left === 0 || resolved;
  const onExit = p && MAP.EXTRACTS.some(([x, y]) => x === p.x && y === p.y) && p.alive && !p.extracted;
  hud.innerHTML = `
    <div class="muted">Time</div>
    <div class="big timer ${left <= 15 ? "low" : ""}">${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}</div>
    <div class="row" style="margin-top:8px">
      <div><div class="muted">Pot</div><b>${sol(s.pot)} SOL</b></div>
      ${p ? `<div><div class="muted">Your bag</div><b>${p.bag} pts</b></div>` : ""}
    </div>
    <div style="margin-top:14px">${seatsHtml(s)}</div>
    ${onExit ? `<p style="color:var(--green)">On the exit: press <kbd>E</kbd> to extract with ${p!.bag} pts.</p>` : ""}
    ${p && !p.alive ? `<p style="color:var(--red)">You were slain. Your bag is on the floor.</p>` : ""}
    ${p?.extracted ? `<p style="color:var(--green)">You got out with ${p.bag} pts.</p>` : ""}
    ${canEnd ? `<div class="row"><button id="end">End run</button></div>` : ""}
    <div class="keys"><kbd>WASD</kbd>/<kbd>arrows</kbd> move · walk into a player to hit · walk into a chest to open · <kbd>E</kbd> extract</div>`;
  $("end")?.addEventListener("click", () =>
    guarded("End", async () => {
      ($("end") as HTMLButtonElement).disabled = true;
      await chain.endRun(session!, runKey!);
      await waitForBase();
    }),
  );
}
// Tick only the clock text: rebuilding the HUD every second would swallow clicks on its buttons.
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

function showEnded() {
  if (state?.settled) void returnSessionFunds();
  const s = state!;
  gameEl.hidden = true;
  hud.hidden = true;
  const me = mySeat();
  const extracted = s.players.slice(0, s.playerCount).filter((p) => p.extracted);
  const total = extracted.reduce((a, p) => a + p.bag, 0);
  const pot = Number(s.pot.toString());
  const share = (i: number) => {
    const p = s.players[i];
    if (!p.extracted) return 0;
    return total === 0 ? Math.floor(pot / extracted.length) : Math.floor((pot * p.bag) / total);
  };
  screen.innerHTML = `
    <h2>Run over</h2>
    ${s.players
      .slice(0, s.playerCount)
      .map((p, i) => {
        const col = "#" + SEAT_COLORS[i].toString(16).padStart(6, "0");
        const fate = p.extracted ? `<span class="tag out">extracted · ${p.bag} pts</span>` : !p.alive ? `<span class="tag dead">slain</span>` : `<span class="tag dead">trapped</span>`;
        return `<div class="seat"><span class="dot" style="background:${col}"></span><span class="mono">${short(p.wallet)}</span>${i === me ? `<span class="tag">you</span>` : ""}${fate}<b style="margin-left:auto">${sol(share(i))} SOL</b></div>`;
      })
      .join("")}
    <p class="muted">${extracted.length ? "Extracted players split the pot by loot points." : "Nobody got out: the pot goes to the house."}</p>
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
// Moves take ~170ms to land on the devnet ER. We draw our own move immediately when the target
// tile is walkable, and trust chain state again once it agrees or after 1.5s (rubber-band).
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
    if (s.chests[chest].state === ChestState.Closed) await chain.openChest(session!, runKey!, chest);
    return;
  }
  const target = s.players.slice(0, s.playerCount).some((o) => o.alive && !o.extracted && o.x === tx && o.y === ty);
  if (!target) predict(tx, ty);
  // Fire-and-forget: the queue moves on once the ER has the tx; the websocket state is the truth
  // and a later failure (e.g. someone stepped into that tile first) shows up as a toast.
  await (target ? chain.attack(session!, runKey!, dir, false) : chain.move(session!, runKey!, dir, false));
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
  if ((e.target as HTMLElement)?.tagName === "INPUT") return;
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
    return state?.players.slice(0, state.playerCount).map((p) => ({ x: p.x, y: p.y, hp: p.hp, alive: p.alive, out: p.extracted, bag: p.bag }));
  },
  get status() {
    return state?.status;
  },
  get sent() {
    return actionsSent;
  },
  get dropped() {
    return state?.dropped.filter((b) => b.present);
  },
};

renderWallet();
showConnect();
