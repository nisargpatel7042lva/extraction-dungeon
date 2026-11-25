// "How to play": a modal guide that opens on the first visit and from any [data-guide] element.

const S = (name: string) => `${import.meta.env.BASE_URL}sprites/${name}.png`;

const STEPS: { img: string; title: string; body: string }[] = [
  {
    img: "hero0",
    title: "1. Join a run",
    body: "Connect a wallet, then create a run or open an invite link and press <b>Join</b>. Your stake goes into the pot. Up to 4 players; the host presses <b>Start</b>. Playing alone? Add <b>🤖 Easy, Medium or Hard bots</b> from the lobby (set the stake to 0 for a free practice run).",
  },
  {
    img: "chest_closed",
    title: "2. Loot chests",
    body: "Move with <kbd>WASD</kbd>/<kbd>arrow keys</kbd>, or the on-screen pad on a phone. Walk into a chest to open it, and MagicBlock VRF rolls the loot: <b>common 1 pt</b> (50%), <b>rare 3 pts</b> (30%), <b>legendary 8 pts</b> (10%), and 1 chest in 10 is a <b>mimic</b> that bites for 1 heart and gives nothing. The golden <b>Vault</b> in the middle never rolls common or a mimic, but two <b>Vault Guardians</b> stand beside it: they chase anyone who comes near and bite. Three hits kill one, for a +2 bounty.",
  },
  {
    img: "hero1",
    title: "3. Fight",
    body: "Walk into another player to hit them. <b>3 hits kill</b>, and you can attack again every 0.4 s (watch the Attack meter). Moves and hits are instant: no wallet popups, no fees.",
  },
  {
    img: "sack",
    title: "4. Steal",
    body: "When a player dies, their whole bag drops as a <b>sack</b>. Walk over it to take everything inside. You can't see what's in it until you grab it.",
  },
  {
    img: "exit",
    title: "5. Get out",
    body: "The four green portals <b>unlock a quarter of the way in</b>. Stand on one, press <kbd>E</kbd> (or <b>EXIT</b>), and <b>hold still for 2 seconds</b> while a ring fills. Everyone can see you channeling, and a single hit cancels it. Only players who extract get paid. If the timer runs out while you're inside, you're trapped and lose your loot.",
  },
  {
    img: "chest_open",
    title: "6. Get paid",
    body: "When the run ends, the pot is split between everyone who got out, <b>in proportion to their loot points</b>. Press <b>Settle payouts</b> to send it. If nobody gets out, every stake is refunded.",
  },
];

const HTML = `
  <form method="dialog" class="guide-close"><button class="ghost" aria-label="Close">✕</button></form>
  <h2>How to play</h2>
  <p class="muted">Stake SOL, loot the dungeon, fight other players, and get out alive. Whatever you extract with is yours.</p>
  <ol class="guide-steps">
    ${STEPS.map((s) => `<li><img src="${S(s.img)}" alt="" /><div><b>${s.title}</b><p>${s.body}</p></div></li>`).join("")}
  </ol>
  <div class="guide-note">
    <b>🔒 Your bag is private.</b> The game runs on a MagicBlock <i>Private</i> Ephemeral Rollup: only you can see your loot
    and what your chests rolled. Opponents see a <b>?</b>. Every bag is revealed when the run ends.
  </div>
  <p class="muted"><b>Tips:</b> grab a chest early, but every second inside is a second someone can catch you.
  Camping an exit works until three hits land on you. A fat bag is worth stealing.</p>
  <form method="dialog"><button>Got it, let's play</button></form>`;

export function initGuide() {
  const dlg = document.createElement("dialog");
  dlg.id = "guide";
  dlg.innerHTML = HTML;
  document.body.appendChild(dlg);

  document.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("[data-guide]");
    if (!t) return;
    e.preventDefault();
    dlg.showModal();
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close(); // click on the backdrop
  });

  let seen = false;
  try {
    seen = localStorage.getItem("ed:guide-seen") === "1";
    localStorage.setItem("ed:guide-seen", "1");
  } catch {
    /* storage blocked: just don't remember */
  }
  if (!seen) dlg.showModal();
}
