"""Build the guitar note bank from GuitarSet: each string's own pickup signal, colored by the learned
body+room+mic filter for that string. One note per string and fret (0-15 when available)."""
import glob, os, json, collections, numpy as np, soundfile as sf, jams, librosa
from scipy.signal import fftconvolve
S = os.environ["S"]; HEX = f"{S}/gtr/hex"; SR = 44100
OPEN = [40, 45, 50, 55, 59, 64]
LEN = float(os.environ.get("LEN", 3.0))
h = np.load(f"{S}/gtr/h32768.npy")  # N,6 circular
PRE = 512
h = np.roll(h, PRE, axis=0)[: PRE + 16384]
h[:64] *= np.linspace(0, 1, 64)[:, None]; h[-4096:] *= np.linspace(1, 0, 4096)[:, None]
done = sorted({l.split()[1] for l in open(f"{HEX}/fetch.log") if len(l.split()) > 2 and l.split()[1] != "None"})
cands = collections.defaultdict(list)
for name in done:
    base = name.replace("_hex_cln.wav", "")
    jam = jams.load(f"{S}/guitarset/data/ann/{base}.jams")
    hx, sr = sf.read(f"{HEX}/{name}"); assert sr == SR
    for s, ann in enumerate(jam.search(namespace="note_midi")):
        ns = sorted((o.time, o.duration, o.value) for o in ann.data)
        for i, (t, d, v) in enumerate(ns):
            nxt = ns[i + 1][0] if i + 1 < len(ns) else len(hx) / SR
            L = min(nxt - t, LEN + 0.3)
            if L < 1.0: continue
            a = int((t - 0.03) * SR); b = int((t + L) * SR)
            if a < 0 or b > len(hx): continue
            x = hx[a:b, s]
            env = librosa.feature.rms(y=x, frame_length=2048, hop_length=512)[0]
            pk = env.max() + 1e-9; ip = env.argmax()
            if ip * 512 / SR > 0.12: continue  # attack should be at the start
            # still ringing at 1 s and no sudden drop (damped by hand)
            db = 20 * np.log10(env / pk + 1e-9)
            at1 = db[min(len(db) - 1, int(1.0 * SR / 512))]
            drops = np.min(np.diff(db[ip:]) if len(db) > ip + 2 else [0])
            cands[(s, round(v) - OPEN[s])].append(dict(file=name, s=s, t=t, L=L, v=float(v), peak=float(pk), at1=float(at1), drop=float(drops)))
print("positions with candidates:", len(cands))
from scipy.signal import fftconvolve
hexes = {}
def purity(c):
    """share of the note's energy (after the body filter) on its own harmonics, 0.05-1.2 s"""
    if c["file"] not in hexes: hexes[c["file"]] = sf.read(f"{HEX}/{c['file']}")[0]
    x = hexes[c["file"]][int((c["t"] - 0.03) * SR): int((c["t"] + 1.3) * SR), c["s"]]
    y = fftconvolve(x, h[:, c["s"]])[PRE: PRE + len(x)][int(0.08 * SR): int(1.23 * SR)]
    X = np.abs(np.fft.rfft(y * np.hanning(len(y)))) ** 2; fr = np.fft.rfftfreq(len(y), 1 / SR)
    f0 = librosa.midi_to_hz(c["v"]); band = (fr > 40) & (fr < 8000)
    on = np.zeros_like(fr, bool)
    for k in range(1, int(8000 / f0) + 1): on |= np.abs(fr - k * f0) < max(4, 0.02 * k * f0)
    return float(X[on & band].sum() / X[band].sum())
picked = []
for (s, f), cs in sorted(cands.items()):
    if f < 0 or f > 15: continue
    good = [c for c in cs if c["drop"] > -6]
    if not good: continue
    good.sort(key=lambda c: (-min(c["L"], LEN), -c["at1"]))
    for c in good[:25]: c["purity"] = purity(c)
    good = [c for c in good[:25] if c["purity"] > 0.9] or sorted(good[:25], key=lambda c: -c["purity"])[:1]
    # the longest ring among the clean ones
    picked.append(good[0])
print("purity", np.percentile([p["purity"] for p in picked], [0, 10, 50]))
print("picked", len(picked))
for s in range(6): print(s, sorted(p["v"] - OPEN[s] for p in picked if p["s"] == s).__len__(), [round(p["L"], 1) for p in picked if p["s"] == s])
json.dump(picked, open(f"{S}/gtr/picked.json", "w"))
