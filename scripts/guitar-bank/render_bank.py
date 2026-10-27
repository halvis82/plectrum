import os, sys, json, numpy as np, soundfile as sf, librosa
sys.path.insert(0, os.path.dirname(__file__))
from render import notes_of, SR
S = os.environ["S"]; B = sys.argv[1]; name = sys.argv[2]; PICK = float(os.environ.get("PICK", 0))
meta = json.load(open(f"{B}/bank.json")); pcm, _ = librosa.load(f"{B}/bank.mp3", sr=SR)
slots = [[x for x in meta["slots"] if x["string"] == s] for s in range(6)]
def sample(sl):
    a = int(sl["at"] * SR); return pcm[a: a + int(sl["len"] * SR)]
os.makedirs(f"{S}/gtr/eval/{name}", exist_ok=True)
for f in json.load(open(f"{S}/gtr/eval/" + os.environ.get("FILES", "files.json"))):
    base = os.path.basename(f).replace("_mic.wav", ""); ref, _ = sf.read(f)
    y = np.zeros(len(ref))
    for t, d, midi, s in notes_of(f"{S}/guitarset/data/ann/{base}.jams"):
        sl = min(slots[s], key=lambda x: abs(x["midi"] - midi)); x = sample(sl)
        r = 2 ** ((midi - sl["midi"]) / 12)
        if abs(r - 1) > 1e-4: x = librosa.resample(x, orig_sr=SR * r, target_sr=SR, res_type="soxr_hq")
        L = min(len(x), int((d + 0.3) * SR)); e = np.ones(L); i0 = int(d * SR)
        if i0 < L: e[i0:] = np.exp(-(np.arange(L - i0) / SR) / 0.013)
        seg = x[:L] * e * 0.6
        if PICK:
            k = int(0.012 * SR); nz = np.random.default_rng(int(t * 1000)).standard_normal(k) * np.exp(-np.arange(k) / (0.002 * SR))
            nz = np.diff(np.concatenate([[0], nz]))  # brighter
            seg[:k] += PICK * np.abs(seg[: int(0.05 * SR)]).max() * nz / np.abs(nz).max()
        a = int(t * SR); seg = seg[: max(0, len(y) - a)]; y[a:a + len(seg)] += seg
    sf.write(f"{S}/gtr/eval/{name}/{base}.wav", (y / max(1e-9, np.abs(y).max()) * 0.9).astype(np.float32), SR)
print("done", name)
