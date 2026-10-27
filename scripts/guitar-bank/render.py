"""Render GuitarSet note annotations with candidate guitar sounds."""
import glob, json, os, re, sys
import numpy as np, soundfile as sf, jams
from scipy.signal import lfilter, resample_poly
import librosa

SR = 44100
S = os.environ["S"]
NOTE = {"C":0,"Db":1,"D":2,"Eb":3,"E":4,"F":5,"Gb":6,"G":7,"Ab":8,"A":9,"Bb":10,"B":11}
TJ = {"C":0,"Cs":1,"D":2,"Ds":3,"E":4,"F":5,"Fs":6,"G":7,"Gs":8,"A":9,"As":10,"B":11}
FP = {"C":0,"C#":1,"D":2,"D#":3,"E":4,"F":5,"F#":6,"G":7,"G#":8,"A":9,"A#":10,"B":11}

def load_set(folder, names):
    out = {}
    for f in glob.glob(folder + "/*"):
        m = re.match(r"([A-G][a-z#]?)(-?\d)\.", os.path.basename(f))
        if not m or m.group(1) not in names: continue
        midi = 12 * (int(m.group(2)) + 1) + names[m.group(1)]
        y, sr = librosa.load(f, sr=SR, mono=True)
        out[midi] = y
    return out

def notes_of(jam_path):
    jam = jams.load(jam_path)
    notes = []
    for s, ann in enumerate(jam.search(namespace="note_midi")):
        for o in ann.data:
            notes.append((o.time, o.duration, round(o.value), s))
    return sorted(notes)

def sampler(samples, notes, n, gain=0.6, release=0.09):
    y = np.zeros(n)
    keys = np.array(sorted(samples))
    for t, d, midi, s in notes:
        k = keys[np.argmin(np.abs(keys - midi))]
        x = samples[k]
        if k != midi:
            ratio = 2 ** ((midi - k) / 12)
            x = librosa.resample(x, orig_sr=SR * ratio, target_sr=SR, res_type="soxr_hq")
        L = min(len(x), int((d + release * 6) * SR))
        x = x[:L].copy()
        e = np.ones(L)
        i0 = int(d * SR)
        if i0 < L: e[i0:] = np.exp(-(np.arange(L - i0) / SR) / (release / 6.9))
        a = int(t * SR)
        seg = x * e * gain
        y[a:a + L] += seg[: max(0, n - a)]
    return y

# the current Karplus-Strong synth (src/lib/synth.ts), ported
RING = 3.2
def pluck(midi, sr, soft=False):
    f = 440 * 2 ** ((midi - 69) / 12); ln = int(sr * RING); y = np.zeros(ln)
    period = sr / f - 0.5; p0 = int(np.floor(period))
    t60 = max(1.2, min(5, 4.2 * np.sqrt(110 / f))); rho = 10 ** (-3 / (f * t60))
    exc = np.zeros(p0 + 2); lp = 0; smooth = 0.25 if soft else 0.6; seed = midi * 9301 + 49297
    for i in range(len(exc)):
        seed = (seed * 9301 + 49297) % 233280; r = seed / 233280 - 0.5; lp += smooth * (r - lp); exc[i] = lp
    pick = max(1, round(p0 * 0.18))
    for i in range(len(exc) - 1, pick - 1, -1): exc[i] -= exc[i - pick]
    frac = period - p0
    for n_ in range(ln):
        a = n_ - p0; b = a - 1; c = a - 2
        d1 = ((1 - frac) * y[a] + (frac * y[b] if b >= 0 else 0)) if a >= 0 else 0
        d2 = ((1 - frac) * y[b] + (frac * y[c] if c >= 0 else 0)) if b >= 0 else 0
        y[n_] = (exc[n_] if n_ < len(exc) else 0) + rho * 0.5 * (d1 + d2)
    y *= 0.5 / max(1e-9, np.abs(y).max())
    y *= np.minimum(1, np.arange(ln) / 24)
    return y

def biquad(kind, f0, Q=0.707, gain=0):
    A = 10 ** (gain / 40); w = 2 * np.pi * f0 / SR; al = np.sin(w) / (2 * Q); c = np.cos(w)
    if kind == "hp": b = [(1 + c) / 2, -(1 + c), (1 + c) / 2]; a = [1 + al, -2 * c, 1 - al]
    else: b = [1 + al * A, -2 * c, 1 - al * A]; a = [1 + al / A, -2 * c, 1 - al / A]
    return np.array(b) / a[0], np.array(a) / a[0]

_ks = {}
def ks_render(notes, n):
    samples = {}
    for _, _, m, _ in notes:
        if m not in _ks: _ks[m] = pluck(m, SR)
        samples[m] = _ks[m]
    y = sampler(samples, notes, n, gain=0.8)
    for spec in [("hp", 70), ("pk", 110, 1.2, 5), ("pk", 230, 1.4, 3), ("pk", 2800, 0.8, 2)]:
        b, a = biquad(*spec); y = lfilter(b, a, y)
    return y

if __name__ == "__main__":
    sets = {
        "musyng_steel": (f"{S}/gtr/dl/MusyngKite.acoustic_guitar_steel", NOTE),
        "fluid_steel": (f"{S}/gtr/dl/FluidR3_GM.acoustic_guitar_steel", NOTE),
        "fatboy_steel": (f"{S}/gtr/dl/FatBoy.acoustic_guitar_steel", NOTE),
        "musyng_nylon": (f"{S}/gtr/dl/MusyngKite.acoustic_guitar_nylon", NOTE),
        "tonejs": (f"{S}/gtr/dl/tonejs", TJ),
        "freepats_nylon": (f"{S}/gtr/dl/fp/SpanishClassicalGuitar-SFZ-20190618/samples", FP),
    }
    extra = json.loads(os.environ.get("EXTRA", "{}"))
    for k, v in extra.items(): sets[k] = (v, NOTE)
    only = sys.argv[1].split(",") if len(sys.argv) > 1 else None
    files = json.load(open(f"{S}/gtr/eval/files.json"))
    for name in (only or ["ks"] + list(sets)):
        samp = None if name == "ks" else load_set(*sets[name])
        os.makedirs(f"{S}/gtr/eval/{name}", exist_ok=True)
        for f in files:
            base = os.path.basename(f).replace("_mic.wav", "")
            ref, _ = sf.read(f)
            notes = notes_of(f"{S}/guitarset/data/ann/{base}.jams")
            y = ks_render(notes, len(ref)) if name == "ks" else sampler(samp, notes, len(ref))
            sf.write(f"{S}/gtr/eval/{name}/{base}.wav", (y / max(1e-9, np.abs(y).max()) * 0.9).astype(np.float32), SR)
        print(name, "done", flush=True)
