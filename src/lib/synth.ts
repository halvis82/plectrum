"use client";
// An acoustic guitar for playing tabs back: recorded notes of a real steel-string guitar, one set per
// string, so each note sounds on the string the tab puts it on. They come from GuitarSet's per-string
// pickup tracks, colored by a body and microphone filter fit to its mic recordings (scripts/guitar-bank),
// and play into a small room. A string rings
// until it's played again; slides and bends move the ringing note's pitch, hammer-ons and pull-offs
// sound without a pick attack. Until the recordings are in (or if they can't load), a plucked-string
// model plays instead.

const BANK = "/guitar/v1";
/** time constant of a string being damped, seconds */
const DAMP = 0.008;
/** open strings the bank was recorded on, low E first */
const OPEN = [40, 45, 50, 55, 59, 64];

type Slot = { string: number; midi: number; start: number; len: number };
type Bank = { buffer: AudioBuffer; slots: Slot[][] };
/** what a note is: `string` 0 = low E, or -1 when unknown (a preview) */
export type PlayNote = { midi: number; string: number; when: number; dur: number; gain: number; tech: number };

/** `pitch`: the MIDI pitch sounding now, at playback rate `rate`; `end`: when its damping is scheduled */
type Voice = { src: AudioBufferSourceNode; g: GainNode; rate: number; pitch: number; level: number; end: number };

let shared: Promise<Bank | null> | null = null;
/** The recordings, fetched once per visit (about 2 MB). */
function loadBank(ctx: BaseAudioContext): Promise<Bank | null> {
  shared ??= (async () => {
    try {
      const [meta, data] = await Promise.all([
        fetch(`${BANK}/bank.json`).then((r) => r.json() as Promise<{ slots: { string: number; midi: number; at: number; len: number }[] }>),
        fetch(`${BANK}/bank.mp3`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))),
      ]);
      const buffer = await ctx.decodeAudioData(data);
      const ch = buffer.getChannelData(0);
      const sr = buffer.sampleRate;
      const slots: Slot[][] = OPEN.map(() => []);
      for (const s of meta.slots) {
        // encoders and decoders pad the start differently: find each note's attack near where it should be
        let start = Math.max(0, Math.round(s.at * sr) - Math.round(0.002 * sr));
        const look = Math.min(ch.length, start + Math.round(0.08 * sr));
        let peak = 0;
        for (let i = start; i < look; i++) peak = Math.max(peak, Math.abs(ch[i]));
        for (let i = start; i < look; i++)
          if (Math.abs(ch[i]) > 0.1 * peak) {
            start = Math.max(0, i - Math.round(0.003 * sr));
            break;
          }
        slots[s.string].push({ string: s.string, midi: s.midi, start: start / sr, len: s.len });
      }
      slots.forEach((l) => l.sort((a, b) => a.midi - b.midi));
      return { buffer, slots };
    } catch {
      shared = null;
      return null;
    }
  })();
  return shared;
}

/** Fetches the recordings into the browser's cache ahead of the first play, at low priority. */
export function prefetchGuitar() {
  for (const f of ["bank.json", "bank.mp3"]) void fetch(`${BANK}/${f}`, { priority: "low" }).catch(() => {});
}

export class GuitarSynth {
  readonly out: GainNode;
  private input: AudioNode;
  private bank: Bank | null = null;
  readonly ready: Promise<boolean>;
  /** the note ringing on each string */
  private ringing: (Voice | null)[] = OPEN.map(() => null);
  private cache = new Map<string, AudioBuffer>();

  constructor(private ctx: BaseAudioContext) {
    // a gentle limiter so dense chords never clip
    const comp = new DynamicsCompressorNode(ctx, { threshold: -10, knee: 6, ratio: 3, attack: 0.004, release: 0.25 });
    this.out = new GainNode(ctx, { gain: 0.9 });
    comp.connect(this.out).connect(ctx.destination);
    // the room: a quarter as loud as the guitar itself (what scored closest to the real recordings)
    const dry = new GainNode(ctx, { gain: 1 });
    const room = new ConvolverNode(ctx, { buffer: roomResponse(ctx), disableNormalization: true });
    const wet = new GainNode(ctx, { gain: 0.25 });
    dry.connect(comp);
    dry.connect(room).connect(wet).connect(comp);
    this.input = dry;
    this.ready = loadBank(ctx).then((b) => !!(this.bank = b));
  }

