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
  TIER_MIMIC,
  LOBBY_TIMEOUT_SECS,
  OutdatedRunError,
  WalletSigner,
  chainClock,
  exitsOpenAt,
  useLayout,
} from "./chain";
import { DungeonScene, SEAT_COLORS, startGame } from "./game";
import { connectPhantom, devWallet, hasDevWallet, hasPhantom, isMobileBrowser, reconnectPhantom, sessionKey, waitForPhantom, walletBrowseLinks } from "./wallet";
import { Bot, BotLevel, LEVELS } from "./bot";
import bs58 from "bs58";
import { initGuide } from "./guide";
import { initAnalytics, track } from "./analytics";
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

// ---------- device: the player says how they're playing, and the layout follows ----------
// Guessing from the browser gets it wrong too often (desktop-mode phone browsers, touch laptops,
// small windows), so the first visit asks, and the 🎮 button changes it any time.
type Device = "pc" | "phone" | "tablet";
const DEVICES: Record<Device, { icon: string; label: string; blurb: string }> = {
  pc: { icon: "🖥", label: "PC / Laptop", blurb: "Keyboard: WASD or arrows, E to extract" },
  phone: { icon: "📱", label: "Phone", blurb: "Touch D-pad and an EXIT button, compact screen" },
  tablet: { icon: "📲", label: "Tablet", blurb: "Touch controls with a roomier layout" },
};
const guessDevice = (): Device => {
  const coarse = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  if (!coarse) return "pc";
  return Math.min(window.screen.width, window.screen.height) >= 600 ? "tablet" : "phone";
};
const savedDevice = (() => {
  try {
    const d = localStorage.getItem("ed:device");
    return d && d in DEVICES ? (d as Device) : null;
  } catch {
    return null;
  }
})();
let device: Device = savedDevice ?? guessDevice();
let isTouch = device !== "pc";
function applyDevice(d: Device) {
  device = d;
  track("device_selected", { device: d });
  isTouch = d !== "pc";
  try {
    localStorage.setItem("ed:device", d);
  } catch {
    /* ignore */
  }
  document.body.classList.toggle("touch", isTouch);
  for (const k of Object.keys(DEVICES)) document.body.classList.toggle(`device-${k}`, k === d);
  window.dispatchEvent(new Event("resize")); // re-fit the dungeon for the new layout
  if (state?.status === Status.Live) renderHud();
}
document.body.classList.toggle("touch", isTouch);
document.body.classList.add(`device-${device}`);

