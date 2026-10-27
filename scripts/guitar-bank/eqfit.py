import json, os, sys, numpy as np, soundfile as sf, librosa
S = os.environ["S"]; name = sys.argv[1]
files = json.load(open(f"{S}/gtr/eval/train_files.json"))
bands = 50 * 2 ** (np.arange(0, 28) / 3)
def ltas(p):
    y, sr = sf.read(p); y = y if y.ndim == 1 else y.mean(1)
    P = (np.abs(librosa.stft(y, n_fft=4096, hop_length=1024)) ** 2).mean(1); f = librosa.fft_frequencies(sr=sr, n_fft=4096)
    db = 10 * np.log10(np.array([P[(f >= b / 2 ** (1 / 6)) & (f < b * 2 ** (1 / 6))].sum() for b in bands]) + 1e-12); return db - db.mean()
d = np.mean([ltas(f) - ltas(f"{S}/gtr/eval/{name}/{os.path.basename(f).replace('_mic.wav','')}.wav") for f in files], 0)
d = np.convolve(np.pad(d, 1, mode="edge"), [0.25, 0.5, 0.25], "valid")  # smooth
d -= d[(bands > 400) & (bands < 2000)].mean()
d = np.clip(d, -12, 12)
json.dump(dict(bands=bands.tolist(), db=d.round(2).tolist()), open(f"{S}/gtr/eq.json", "w"))
print(" ".join(f"{int(b)}:{x:+.1f}" for b, x in zip(bands, d)))
