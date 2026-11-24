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
  else void ctx?.resume();
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
