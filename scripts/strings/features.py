"""Pitch-aligned spectral patches for string classification. Mirrored exactly by src/lib/analysis/strings.ts.

For a note with MIDI pitch m starting at time t: Hann-windowed 4096-point FFTs (22.05 kHz) at
NF frames starting at t + OFF hops (hop 256), magnitudes in dB, sampled by linear interpolation on a
log-frequency grid from m - 1 to m + 49 semitones in steps of 1/RES semitone. The fundamental sits at
row RES, harmonic h at RES * (1 + 12 log2 h)."""

import numpy as np

SR = 22050
N_FFT = 4096
HOP = 256
RES = 4  # bins per semitone
LO, HI = -1, 49  # semitones relative to the note
NB = (HI - LO) * RES  # 200 rows
NF = 12  # frames (~140 ms)
OFF = -1  # first frame, in hops relative to the onset

WIN = np.hanning(N_FFT + 1)[:-1].astype(np.float32)  # periodic Hann, same as the TS port


def grid(midi):
    """Fractional FFT bin for each row."""
    semis = midi + LO + np.arange(NB) / RES
    hz = 440.0 * 2 ** ((semis - 69) / 12)
    return hz * N_FFT / SR


def patch(y, t, midi, spec_cache=None):
    start = int(round(t * SR / HOP)) + OFF
    bins = grid(midi)
    lo = np.floor(bins).astype(int)
    frac = (bins - lo).astype(np.float32)
    ok = lo + 1 < N_FFT // 2
    lo = np.where(ok, lo, 0)
    out = np.full((NF, NB), -100.0, np.float32)
    for k in range(NF):
        f = start + k
        if spec_cache is not None and f in spec_cache:
            mag = spec_cache[f]
        else:
            c = f * HOP  # frame starts at c - N_FFT/2 (centered)
            seg = np.zeros(N_FFT, np.float32)
            a, b = c - N_FFT // 2, c + N_FFT // 2
            sa, sb = max(a, 0), min(b, len(y))
            if sb > sa:
                seg[sa - a : sb - a] = y[sa:sb]
            mag = np.abs(np.fft.rfft(seg * WIN)).astype(np.float32)
            mag = 20 * np.log10(mag + 1e-6)
            if spec_cache is not None:
                spec_cache[f] = mag
        v = mag[lo] * (1 - frac) + mag[lo + 1] * frac
        out[k] = np.where(ok, v, -100.0)
    # level-independent: relative to the patch maximum, floored at -80 dB
    out = np.maximum(out - out.max(), -80.0) / 80.0 + 1.0
    return out