/** "How are you playing?" Resolves once the player picks. */
function askDevice(): Promise<void> {
  return new Promise((resolve) => {
    let dlg = document.getElementById("device-pick") as HTMLDialogElement | null;
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.id = "device-pick";
      document.body.appendChild(dlg);
    }
    const guess = guessDevice();
    dlg.innerHTML = `
      <h2>How are you playing?</h2>
      <p class="muted">We'll fit the screen and controls to your device. Change it any time with the 🎮 button.</p>
      <div class="device-opts">
        ${(Object.keys(DEVICES) as Device[])
          .map((k) => `<button class="device-opt ${k === device ? "on" : ""}" data-device="${k}"><span class="ico">${DEVICES[k].icon}</span><b>${DEVICES[k].label}</b><small>${DEVICES[k].blurb}${k === guess ? " · looks like this one" : ""}</small></button>`)
          .join("")}
      </div>`;
    dlg.querySelectorAll<HTMLButtonElement>("[data-device]").forEach((b) =>
      b.addEventListener("click", () => {
        const d = b.dataset.device as Device;
        applyDevice(d);
        if (d === "pc") {
          dlg!.close();
          return resolve();
        }
        // Phones and tablets: the whole dungeon fits sideways.
        dlg!.innerHTML = `
          <div class="rotate-tip"><span class="rotate-ico">📱</span></div>
          <h2>Turn it sideways</h2>
          <p>For a better gaming experience, turn your ${d === "phone" ? "phone" : "tablet"} to <b class="neon-cyan">landscape mode</b>: the whole dungeon fits on screen, with the D-pad and EXIT button on the sides.</p>
          <div class="row" style="justify-content:center"><button id="rotate-ok" class="big pink">Got it</button></div>`;
        dlg!.querySelector("#rotate-ok")!.addEventListener("click", () => {
          dlg!.close();
          resolve();
        });
      }),
    );
    dlg.addEventListener("cancel", () => resolve(), { once: true }); // Esc keeps the current choice
    dlg.showModal();
  });
}

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
  await needSol(Number(state!.entryLamports.toString()) + 22_000_000, "adding a CPU (its stake + fees)");
  const wallet0 = Keypair.generate();
  const session0 = Keypair.generate();
  const seat = await chain.joinBot(wallet!, runKey!, wallet0, session0.publicKey);
  bots.push({ seat, level, wallet: wallet0, session: session0 });
  track("cpu_added", { level });
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
  (toast as any).h = setTimeout(() => (t.hidden = true), err ? Math.max(5000, msg.length * 45) : 2500);
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
  // Rejected before the program ran (no logs), or a plain lamports shortfall: almost always an
  // empty wallet on this network.
  if (/insufficient lamports|debit an account|insufficient funds/i.test(m) || (/Simulation failed/i.test(m) && /Logs:\s*\[\]/.test(m)))
    return `Your wallet doesn't have enough ${net} SOL for this. ${FAUCET_HINT}`;
  if (m.includes(FAUCET_HINT)) return m; // our own funding message: show all of it
  return m.length > 160 ? m.slice(0, 160) + "…" : m;
}

const FAUCET_HINT = "Get free devnet SOL at faucet.solana.com (in Phantom: Settings → Developer Settings → Testnet Mode, then Solana Devnet).";

/** Fails early, with a clear message, when the wallet can't cover what it's about to pay. */
async function needSol(lamports: number, what: string) {
  if (!wallet) return;
  const bal = await chain.base.getBalance(wallet.publicKey).catch(() => null);
  if (bal === null || bal >= lamports) return;
  throw new Error(`Your wallet has ${sol(bal)} ${net} SOL; ${what} needs about ${sol(lamports)}. ${FAUCET_HINT}`);
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
  if (!state) return -1;
  const seated = state.players.slice(0, state.playerCount);
  if (wallet) {
    const i = seated.findIndex((p) => p.wallet.equals(wallet!.publicKey));
    if (i >= 0) return i;
  }
  // After a reload the wallet may not be reconnected yet, but this tab still holds the run's session
  // key, and that key (not the wallet) signs every in-run action.
  if (session) return seated.findIndex((p) => p.signer.equals(session!.publicKey));
  return -1;
}

/** The wallet, connecting it first if needed (only joining, starting and claiming need one). */
async function ensureWallet(): Promise<WalletSigner> {
  if (wallet) return wallet;
  wallet = NETS[net].airdrop || params.has("dev") ? await devWallet(chain) : await connectPhantom();
  renderWallet();
  return wallet;
}

/** A reload with a run in the link: reopen it straight away instead of the connect screen, so a
 *  refresh never strands you outside a live run (where the timer would burn your stake). */
async function resumeRun(run: PublicKey) {
  wallet = (NETS[net].airdrop || params.has("dev")) && hasDevWallet(chain) ? await devWallet(chain) : await reconnectPhantom();
  renderWallet();
  try {
    await openRun(run);
  } catch (e) {
    console.error("resume", e);
    showConnect();
    return;
  }
  if (!wallet && state?.status === Status.Live && mySeat() >= 0) toast("You're back in your run. Your wallet is only needed to claim.");
}

// ---------- layout modes ----------

