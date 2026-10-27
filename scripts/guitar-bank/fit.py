"""Learn how the guitar body, room and microphone color each string: a 6-in/1-out linear filter from
GuitarSet's per-string pickup signals to its mic recording, fit per frequency by least squares."""
import glob, os, sys, numpy as np, soundfile as sf, librosa
S = os.environ["S"]; HEX = f"{S}/gtr/hex"
N = int(os.environ.get("NFFT", 32768)); HOP = N // 4
done = {l.split()[1] for l in open(f"{HEX}/fetch.log") if l.split()[1:2] and l.split()[1] != "None"}
files = sorted(f"{HEX}/{n}" for n in done)
rng = np.random.default_rng(0); rng.shuffle(files)
test, train = files[:8], files[8:]
def stft(x): return librosa.stft(x, n_fft=N, hop_length=HOP, window="hann", center=True)
F = N // 2 + 1
Rxx = np.zeros((F, 6, 6), complex); rxy = np.zeros((F, 6), complex)
for f in train:
    hx, sr = sf.read(f); mic, _ = sf.read(f"{S}/guitarset/data/audio/{os.path.basename(f).replace('_hex_cln', '_mic')}")
    n = min(len(hx), len(mic)); X = np.stack([stft(hx[:n, s]) for s in range(6)], 1)  # F,6,T
    Y = stft(mic[:n])
    Rxx += np.einsum("fst,fut->fsu", X, X.conj()); rxy += np.einsum("fst,ft->fs", X, Y.conj())
lam = 1e-3 * np.trace(Rxx, axis1=1, axis2=2).real[:, None, None] / 6 + 1e-9
H = np.linalg.solve(Rxx + lam * np.eye(6), rxy).conj()  # F,6 : Y ~ sum_s H_s X_s
h = np.fft.irfft(H, n=N, axis=0)  # N,6 (circular; causal part first)
np.save(f"{S}/gtr/H{N}.npy", H); np.save(f"{S}/gtr/h{N}.npy", h)
print("train", len(train), "test", len(test))
# energy of h by time: how much is acausal (wrapped at the end)?
e = (h ** 2).sum(1); print("energy first 2048:", e[:2048].sum() / e.sum(), "last 1024 (acausal):", e[-1024:].sum() / e.sum())
os.makedirs(f"{S}/gtr/pred", exist_ok=True)
for f in test:
    hx, sr = sf.read(f); mic, _ = sf.read(f"{S}/guitarset/data/audio/{os.path.basename(f).replace('_hex_cln', '_mic')}")
    n = min(len(hx), len(mic)); X = np.stack([stft(hx[:n, s]) for s in range(6)], 1)
    Yp = (H[:, :, None] * X).sum(1); yp = librosa.istft(Yp, hop_length=HOP, window="hann", length=n)
    Ym = np.abs(stft(mic[:n])); err = np.linalg.norm(np.abs(Yp) - Ym) / np.linalg.norm(Ym)
    print(os.path.basename(f), "spectral error", round(err, 3), "snr dB", round(10 * np.log10(np.sum(mic[:n] ** 2) / np.sum((mic[:n] - yp) ** 2)), 2))
    sf.write(f"{S}/gtr/pred/{os.path.basename(f).replace('_hex_cln', '')}", (yp / np.abs(yp).max() * 0.9).astype(np.float32), sr)