  /** Plays a note at context time `when`; returns a function that silences it now. */
  play(n: PlayNote): () => void {
    const string = n.string >= 0 && n.string < OPEN.length ? n.string : nearestString(n.midi);
    const prev = this.ringing[string];
    // slide (3) or bend (4) into this note: the string already ringing changes pitch, no new attack
    if ((n.tech === 3 || n.tech === 4) && prev && prev.end > n.when - 0.05) return this.glide(prev, n);

    const v = this.voice(n, string, n.tech === 1 || n.tech === 2);
    // the same string can only sound one note: the one before stops as this one starts
    if (prev && prev.end > n.when) this.release(prev, n.when, 0.012);
    this.ringing[string] = v;
    return () => this.silence(v);
  }

  private voice(n: PlayNote, string: number, legato: boolean): Voice {
    const ctx = this.ctx;
    const slot = this.bank ? nearest(this.bank.slots[string], n.midi) : null;
    const src = slot ? new AudioBufferSourceNode(ctx, { buffer: this.bank!.buffer }) : new AudioBufferSourceNode(ctx, { buffer: this.pluck(n.midi, legato) });
    const rate = slot ? 2 ** ((n.midi - slot.midi) / 12) : 1;
    src.playbackRate.value = rate;
    const g = new GainNode(ctx, { gain: 0 });
    // hammer-ons and pull-offs have no pick: skip the attack and swell in
    const skip = slot && legato ? 0.018 : 0;
    g.gain.setValueAtTime(0, n.when);
    const level = n.gain * (legato ? 0.6 : 1);
    g.gain.linearRampToValueAtTime(level, n.when + (legato ? 0.012 : 0.002));
    src.connect(g).connect(this.input);
    const length = slot ? (slot.len - skip) / rate : RING;
    if (slot) src.start(n.when, slot.start + skip, slot.len - skip);
    else src.start(n.when);
    const v: Voice = { src, g, rate, pitch: n.midi, level, end: Infinity };
    // the hand stops the string quickly when a note ends (a slower fade sounded less like the recordings)
    this.release(v, n.when + Math.min(n.dur, length), DAMP);
    return v;
  }

  /** a ringing note moves to a new pitch: quickly for a slide, smoothly for a bend */
  private glide(v: Voice, n: PlayNote): () => void {
    const target = v.rate * 2 ** ((n.midi - v.pitch) / 12);
    v.src.playbackRate.setValueAtTime(v.rate, n.when);
    if (n.tech === 3) v.src.playbackRate.linearRampToValueAtTime(target, n.when + 0.07);
    else v.src.playbackRate.setTargetAtTime(target, n.when, 0.045);
    Object.assign(v, { rate: target, pitch: n.midi });
    // it keeps ringing for the new note's length
    this.release(v, n.when + n.dur, DAMP);
    return () => this.silence(v);
  }

  /** Damps the note at `at` instead of whenever it was going to be. */
  private release(v: Voice, at: number, time: number) {
    const from = Math.min(v.end, at);
    v.g.gain.cancelScheduledValues(from);
    v.g.gain.setValueAtTime(v.level, from);
    v.g.gain.setTargetAtTime(0, at, time);
    // the last stop() called is the one that applies
    v.src.stop(at + time * 8);
    v.end = at;
  }

  private silence(v: Voice) {
    try {
      const now = this.ctx.currentTime;
      v.g.gain.cancelScheduledValues(now);
      v.g.gain.setTargetAtTime(0, now, 0.015);
      v.src.stop(now + 0.08);
    } catch {}
  }