function setMode(mode: "landing" | "live") {
  document.body.classList.toggle("mode-live", mode === "live");
  document.body.classList.toggle("mode-landing", mode === "landing");
  stage.hidden = mode !== "live";
  if (mode === "live") music.start();
  else music.stop();
  // The attract-mode gameplay loop only runs behind the landing screens.
  const bg = document.getElementById("bg-video") as HTMLVideoElement | null;
  if (bg) {
    if (mode === "live") bg.pause();
    else bg.play().catch(() => {});
  }
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
      // requestFullscreen uses up the tap's user activation, and phones need that activation to
      // open another app (the Open-in-Phantom universal link) or show a wallet approval sheet.
      // So never on links or wallet buttons, and inside a wallet's own browser (where every
      // create/join/claim pops an approval) only once a run is live and nothing needs signing.
      if ((e.target as HTMLElement)?.closest?.("a, #ph, [data-nofs]")) return;
      if (hasPhantom() && isMobileBrowser() && !document.body.classList.contains("mode-live")) return;
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
  else if (act === "device") void askDevice();
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
  const mobileNoWallet = !hasPhantom() && isMobileBrowser();
  const links = walletBrowseLinks();
  screen.className = "card";
  screen.innerHTML = `
    <h2>▶ Press start</h2>
    <p class="muted">Connect a wallet to open a run, or join one from an invite link.</p>
    <div class="row">
      ${NETS[net].airdrop || params.has("dev") ? `<button id="dev" class="big">Dev wallet</button>` : ""}
      ${
        hasPhantom() || !mobileNoWallet
          ? `<button id="ph" class="big ${NETS[net].airdrop || params.has("dev") ? "ghost" : ""}" ${hasPhantom() ? "" : "disabled"}>Connect Phantom</button>`
          : `<a class="btn big" href="${links.phantom}">👻 Open in Phantom</a><button class="ghost" id="copy-link" data-nofs>Copy link</button>`
      }
      <button class="ghost" data-guide>How to play</button>
    </div>
    ${
      hasPhantom()
        ? ""
        : mobileNoWallet
          ? `<p class="muted">Phone browsers can't reach wallet apps directly. This button reopens the game inside Phantom's own browser, where Connect works. If nothing happens, tap <b>Copy link</b>, open Phantom, and paste it into the search bar on its Explore tab. No wallet yet? <a href="https://phantom.com/download" target="_blank" rel="noopener">Get Phantom</a>.</p>`
          : `<p class="muted">Phantom not detected. <a href="https://phantom.com/download" target="_blank" rel="noopener">Get Phantom</a> for your browser.</p>`
    }
    ${net === "devnet" ? `<p class="muted">Runs on Solana <b>devnet</b>: switch Phantom to devnet (Settings → Developer settings → Testnet mode) and grab free devnet SOL at <a href="https://faucet.solana.com" target="_blank" rel="noopener">faucet.solana.com</a>. A run costs about 0.02 SOL plus your stake.</p>` : ""}`;
  $("dev")?.addEventListener("click", () => guarded("Dev wallet", async () => connected(await devWallet(chain))));
  $("ph")?.addEventListener("click", () => guarded("Phantom", async () => connected(await connectPhantom())));
  screen.querySelector("a.btn")?.addEventListener("click", () => track("open_in_phantom", { device }));
  $("copy-link")?.addEventListener("click", () => {
    const url = location.href;
    const done = () => toast("Link copied: paste it into Phantom's browser");
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => prompt("Copy this link:", url));
    else prompt("Copy this link:", url);
    track("copy_link", { device });
  });
  // Inside a wallet app's browser the provider can appear just after load: re-render when it does.
  if (!hasPhantom())
    void waitForPhantom(4000).then((ok) => {
      if (ok && !wallet && screen.querySelector("#dev, #ph, a.btn")) showConnect();
    });
}

