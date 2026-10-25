// Real-input FFT built on an in-place radix-2 complex FFT of half the size.
// Output matches numpy.fft.rfft: X[k] = sum x[n] e^{-2πikn/N}, k = 0..N/2.

export class RealFFT {
  readonly n: number;
  private half: number;
  private rev: Uint32Array;
  private cosT: Float64Array;
  private sinT: Float64Array;
  private postCos: Float64Array;
  private postSin: Float64Array;
  private zr: Float64Array;
  private zi: Float64Array;

  constructor(n: number) {
    if (n & (n - 1)) throw new Error("FFT size must be a power of two");
    this.n = n;
    const h = (this.half = n >> 1);
    const bits = Math.log2(h);
    this.rev = new Uint32Array(h);
    for (let i = 0; i < h; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cosT = new Float64Array(h >> 1);
    this.sinT = new Float64Array(h >> 1);
    for (let i = 0; i < h >> 1; i++) {
      this.cosT[i] = Math.cos((-2 * Math.PI * i) / h);
      this.sinT[i] = Math.sin((-2 * Math.PI * i) / h);
    }
    this.postCos = new Float64Array(h + 1);
    this.postSin = new Float64Array(h + 1);
    for (let k = 0; k <= h; k++) {
      this.postCos[k] = Math.cos((-2 * Math.PI * k) / n);
      this.postSin[k] = Math.sin((-2 * Math.PI * k) / n);
    }
    this.zr = new Float64Array(h);
    this.zi = new Float64Array(h);
  }

  /** Writes n/2+1 complex bins into outRe/outIm. `input` may be shorter than n (zero padded). */
  forward(input: ArrayLike<number>, offset: number, outRe: Float64Array, outIm: Float64Array) {
    const { half: h, rev, zr, zi } = this;
    const len = input.length;
    for (let i = 0; i < h; i++) {
      const a = offset + 2 * i;
      const j = rev[i];
      zr[j] = a >= 0 && a < len ? input[a] : 0;
      zi[j] = a + 1 >= 0 && a + 1 < len ? input[a + 1] : 0;
    }
    for (let size = 2; size <= h; size <<= 1) {
      const halfSize = size >> 1;
      const step = h / size;
      for (let start = 0; start < h; start += size) {
        for (let k = 0, t = 0; k < halfSize; k++, t += step) {
          const c = this.cosT[t], s = this.sinT[t];
          const i1 = start + k, i2 = i1 + halfSize;
          const tr = zr[i2] * c - zi[i2] * s;
          const ti = zr[i2] * s + zi[i2] * c;
          zr[i2] = zr[i1] - tr;
          zi[i2] = zi[i1] - ti;
          zr[i1] += tr;
          zi[i1] += ti;
        }
      }
    }
    for (let k = 0; k <= h; k++) {
      const a = k % h, b = (h - k) % h;
      const ar = zr[a], ai = zi[a], br = zr[b], bi = -zi[b];
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
      // (Z[k] - conj(Z[h-k])) / 2i
      const orr = 0.5 * (ai - bi), oi = -0.5 * (ar - br);
      const c = this.postCos[k], s = this.postSin[k];
      outRe[k] = er + orr * c - oi * s;
      outIm[k] = ei + orr * s + oi * c;
    }
  }
}