  private pluck(midi: number, soft: boolean): AudioBuffer {
    const key = `${midi}:${soft ? 1 : 0}`;
    let b = this.cache.get(key);
    if (!b) {
      const sr = this.ctx.sampleRate;
      b = this.ctx.createBuffer(1, Math.floor(sr * RING), sr);
      b.copyToChannel(pluck(midi, sr, soft) as Float32Array<ArrayBuffer>, 0);
      this.cache.set(key, b);
    }
    return b;
  }
}

/** A small room's response: noise decaying over half a second, highs faster than lows, 8 ms after the
 * direct sound. */
function roomResponse(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const rt60 = 0.5;
  const n = Math.floor(rt60 * 1.5 * sr);
  const b = ctx.createBuffer(2, n, sr);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const k = 1 - Math.exp((-2 * Math.PI * 3000) / sr);
  for (let c = 0; c < 2; c++) {
    const y = b.getChannelData(c);
    let lp = 0;
    let energy = 0;
    for (let i = Math.floor(0.008 * sr); i < n; i++) {
      const t = i / sr;
      const x = rand();
      lp += k * (x - lp);
      y[i] = lp * Math.exp((-6.9 * t) / rt60) + (x - lp) * Math.exp((-6.9 * t) / (rt60 / 2));
      energy += y[i] * y[i];
    }
    const g = 1 / Math.sqrt(energy);
    for (let i = 0; i < n; i++) y[i] *= g;
  }
  return b;
}

function nearest(slots: Slot[], midi: number): Slot | null {
  let best: Slot | null = null;
  for (const s of slots) if (!best || Math.abs(s.midi - midi) < Math.abs(best.midi - midi)) best = s;
  return best;
}

/** the string a note would usually be played on, when the tab doesn't say */
function nearestString(midi: number) {
  for (let s = OPEN.length - 1; s >= 0; s--) if (midi >= OPEN[s]) return s;
  return 0;
}

const RING = 3.2; // seconds of the plucked-string model per note

/** One plucked string (Karplus-Strong), the stand-in while the recordings load. */
export function pluck(midi: number, sr: number, soft = false): Float32Array {
  const f = 440 * 2 ** ((midi - 69) / 12);
  const len = Math.floor(sr * RING);
  const y = new Float32Array(len);
  // the two-point average in the loop delays by half a sample
  const period = sr / f - 0.5;
  const p0 = Math.floor(period);
  // low strings ring longer than high ones
  const t60 = Math.max(1.2, Math.min(5, 4.2 * Math.sqrt(110 / f)));
  const rho = Math.pow(10, -3 / (f * t60));
  // excitation: one period of noise, smoothed (softer for fretting-hand notes), with a comb for picking
  // about a fifth of the way along the string
  const exc = new Float32Array(p0 + 2);
  let lp = 0;
  const smooth = soft ? 0.25 : 0.6;
  let seed = midi * 9301 + 49297;
  for (let i = 0; i < exc.length; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    const r = seed / 233280 - 0.5;
    lp += smooth * (r - lp);
    exc[i] = lp;
  }
  const pick = Math.max(1, Math.round(p0 * 0.18));
  for (let i = exc.length - 1; i >= pick; i--) exc[i] -= exc[i - pick];
  const frac = period - p0;
  for (let n = 0; n < len; n++) {
    const a = n - p0, b = a - 1, c = a - 2;
    // the delayed sample at the exact period (linear between neighbours), averaged with the one before
    const d1 = a >= 0 ? (1 - frac) * y[a] + (b >= 0 ? frac * y[b] : 0) : 0;
    const d2 = b >= 0 ? (1 - frac) * y[b] + (c >= 0 ? frac * y[c] : 0) : 0;
    y[n] = (n < exc.length ? exc[n] : 0) + rho * 0.5 * (d1 + d2);
  }
  let peak = 0;
  for (let n = 0; n < len; n++) peak = Math.max(peak, Math.abs(y[n]));
  const k = peak > 0 ? 0.5 / peak : 0;
  // a short fade-in removes the click of the first sample
  for (let n = 0; n < len; n++) y[n] *= k * Math.min(1, n / 24);
  return y;
}