async function connected(w: WalletSigner) {
  wallet = w;
  track("wallet_connected", { device });
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
        await needSol(entry + 35_000_000, "opening a game (your stake + fees)");
        // The host plays too: they take seat P1 in the same transaction that opens the run.
        const { run } = await chain.createRun(wallet!, entry, dur, { seatHost: (r) => sessionKey(r).publicKey });
        const url = new URL(location.href);
        url.searchParams.set("run", run.toBase58());
        history.replaceState(null, "", url);
        runKey = run;
        track("game_created", { stake_sol: entry / LAMPORTS_PER_SOL, timer_s: dur, device });
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
  let got: Awaited<ReturnType<Chain["fetchRun"]>>;
  try {
    got = await chain.fetchRun(run);
  } catch (e) {
    if (!(e instanceof OutdatedRunError)) throw e;
    // An invite or bookmarked link to a game from before a program upgrade.
    setMode("landing");
    screen.className = "card red";
    screen.innerHTML = `
      <h2>Old game link</h2>
      <p class="muted">This game was created with an older version of Extraction Dungeon and can't be opened any more.</p>
      <div class="row"><button id="again" class="big pink">▶ New game</button></div>`;
    $("again").addEventListener("click", newGame);
    return;
  }
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
  const prev = state;
  state = s;
  onEr = isEr;
  useLayout(s.layout ?? 0);
  if (s.status === Status.Lobby) return showLobby();
  if (s.status === Status.Live) {
    if (!isEr) return void waitForEr();
    if (!wasLive) {
      sfx.start();
      resetAnnouncer();
    } else if (prev && prev.status === Status.Live) announce(prev, s);
    revealMyChests();
    return showLive();
  }
  if (s.status === Status.Ended) {
    if (isEr) return void waitForBase();
    return void showEnded();
  }
  if (s.status === Status.Cancelled) return void showCancelled();
}

/** Solana Explorer page for a base-layer transaction on this network. */
function explorerTx(sig: string) {
  const cluster = net === "devnet" ? "devnet" : `custom&customUrl=${encodeURIComponent(NETS[net].base)}`;
  return `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
}

/** Shows a "verify it yourself" link to the payout/refund transaction under the result. */
function showProof(sig: string, what: "payout" | "refund") {
  const box = document.getElementById("proof");
  if (!box) return;
  box.innerHTML = `<a href="${explorerTx(sig)}" target="_blank" rel="noopener">🔎 Verify the ${what} on Solana Explorer ↗</a>
    <small class="mono">${sig.slice(0, 8)}…${sig.slice(-8)}</small>`;
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
      <div id="proof" class="proof"></div>
      <div class="row" style="justify-content:center"><button id="again" class="big pink">▶ New game</button></div>
    </div>`;
  if (Number(s.entryLamports.toString()) > 0) void chain.payoutSignature(runKey!, "refund").then((sig) => sig && showProof(sig, "refund"));
  $("again").addEventListener("click", newGame);
}

