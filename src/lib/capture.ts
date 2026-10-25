"use client";
// Raw PCM capture from a MediaStream (mic or tab) with sample-accurate timing.

export class PcmCapture {
  private blocks: Float32Array[] = [];
  private length = 0;
  private firstFrame = -1;
  private lastRms = 0;
  /** seconds of recording (from the start) at which non-silent audio was last/first heard */
  lastSound = -1;
  firstSound = -1;

  private constructor(
    private ctx: AudioContext,
    private stream: MediaStream,
    private node: AudioWorkletNode,
  ) {
    node.port.onmessage = (e: MessageEvent<{ pcm: Float32Array; frame: number }>) => {
      const { pcm, frame } = e.data;
      if (this.firstFrame < 0) this.firstFrame = frame;
      this.blocks.push(pcm);
      this.length += pcm.length;
      let s = 0;
      for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
      this.lastRms = Math.sqrt(s / pcm.length);
      if (this.lastRms > SILENCE) {
        const t = this.length / this.sampleRate;
        this.lastSound = t;
        if (this.firstSound < 0) this.firstSound = t;
      }
    };
  }

  static async start(stream: MediaStream): Promise<PcmCapture> {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule("/pcm-worklet.js");
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const node = new AudioWorkletNode(ctx, "pcm-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: "explicit" });
    // the tap has to be pulled by the graph; route it to the speakers at zero gain
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(ctx.destination);
    if (ctx.state === "suspended") await ctx.resume();
    return new PcmCapture(ctx, stream, node);
  }

  get sampleRate() {
    return this.ctx.sampleRate;
  }

  /** Current position in the recording, in seconds (sample clock, not wall clock). */
  now(): number {
    if (this.firstFrame < 0) return 0;
    const ts = this.ctx.getOutputTimestamp();
    const ctxTime = (ts.contextTime ?? this.ctx.currentTime) + (performance.now() - (ts.performanceTime ?? performance.now())) / 1000;
    return Math.max(0, ctxTime - this.firstFrame / this.sampleRate);
  }

  /** Recorded seconds so far. */
  get seconds() {
    return this.length / this.sampleRate;
  }

  level() {
    return Math.min(1, this.lastRms * 5);
  }

  /** The last `secs` seconds (or everything) as one buffer at the capture rate. */
  tail(secs = Infinity): { pcm: Float32Array; start: number } {
    const want = Math.min(this.length, Math.round(secs * this.sampleRate));
    const out = new Float32Array(want);
    let pos = want, i = this.blocks.length - 1;
    while (pos > 0 && i >= 0) {
      const b = this.blocks[i--];
      const take = Math.min(b.length, pos);
      out.set(b.subarray(b.length - take), pos - take);
      pos -= take;
    }
    return { pcm: out, start: (this.length - want) / this.sampleRate };
  }

  stop(): Float32Array {
    this.node.port.onmessage = null;
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close();
    return this.tail().pcm;
  }
}

/** Below this RMS the capture counts as silence (digital silence from a tab is ~0). */
export const SILENCE = 0.004;

/** Resample mono PCM to `to` Hz with the browser's resampler. */
export async function resample(pcm: Float32Array, from: number, to: number): Promise<Float32Array> {
  if (from === to || pcm.length === 0) return pcm;
  const len = Math.max(1, Math.round((pcm.length * to) / from));
  const off = new OfflineAudioContext(1, len, to);
  const buf = off.createBuffer(1, pcm.length, from);
  buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0).slice();
}

/** 16-bit mono WAV, for keeping a recording on this device for playback. */
export function encodeWav(pcm: Float32Array, sr: number): Blob {
  const data = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  data.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVEfmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, sr, true);
  data.setUint32(28, sr * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  str(36, "data");
  data.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([data.buffer], { type: "audio/wav" });
}
