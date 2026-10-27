"use client";
// Playback for a song page: the song's own audio (at any speed, same pitch), the tab played on a
// synthesized guitar, or both together, with cut parts skipped. Without audio the clock runs on its own.

import { GuitarSynth } from "./synth";

export type SynthNote = { t: number; end: number; midi: number; gain: number; soft: boolean };
export type TransportState = { playing: boolean; rate: number; audio: boolean; guitar: boolean; click: boolean; hasMedia: boolean };

const LOOKAHEAD = 0.3; // seconds of real time scheduled ahead

export class Transport {
  private media: HTMLAudioElement | null = null;
  private pos = 0;
  private startedAt = 0;
  private timer = 0;
  private ctx: AudioContext | null = null;
  private synth: GuitarSynth | null = null;
  private notes: SynthNote[] = [];
  private nextNote = 0;
  private nextBeat = 0;
  private stops: { stop: () => void; until: number }[] = [];
  private listeners = new Set<() => void>();
  /** song time up to which notes and clicks are already scheduled */
  private scheduledTo = 0;
  private snapshot: TransportState;
  private cuts: [number, number][] = [];
  /** where the music starts: playing from before it (the very top) jumps here */
  private introAt = 0;

  setCuts(cuts: [number, number][]) {
    this.cuts = cuts;
  }
  setIntro(t: number) {
    this.introAt = t;
  }

  constructor(
    public duration: number,
    private beats: number[],
    private meter: number,
    private downbeat: number,
  ) {
    this.snapshot = { playing: false, rate: 1, audio: true, guitar: false, click: false, hasMedia: false };
  }