/** The payout this tab sent itself, so a re-render shows it instead of looking it up. */
let knownPayout: { run: string; sig: string } | null = null;

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
  if (!wallet) return showConnect();
  setMode("landing");
  const me = mySeat();
  const isHost = wallet!.publicKey.equals(s.authority);
  const slots = [0, 1, 2, 3]
    .map((i) => {
      const col = hexColor(SEAT_COLORS[i]);
      if (i >= s.playerCount)
        return `<div class="slot empty"><span class="pn">P${i + 1}</span><small class="blink">INSERT<br/>COIN</small><span class="nm" style="font-size:14px">${isHost ? "add a CPU or<br/>invite a friend" : ""}</span></div>`;
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
      track("lobby_cancelled", { players: s.playerCount });
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
      await needSol(Number(s.entryLamports.toString()) + 30_000_000, "joining (stake + fees)");
      const seat = await chain.joinRun(wallet!, runKey!, session!.publicKey);
      track("game_joined", { stake_sol: Number(s.entryLamports.toString()) / LAMPORTS_PER_SOL, device });
      toast("Joined. Making your bag private…");
      await protectBag(seat);
    }),
  );
  $("start")?.addEventListener("click", () =>
    guarded("Start", async () => {
      ($("start") as HTMLButtonElement).disabled = true;
      await chain.startRun(wallet!, runKey!, s.runId);
      track("game_started", { players: s.playerCount, cpus: bots.length, map: MAP.name, stake_sol: Number(s.entryLamports.toString()) / LAMPORTS_PER_SOL });
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
  const wasLive = document.body.classList.contains("mode-live");
  setMode("live");
  if (!wasLive && isTouch && matchMedia("(orientation: portrait)").matches) toast("📱↻ Turn your phone sideways to see the whole dungeon");
  screen.innerHTML = "";
  if (!scene) {
    scene = startGame(gameEl);
    watchStage();
  }
  startClockSync();
  startBots();
  watchMyBag();
  pushToScene();
  renderHud();
}

/** If the dungeon didn't come up (blank stage), rebuild the game view instead of making the
 *  player refresh. Checked twice shortly after it opens. */
let stageRebuilds = 0;
function watchStage() {
  for (const ms of [2500, 6000]) {
    setTimeout(() => {
      if (!scene || !document.body.classList.contains("mode-live") || document.hidden) return;
      if (scene.isHealthy() || stageRebuilds >= 2) return;
      stageRebuilds++;
      console.warn("stage not rendering; rebuilding the game view");
      track("stage_rebuilt", { attempt: stageRebuilds });
      try {
        scene.game?.destroy(true);
      } catch {
        /* already gone */
      }
      gameEl.innerHTML = "";
      scene = startGame(gameEl);
      pushToScene();
    }, ms);
  }
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
      if (myBag!.lastTier === TIER_MIMIC) {
        banner("MIMIC!", "#ff4d6d");
        feed(`🧰 A mimic bit <b>YOU</b>`, "red");
      } else if (myBag!.lastTier === 3) banner("LEGENDARY!", "#ffd23d");
    }
  });
}

