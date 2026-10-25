// Forwards mono PCM blocks from the capture graph to the main thread.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      const len = ch[0].length;
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < ch.length; c++) s += ch[c][i];
        this.buf[this.n++] = s / ch.length;
        if (this.n === this.buf.length) {
          this.port.postMessage({ pcm: this.buf, frame: currentFrame + i + 1 - this.n }, [this.buf.buffer]);
          this.buf = new Float32Array(4096);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