  // ---- state for React (useSyncExternalStore) ----
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  getState = () => this.snapshot;
  private set(patch: Partial<TransportState>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  setGrid(duration: number, beats: number[], meter: number, downbeat: number) {
    Object.assign(this, { duration, beats, meter, downbeat });
  }

  /** The song's audio element (no controls of its own); null when there is none. */
  setMedia(el: HTMLAudioElement | null) {
    if (el === this.media) return;
    const t = this.now();
    this.media?.pause();
    this.media = el;
    if (el) {
      el.preservesPitch = true;
      el.onended = () => this.pause();
      if (Math.abs(el.currentTime - t) > 0.5 && el.readyState > 0) el.currentTime = t;
    }
    this.set({ hasMedia: !!el });
  }

  setNotes(notes: SynthNote[]) {
    this.notes = [...notes].sort((a, b) => a.t - b.t);
    // what is scheduled already stays; the rest follows the new notes
    this.nextNote = this.firstAfter(this.scheduledTo);
  }

  setOptions(o: Partial<Pick<TransportState, "audio" | "guitar" | "click" | "rate">>) {
    const playing = this.snapshot.playing;
    const t = this.now();
    if (playing) this.pause();
    this.set(o);
    if (this.media) {
      this.media.playbackRate = this.snapshot.rate;
      this.media.muted = !this.snapshot.audio;
    }
    if (playing) {
      this.seek(t);
      this.play();
    }
  }

  private get useMedia() {
    return !!this.media;
  }

  now = (): number => {
    if (this.useMedia) return this.media!.currentTime;
    return this.snapshot.playing ? this.pos + ((performance.now() - this.startedAt) / 1000) * this.snapshot.rate : this.pos;
  };

  async play() {
    if (this.snapshot.playing) return;
    this.ctx ??= new AudioContext({ latencyHint: "interactive" });
    void this.ctx.resume();
    this.synth ??= new GuitarSynth(this.ctx);
    let t = this.now();
    if (t >= this.duration - 0.05) t = 0;
    if (t < 0.3 && this.introAt > 1) t = this.introAt;
    t = this.skipCut(t);
    if (this.useMedia) {
      const m = this.media!;
      m.playbackRate = this.snapshot.rate;
      m.muted = !this.snapshot.audio;
      if (Math.abs(m.currentTime - t) > 0.01) m.currentTime = t;
      try {
        await m.play();
      } catch {
        // the browser blocked it or the stream failed: run on our own clock instead
        this.setMedia(null);
      }
    }
    this.pos = t;
    this.startedAt = performance.now();
    this.resetSchedule(t);
    this.set({ playing: true });
    clearInterval(this.timer);
    this.timer = window.setInterval(this.tick, 40);
    this.tick();
  }

  pause() {
    if (!this.snapshot.playing) return;
    this.pos = this.now();
    this.media?.pause();
    clearInterval(this.timer);
    this.stopScheduled();
    this.set({ playing: false });
  }

  seek(t: number) {
    t = this.skipCut(Math.max(0, Math.min(this.duration, t)));
    if (this.useMedia) this.media!.currentTime = t;
    this.pos = t;
    this.startedAt = performance.now();
    this.stopScheduled();
    this.resetSchedule(t);
  }

  /** Plays one note right away (tapping a note while editing). */
  preview(midi: number, dur = 0.8) {
    this.ctx ??= new AudioContext({ latencyHint: "interactive" });
    void this.ctx.resume();
    this.synth ??= new GuitarSynth(this.ctx);
    this.synth.play(midi, this.ctx.currentTime + 0.01, dur);
  }

  dispose() {
    this.pause();
    this.listeners.clear();
    void this.ctx?.close();
  }

  private skipCut(t: number) {
    for (const [a, b] of this.cuts) if (t >= a - 0.01 && t < b) return Math.min(this.duration, b);
    return t;
  }

  private firstAfter(t: number) {
    let lo = 0, hi = this.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private resetSchedule(t: number) {
    this.scheduledTo = t;
    this.nextNote = this.firstAfter(t - 0.005);
    this.nextBeat = this.beats.findIndex((b) => b >= t - 0.005);
    if (this.nextBeat < 0) this.nextBeat = this.beats.length;
  }

  private stopScheduled() {
    const now = this.ctx?.currentTime ?? 0;
    for (const s of this.stops) if (s.until > now) s.stop();
    this.stops = [];
  }

  private tick = () => {
    const t = this.now();
    if (t >= this.duration - 0.02) {
      this.pause();
      this.pos = this.duration;
      return;
    }
    // a cut starts here: jump over it
    const cut = this.cuts.find(([a, b]) => t >= a && t < b - 0.02);
    if (cut) {
      if (cut[1] >= this.duration - 0.05) return this.pause();
      this.seek(cut[1]);
      return;
    }
    const ctx = this.ctx;
    if (!ctx || !this.synth) return;
    const rate = this.snapshot.rate;
    const horizon = t + LOOKAHEAD * rate;
    const at = (songT: number) => ctx.currentTime + Math.max(0, (songT - t) / rate);
    const inCut = (x: number) => this.cuts.some(([a, b]) => x >= a && x < b);
    if (this.snapshot.guitar) {
      while (this.nextNote < this.notes.length && this.notes[this.nextNote].t < horizon) {
        const n = this.notes[this.nextNote++];
        if (n.t < t - 0.03 || inCut(n.t)) continue;
        const when = at(n.t);
        const stop = this.synth.play(n.midi, when, (n.end - n.t) / rate, n.gain, n.soft);
        this.stops.push({ stop, until: when + (n.end - n.t) / rate + 0.2 });
      }
    } else this.nextNote = this.firstAfter(horizon);
    if (this.snapshot.click) {
      while (this.nextBeat < this.beats.length && this.beats[this.nextBeat] < horizon) {
        const i = this.nextBeat++;
        const b = this.beats[i];
        if (b < t - 0.03 || inCut(b)) continue;
        const when = at(b);
        const osc = new OscillatorNode(ctx, { frequency: (i - this.downbeat) % this.meter === 0 ? 1500 : 1000 });
        const g = new GainNode(ctx, { gain: 0 });
        g.gain.setValueAtTime(0.22, when);
        g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
        osc.connect(g).connect(ctx.destination);
        osc.start(when);
        osc.stop(when + 0.06);
        this.stops.push({ stop: () => osc.stop(), until: when + 0.06 });
      }
    } else {
      while (this.nextBeat < this.beats.length && this.beats[this.nextBeat] < horizon) this.nextBeat++;
    }
    this.scheduledTo = horizon;
    if (this.stops.length > 400) this.stops = this.stops.filter((s) => s.until > ctx.currentTime);
  };
}
