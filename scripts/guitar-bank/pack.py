"""Render the picked notes through the body filter, extend short ones with a matching decay, tune
them, level them, and pack them into one file plus an index."""
import os, json, subprocess, numpy as np, soundfile as sf, librosa
from scipy.signal import fftconvolve
S = os.environ["S"]; HEX = f"{S}/gtr/hex"; SR = 44100
OUT = os.environ.get("OUT", f"{S}/gtr/bank")
LEN = float(os.environ.get("LEN", 3.0)); GAP = 0.25
OPEN = [40, 45, 50, 55, 59, 64]
h = np.load(f"{S}/gtr/h32768.npy"); PRE = 512
if float(os.environ.get("SMOOTH", 0)):
    # smooth the filter's magnitude over a fraction of an octave, keeping its phase
    H = np.fft.rfft(h, axis=0); f = np.fft.rfftfreq(len(h), 1 / SR); frac = float(os.environ["SMOOTH"])
    mag = np.abs(H); sm = np.empty_like(mag); cs = np.cumsum(mag ** 2, axis=0)
    for i in range(len(f)):
        lo = np.searchsorted(f, f[i] * 2 ** (-frac / 2)); hi = max(lo + 1, np.searchsorted(f, f[i] * 2 ** (frac / 2)))
        sm[i] = np.sqrt((cs[hi - 1] - (cs[lo - 1] if lo else 0)) / (hi - lo))
    h = np.fft.irfft(sm * np.exp(1j * np.angle(H)), n=len(h), axis=0)
h = np.roll(h, PRE, axis=0)[: PRE + 16384]
h[:64] *= np.linspace(0, 1, 64)[:, None]; h[-4096:] *= np.linspace(1, 0, 4096)[:, None]
picked = json.load(open(f"{S}/gtr/picked.json"))
cache = {}

def extend(y, n_out, f0):
    """continue a decaying note: its partials, each with its own measured decay"""
    if len(y) >= n_out: return y[:n_out]
    seg = y[-int(0.6 * SR):]
    w = len(seg) // 2
    a1 = np.abs(np.fft.rfft(seg[:w] * np.hanning(w))); a2 = np.abs(np.fft.rfft(seg[w:] * np.hanning(w)))
    fr = np.fft.rfftfreq(w, 1 / SR)
    tail = np.zeros(n_out - len(y) + int(0.2 * SR))
    tt = np.arange(len(tail)) / SR
    k = 1
    while k * f0 < 8000:
        band = (fr > k * f0 * 0.97) & (fr < k * f0 * 1.03)
        if band.any():
            i = np.argmax(np.where(band, a2, 0)); A2 = a2[i]; A1 = max(a1[i], 1e-9)
            rate = max(0.3, np.log(A1 / max(A2, 1e-9)) / (w / SR))  # nepers per s
            amp = A2 * 2 / np.hanning(w).sum()
            tail += amp * np.exp(-rate * tt) * np.sin(2 * np.pi * fr[i] * tt + np.random.rand() * 6.28)
        k += 1
    # crossfade the model in over the last 0.2 s
    x = int(0.2 * SR); out = np.concatenate([y, np.zeros(n_out - len(y))])
    fade = np.linspace(0, 1, x)
    # match level at the joint
    r = np.sqrt(np.mean(y[-x:] ** 2)) / max(1e-9, np.sqrt(np.mean(tail[:x] ** 2)))
    tail *= r
    out[len(y) - x:] = out[len(y) - x:] * np.concatenate([1 - fade, np.zeros(n_out - len(y))]) + tail[: n_out - len(y) + x] * np.concatenate([fade, np.ones(n_out - len(y))])
    return out

slots, chunks, at = [], [], 0.0
for p in picked:
    if p["file"] not in cache: cache[p["file"]] = sf.read(f"{HEX}/{p['file']}")[0]
    hx = cache[p["file"]]; s = p["s"]
    a = int((p["t"] - 0.03) * SR); b = int((p["t"] + min(p["L"], LEN + 0.3)) * SR)
    x = hx[a:b, s]
    f0s, vf, _ = librosa.pyin(x[int(0.05 * SR): int(0.8 * SR)], fmin=60, fmax=1400, sr=SR, frame_length=4096)
    f0 = np.nanmedian(f0s[vf]) if vf.any() else librosa.midi_to_hz(p["v"])
    midi = float(librosa.hz_to_midi(f0))
    if abs(midi - round(p["v"])) > 0.5: midi = float(p["v"])
    y = fftconvolve(x, h[:, s])[: len(x) + PRE]
    y = y[PRE:]  # back in time with the pickup
    # start just before the attack
    env = np.abs(y); on = np.argmax(env > 0.1 * env[: int(0.15 * SR)].max())
    y = y[max(0, on - int(0.004 * SR)):]
    n_out = int(LEN * SR)
    y = extend(y, n_out, f0) if len(y) < n_out else y[:n_out]
    y[: int(0.002 * SR)] *= np.linspace(0, 1, int(0.002 * SR))
    y[-int(0.15 * SR):] *= np.linspace(1, 0, int(0.15 * SR)) ** 2
    # the pick hitting the string, which the pickup doesn't hear: a short bright click
    if float(os.environ.get("PICK", 0)):
        k = int(0.012 * SR); nz = np.random.default_rng(len(slots)).standard_normal(k) * np.exp(-np.arange(k) / (0.002 * SR))
        nz = np.diff(np.concatenate([[0], nz]))
        y[:k] += float(os.environ["PICK"]) * np.abs(y[: int(0.05 * SR)]).max() * nz / np.abs(nz).max()
    # level: the first 0.3 s at a common loudness
    y *= 0.12 / np.sqrt(np.mean(y[: int(0.3 * SR)] ** 2))
    slots.append(dict(string=s, midi=round(midi, 3), at=round(at, 4), len=LEN, fret=round(p["v"]) - OPEN[s]))
    chunks += [y, np.zeros(int(GAP * SR))]; at += LEN + GAP
def eq(y):
    """the corrective EQ (eqfit.py), zero phase"""
    e = json.load(open(os.environ["EQ"])); n = 1 << int(np.ceil(np.log2(len(y) + 8192)))
    f = np.fft.rfftfreq(n, 1 / SR); g = 10 ** (np.interp(np.log(np.maximum(f, 20)), np.log(e["bands"]), e["db"]) / 20)
    pad = 4096; z = np.fft.irfft(np.fft.rfft(np.pad(y, (pad, n - len(y) - pad))) * g, n)
    return z[pad: pad + len(y)]
if os.environ.get("EQ"): chunks = [eq(c) if c.any() else c for c in chunks]
pcm = np.concatenate(chunks); pk = np.abs(pcm).max()
print("peak", pk, "duration", len(pcm) / SR)
pcm *= 0.95 / pk
os.makedirs(OUT, exist_ok=True)
sf.write(f"{OUT}/bank.wav", pcm.astype(np.float32), SR)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{OUT}/bank.wav", "-ac", "1", "-c:a", "libmp3lame", "-b:a", os.environ.get("KBPS", "96k"), f"{OUT}/bank.mp3"], check=True)
json.dump(dict(source="GuitarSet (Xi et al. 2018), CC BY 4.0: per-string pickup notes through a body and microphone filter fit to its mic recordings", slots=slots), open(f"{OUT}/bank.json", "w"))
print("slots", len(slots), "mp3 KB", os.path.getsize(f"{OUT}/bank.mp3") // 1024)
