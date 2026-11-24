// Procedural sound effects with WebAudio: no audio files to load, tiny, and tunable in code.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = (() => {
  try {
    return localStorage.getItem("ed:muted") === "1";
  } catch {
    return false;
  }
})();

function audio(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

// Browsers only allow audio after a user gesture: unlock on the first one.
["pointerdown", "keydown", "touchstart"].forEach((ev) => window.addEventListener(ev, () => audio(), { once: true, passive: true }));

export function isMuted() {
  return muted;
}

export function setMuted(m: boolean) {
  muted = m;
  try {
    localStorage.setItem("ed:muted", m ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (m) void ctx?.suspend();
  else {
    void ctx?.resume();
    if (musicWanted && !musicTimer) music.start(); // music asked for while muted: start it now
  }
}

/** One enveloped oscillator note. */
function tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; slideTo?: number; delay?: number } = {}) {
  const a = audio();
  if (!a || !master) return;
  const t = a.currentTime + (opts.delay ?? 0);
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = opts.type ?? "square";
  o.frequency.setValueAtTime(freq, t);
  if (opts.slideTo) o.frequency.exponentialRampToValueAtTime(opts.slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.3, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** A short burst of filtered noise (hits, thuds). */
function noise(dur: number, opts: { gain?: number; freq?: number; delay?: number } = {}) {
  const a = audio();
  if (!a || !master) return;
  const t = a.currentTime + (opts.delay ?? 0);
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = opts.freq ?? 1800;
  const g = a.createGain();
  g.gain.value = opts.gain ?? 0.4;
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

export const sfx = {
  step: () => tone(160 + Math.random() * 30, 0.05, { type: "triangle", gain: 0.08 }),
  bump: () => tone(90, 0.06, { type: "square", gain: 0.06 }),
  swing: () => noise(0.08, { gain: 0.15, freq: 3500 }),
  hit: () => {
    noise(0.12, { gain: 0.5, freq: 1400 });
    tone(140, 0.12, { type: "square", gain: 0.18, slideTo: 70 });
  },
  hurt: () => {
    noise(0.18, { gain: 0.55, freq: 900 });
    tone(220, 0.22, { type: "sawtooth", gain: 0.2, slideTo: 90 });
  },
  death: () => {
    tone(330, 0.5, { type: "sawtooth", gain: 0.25, slideTo: 55 });
    noise(0.4, { gain: 0.35, freq: 600, delay: 0.05 });
  },
  chestOpening: () => {
    for (let i = 0; i < 4; i++) tone(500 + i * 90, 0.06, { type: "triangle", gain: 0.12, delay: i * 0.09 });
  },
  chest: (tier: number) => {
    const notes = tier === 3 ? [523, 659, 784, 1047, 1319] : tier === 2 ? [523, 659, 784] : [523, 659];
    notes.forEach((f, i) => tone(f, 0.18, { type: "square", gain: tier === 3 ? 0.22 : 0.16, delay: i * 0.08 }));
    if (tier === 3) tone(1568, 0.6, { type: "triangle", gain: 0.18, delay: notes.length * 0.08 });
  },
  looted: () => tone(330, 0.12, { type: "triangle", gain: 0.1, slideTo: 260 }),
  pickup: () => [660, 880].forEach((f, i) => tone(f, 0.1, { type: "square", gain: 0.15, delay: i * 0.06 })),
  extractStart: () => tone(220, 2.0, { type: "sine", gain: 0.12, slideTo: 880 }),
  extractCancel: () => tone(300, 0.2, { type: "square", gain: 0.12, slideTo: 120 }),
  extracted: () => [392, 523, 659, 784].forEach((f, i) => tone(f, 0.22, { type: "triangle", gain: 0.2, delay: i * 0.07 })),
  exitsOpen: () => [262, 330, 392, 523].forEach((f, i) => tone(f, 0.25, { type: "sine", gain: 0.18, delay: i * 0.1 })),
  tick: () => tone(1000, 0.04, { type: "square", gain: 0.06 }),
  start: () => [196, 262, 330, 392].forEach((f, i) => tone(f, 0.14, { type: "square", gain: 0.14, delay: i * 0.08 })),
  /** UI blip for buttons. */
  select: () => tone(880, 0.04, { type: "square", gain: 0.05 }),
  /** The classic coin-drop "bling". */
  coin: () => {
    tone(988, 0.07, { type: "square", gain: 0.14 });
    tone(1319, 0.32, { type: "square", gain: 0.14, delay: 0.07 });
  },
  /** Victory fanfare. */
  win: () => {
    const seq = [523, 523, 523, 659, 784, 0, 659, 784, 1047];
    seq.forEach((f, i) => f && tone(f, i === seq.length - 1 ? 0.6 : 0.12, { type: "square", gain: 0.16, delay: i * 0.11 }));
  },
  /** Game over: a descending wah-wah. */
  lose: () => [392, 370, 349, 262].forEach((f, i) => tone(f, i === 3 ? 0.7 : 0.28, { type: "sawtooth", gain: 0.14, delay: i * 0.3, slideTo: i === 3 ? 200 : undefined })),
};

// ---------- background music ----------
// "Crypt Run": an original chiptune loop generated in code, A harmonic minor (Am, F, G, E).
// Bass, arpeggio, drums and, on every second pass, a lead melody. In the last 30 seconds of a run
// it speeds up and the hats double, arcade "hurry up" style. Scheduled ahead on the audio clock.

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
const CHORDS = [
  { root: 45, tones: [57, 60, 64, 69] }, // Am
  { root: 41, tones: [53, 57, 60, 65] }, // F
  { root: 43, tones: [55, 59, 62, 67] }, // G
  { root: 40, tones: [52, 56, 59, 64] }, // E (harmonic minor: G#)
];
const _ = 0;
// Lead, one bar of 16th steps per chord (0 = rest).
const LEAD = [
  [69, _, 72, _, 76, _, 74, 72, _, 71, 72, _, 69, _, _, _],
  [65, _, 69, _, 72, _, 71, 69, _, 67, 69, _, 65, _, _, _],
  [67, _, 71, _, 74, _, 72, 71, _, 69, 71, _, 74, _, 76, _],
  [76, _, 75, _, 76, _, 71, _, 68, _, 71, _, 76, _, _, _],
];
const ARP = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 2, 1, 3];
const R = -1; // bass rest
const BASS = [0, R, 12, 0, R, 0, 12, R, 0, R, 12, 0, 7, R, 12, R]; // semitones over the root

let musicBus: GainNode | null = null;
let musicTimer: ReturnType<typeof setInterval> | null = null;
let musicWanted = false;
let musicOn = (() => {
  try {
    return localStorage.getItem("ed:music") !== "0";
  } catch {
    return true;
  }
})();
let nextStepAt = 0;
let stepIdx = 0;
let hurry = false;

function bus(a: AudioContext) {
  if (!musicBus) {
    musicBus = a.createGain();
    musicBus.gain.value = 0.5;
    musicBus.connect(master!);
  }
  return musicBus;
}

function note(a: AudioContext, at: number, freq: number, dur: number, type: OscillatorType, gain: number, slideTo?: number) {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(bus(a));
  o.start(at);
  o.stop(at + dur + 0.02);
}

function hit(a: AudioContext, at: number, dur: number, gain: number, highpass: number) {
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = highpass;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(bus(a));
  src.start(at);
}

function playStep(a: AudioContext, at: number, i: number, stepDur: number) {
  const bar = Math.floor(i / 16) % 8; // 8-bar form: 4 bars groove, 4 bars with the lead
  const s = i % 16;
  const chord = CHORDS[bar % 4];
  if (BASS[s] !== R) note(a, at, midi(chord.root + BASS[s]), stepDur * 1.8, "triangle", 0.32);
  note(a, at, midi(chord.tones[ARP[s]] + 12), stepDur * 0.9, "square", 0.045);
  if (bar >= 4) {
    const n = LEAD[bar % 4][s];
    if (n) note(a, at, midi(n + (hurry ? 12 : 0)), stepDur * 1.7, "square", 0.07);
  }
  // Drums: kick on 1 and 3 (and a pickup when hurrying), snare on 2 and 4, hats on 8ths (16ths when hurrying).
  if (s === 0 || s === 8 || (hurry && s === 10)) note(a, at, 150, 0.12, "sine", 0.5, 40);
  if (s === 4 || s === 12) hit(a, at, 0.1, 0.22, 1200);
  if (s % 2 === 0 || hurry) hit(a, at, 0.03, 0.09, 7000);
}

function tick() {
  const a = audio();
  if (!a) return;
  const stepDur = 60 / (hurry ? 152 : 128) / 4;
  if (nextStepAt < a.currentTime) nextStepAt = a.currentTime + 0.05; // after a stall, don't play catch-up
  while (nextStepAt < a.currentTime + 0.15) {
    playStep(a, nextStepAt, stepIdx++, stepDur);
    nextStepAt += stepDur;
  }
}

export const music = {
  /** Plays the in-game track (if music is on and sound isn't muted). Safe to call repeatedly. */
  start() {
    musicWanted = true;
    if (musicTimer || !musicOn || muted) return;
    const a = audio();
    if (!a) return;
    bus(a).gain.cancelScheduledValues(a.currentTime);
    bus(a).gain.setValueAtTime(0.5, a.currentTime);
    stepIdx = 0;
    nextStepAt = a.currentTime + 0.08;
    musicTimer = setInterval(tick, 30);
    tick();
  },
  /** Fades the track out. */
  stop() {
    musicWanted = false;
    hurry = false;
    if (!musicTimer) return;
    clearInterval(musicTimer);
    musicTimer = null;
    if (ctx && musicBus) {
      musicBus.gain.setValueAtTime(musicBus.gain.value, ctx.currentTime);
      musicBus.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    }
  },
  /** Faster, busier music for the final stretch of a run. */
  setHurry(h: boolean) {
    hurry = h;
  },
  isOn: () => musicOn,
  /** The player's music on/off switch (remembered). Sound effects are unaffected. */
  setOn(on: boolean) {
    musicOn = on;
    try {
      localStorage.setItem("ed:music", on ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (!on) {
      const wanted = musicWanted;
      music.stop();
      musicWanted = wanted;
    } else if (musicWanted) music.start();
  },
};

// Background tabs throttle timers to ~1/s, which would garble the music: pause while hidden.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && musicTimer) {
    const wanted = musicWanted;
    music.stop();
    musicWanted = wanted;
  } else if (!document.hidden && musicWanted) music.start();
});
