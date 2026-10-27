"use client";
// A plucked acoustic guitar for playing tabs back: Karplus-Strong strings (a noise burst circulating in a
// tuned, slowly damped delay line), rendered once per pitch and reused, through a small body resonance.

const RING = 3.2; // seconds rendered per note; longer notes fade naturally before this ends

export class GuitarSynth {
  readonly out: GainNode;
  private cache = new Map<string, AudioBuffer>();

  constructor(private ctx: AudioContext) {
    // body: cut the rumble, lift the wood's low resonances and a little presence
    const hp = new BiquadFilterNode(ctx, { type: "highpass", frequency: 70 });
    const body1 = new BiquadFilterNode(ctx, { type: "peaking", frequency: 110, Q: 1.2, gain: 5 });
    const body2 = new BiquadFilterNode(ctx, { type: "peaking", frequency: 230, Q: 1.4, gain: 3 });
    const air = new BiquadFilterNode(ctx, { type: "peaking", frequency: 2800, Q: 0.8, gain: 2 });
    const comp = new DynamicsCompressorNode(ctx, { threshold: -14, ratio: 4, attack: 0.003, release: 0.2 });
    this.out = new GainNode(ctx, { gain: 0.9 });
    hp.connect(body1).connect(body2).connect(air).connect(comp).connect(this.out).connect(ctx.destination);
    this.input = hp;
  }
  private input: AudioNode;

  /** Plays MIDI pitch `midi` at context time `when` for `dur` seconds. `soft`: a hammer-on or pull-off,
   * sounded by the fretting hand, so no pick attack. Returns a stop function. */
  play(midi: number, when: number, dur: number, gain = 0.8, soft = false): () => void {
    const src = new AudioBufferSourceNode(this.ctx, { buffer: this.buffer(midi, soft) });
    const g = new GainNode(this.ctx, { gain: 0 });
    g.gain.setValueAtTime(gain * (soft ? 0.7 : 1), when);
    // the string is damped when the note ends
    const end = when + Math.max(0.05, Math.min(dur, RING - 0.1));
    g.gain.setValueAtTime(gain * (soft ? 0.7 : 1), end);
    g.gain.exponentialRampToValueAtTime(0.0008, end + 0.09);
    src.connect(g).connect(this.input);
    src.start(when);
    src.stop(end + 0.1);
    return () => {
      try {
        g.gain.cancelScheduledValues(0);
        g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.015);
        src.stop(this.ctx.currentTime + 0.06);
      } catch {}
    };
  }

  private buffer(midi: number, soft: boolean): AudioBuffer {
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

/** One plucked string. */
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
