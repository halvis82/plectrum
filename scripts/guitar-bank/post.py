import os, sys, json, glob, numpy as np, soundfile as sf
from scipy.signal import fftconvolve, butter, sosfilt
S = os.environ["S"]; src, dst, rt60, wet = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
SR = 44100; rng = np.random.default_rng(0)
n = int(rt60 * 1.5 * SR); t = np.arange(n) / SR
ir = np.zeros((n, 2))
for c in range(2):
    noise = rng.standard_normal(n)
    # darker as it decays: two bands with different decay
    lo = sosfilt(butter(2, 3000, "low", fs=SR, output="sos"), noise); hi = noise - lo
    ir[:, c] = lo * np.exp(-6.9 * t / rt60) + hi * np.exp(-6.9 * t / (rt60 * 0.5))
ir[: int(0.008 * SR)] = 0  # predelay
ir /= np.sqrt((ir ** 2).sum(0))
os.makedirs(f"{S}/gtr/eval/{dst}", exist_ok=True)
for f in glob.glob(f"{S}/gtr/eval/{src}/*.wav"):
    y, _ = sf.read(f)
    r = fftconvolve(y, ir[:, 0])[: len(y)]
    out = y + wet * r
    sf.write(f"{S}/gtr/eval/{dst}/{os.path.basename(f)}", (out / np.abs(out).max() * 0.9).astype(np.float32), SR)