// ---------- announcer + kill feed ----------
// Only public facts are announced (deaths, escapes, who opened the Vault). Nobody else's loot is
// ever revealed: "escaped with N" is shown for your own escape only.
let firstBlood = false;
let lastStanding = false;
let hurryShown = false;
function resetAnnouncer() {
  bannerQueue.length = 0;
  firstBlood = false;
  lastStanding = false;
  hurryShown = false;
  const el = document.getElementById("feed");
  if (el) el.innerHTML = "";
}
const nameOf = (i: number) => (i === mySeat() ? "YOU" : who(i, state!.players[i].wallet).replace("🤖 ", ""));
/** Big banners play one at a time (two at once would draw on top of each other). */
const bannerQueue: [string, string][] = [];
let bannerBusy = false;
function banner(text: string, color: string) {
  bannerQueue.push([text, color]);
  if (!bannerBusy) nextBanner();
}
function nextBanner() {
  const next = bannerQueue.shift();
  if (!next) {
    bannerBusy = false;
    return;
  }
  bannerBusy = true;
  scene?.flashText(next[0], next[1]);
  setTimeout(nextBanner, 1300);
}
function feed(html: string, tone: "red" | "green" | "gold" | "cyan" = "cyan") {
  const el = document.getElementById("feed");
  if (!el) return;
  const row = document.createElement("div");
  row.className = `feed-row ${tone}`;
  row.innerHTML = html;
  el.prepend(row);
  while (el.children.length > 4) el.lastElementChild!.remove();
  setTimeout(() => row.classList.add("out"), 6000);
  setTimeout(() => row.remove(), 6800);
}
function announce(prev: RunState, s: RunState) {
  const me = mySeat();
  const n = s.playerCount;
  for (let j = 0; j < n; j++) {
    const was = prev.players[j];
    const now = s.players[j];
    if (was.alive && !now.alive) {
      const killer = [...Array(n).keys()].find((i) => s.players[i].kills > prev.players[i].kills);
      const byGuardian = (prev.monsters ?? []).some((g) => g.alive && Math.abs(g.x - was.x) + Math.abs(g.y - was.y) <= 2);
      if (killer === undefined) feed(byGuardian ? `👹 A Vault Guardian got <b>${esc(nameOf(j))}</b>` : `🧰 A mimic got <b>${esc(nameOf(j))}</b>`, "red");
      else feed(`<b>${esc(nameOf(killer))}</b> ⚔ <b>${esc(nameOf(j))}</b>`, "red");
      if (!firstBlood) {
        firstBlood = true;
        banner("FIRST BLOOD", "#ff4d6d");
      }
    }
    if (!was.extracted && now.extracted) {
      feed(`🚪 <b>${esc(nameOf(j))}</b> escaped`, "green");
      if (j === me) banner(`ESCAPED WITH ${myBag?.points ?? 0}`, "#4ef0a0");
    }
  }
  (s.monsters ?? []).forEach((g, k) => {
    const was = prev.monsters?.[k];
    if (was?.alive && !g.alive) {
      const by = [...Array(n).keys()].find((i) => s.players[i].alive && Math.abs(s.players[i].x - was.x) + Math.abs(s.players[i].y - was.y) === 1);
      feed(by === undefined ? `👹 A Vault Guardian fell` : `<b>${esc(nameOf(by))}</b> ⚔ a Vault Guardian`, "gold");
      banner("GUARDIAN SLAIN", "#b98cff");
    }
  });
  const v = MAP.VAULT;
  if (prev.chests[v].state !== ChestState.Opened && s.chests[v].state === ChestState.Opened) {
    feed(`👑 <b>${esc(nameOf(s.chests[v].opener))}</b> cracked the Vault`, "gold");
    banner("VAULT CRACKED", "#ffd23d");
  }
  const active = (r: RunState) => r.players.slice(0, r.playerCount).map((p, i) => ({ p, i })).filter(({ p }) => p.alive && !p.extracted);
  const left = active(s);
  if (!lastStanding && n > 1 && active(prev).length > 1 && left.length === 1) {
    lastStanding = true;
    banner(left[0].i === me ? "LAST ONE STANDING" : `${nameOf(left[0].i)} IS LAST`, "#3df2ff");
  }
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
      <button class="ghost small icon" data-act="device" aria-label="Change device">🎮</button>
    </div>
    <div class="hud-msg"><div class="hud-box">
      ${msg}
      ${canEnd ? `<button id="end" class="small">End run</button>` : ""}
      ${!msg && !canEnd && actionsSent < 6 ? `<span class="keys"><kbd>WASD</kbd>/<kbd>arrows</kbd> move · bump to hit or open · <kbd>E</kbd> extract · <a href="#" data-guide>guide</a></span>` : ""}
    </div></div>`;
  if (!msg && !canEnd && (isTouch || actionsSent >= 6)) (hud.querySelector(".hud-msg") as HTMLElement).style.display = "none";
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
  if (left > 0 && left <= 30 && !hurryShown && state?.status === Status.Live) {
    hurryShown = true;
    banner("HURRY UP!", "#ff3dc7");
  }
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

const finishedTracked = new Set<string>();
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
  // Mirrors Run::payouts: extracted players split by loot; if nobody got out, nobody is paid.
  const share = (i: number) => {
    if (!s.players[i].extracted) return 0;
    return total === 0 ? Math.floor(pot / extracted.length) : Math.floor((pot * points[i]) / total);
  };
  const best = [...extracted].sort((a, b) => share(b.i) - share(a.i) || points[b.i] - points[a.i])[0];
  const myShare = me >= 0 ? share(me) : 0;
  const iWon = me >= 0 && s.players[me].extracted;
  const iTopped = !!best && best.i === me;
  if (runKey && !finishedTracked.has(runKey.toBase58())) {
    finishedTracked.add(runKey.toBase58());
    const outcome = me < 0 ? "spectator" : s.players[me].extracted ? "escaped" : s.players[me].alive ? "trapped" : "slain";
    track("run_finished", { outcome, points: me >= 0 ? points[me] : 0, players: s.playerCount, practice: pot === 0, map: MAP.name });
  }
  const practice = pot === 0;
  const title = !best
    ? { t: "GAME OVER", cls: "neon-red", sub: practice ? "Nobody made it out" : "Nobody made it out: the dungeon keeps the pot" }
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
      <div id="proof" class="proof"></div>
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
  if (s.settled) {
    // Our own claim already knows its signature; otherwise look the payout up on-chain.
    const known = knownPayout?.run === runKey!.toBase58() ? knownPayout.sig : null;
    if (known) showProof(known, "payout");
    else void chain.payoutSignature(runKey!, "payout").then((sig) => sig && showProof(sig, "payout"));
  }

  $("settle")?.addEventListener("click", () =>
    guarded("Settle", async () => {
      const btn = $("settle") as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Paying out…";
      const sig = await chain.settleRun(await ensureWallet(), runKey!, s);
      knownPayout = { run: runKey!.toBase58(), sig };
      track("payout_claimed", { won: iWon, amount_sol: myShare / LAMPORTS_PER_SOL });
      showProof(sig, "payout");
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
  return (
    MAP.LAYOUT[y]?.[x] === "." &&
    !MAP.CHESTS.some(([cx, cy]) => cx === x && cy === y) &&
    !(state?.monsters ?? []).some((g) => g.alive && g.x === x && g.y === y)
  );
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
  const target =
    s.players.slice(0, s.playerCount).some((o) => o.alive && !o.extracted && o.x === tx && o.y === ty) ||
    (s.monsters ?? []).some((g) => g.alive && g.x === tx && g.y === ty);
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

initAnalytics();
if (savedDevice) initGuide();
else void askDevice().then(() => initGuide());
renderWallet();
if (runKey) void resumeRun(runKey);
else showConnect();

// ---------- Vault Guardians: keep them moving ----------
// The host's tab first asks the rollup's scheduler to tick them (a MagicBlock crank, validator 1.x).
// Whether or not that works (validator 2.0 moved cranks to Hydra and rejects it), seated tabs tick
// them whenever no tick has landed lately: the host's tab right away, everyone else's after a pause
// (a backup if the host left or reloaded). Ticks are signed by the session key, so no wallet is
// needed, and the on-chain rate limit makes extra ticks harmless.
let ticking = false;
let crankTried = "";
let lastTick = { slot: "", at: 0 };
setInterval(() => {
  const s = state;
  if (ticking || !s || s.status !== Status.Live || !onEr || !runKey) return;
  if (!(s.monsters ?? []).some((g) => g.alive)) return;
  if (secondsLeft() === 0) return;
  const me = mySeat();
  const key = me >= 0 ? session : bots[0]?.session;
  if (!key) return;
  const slot = s.lastTickSlot.toString();
  if (slot !== lastTick.slot) lastTick = { slot, at: Date.now() };
  const hostTab = (wallet?.publicKey.equals(s.authority) ?? false) || bots.length > 0 || me === 0;
  const scheduled = !s.crankSigner.equals(PublicKey.default);
  if (!scheduled && hostTab && crankTried !== runKey.toBase58()) {
    crankTried = runKey.toBase58(); // once per run: if the validator refuses, the ticks below take over
    ticking = true;
    chain
      .startGuardians(key, runKey, s.playerCount)
      .then(() => track("guardian_crank_scheduled"))
      .catch(() => track("guardian_crank_unavailable"))
      .finally(() => (ticking = false));
    return;
  }
  const quietMs = Date.now() - lastTick.at;
  if (quietMs < (scheduled ? 3000 : hostTab ? 0 : 2500)) return;
  ticking = true;
  chain
    .tickMonsters(key, runKey, s.playerCount)
    .catch(() => {}) // a tick that lands at the buzzer, or races another, is harmless
    .finally(() => (ticking = false));
}, 700);
