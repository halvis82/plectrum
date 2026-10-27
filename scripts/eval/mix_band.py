"""Guitar recordings with a band under them, for training and testing the note cleanup: each f32 from a
set dir (refs.py format) gets a random stretch of band backing (the non-guitar stems of BabySlakh songs
1-12, as finetune_data.py writes them) at a random guitar-over-band level.
Usage: python mix_band.py <set dir> <backing.f16 (16 kHz)> <out dir> <count> [min dB] [max dB]"""

import json
import os
import random
import shutil
import sys

import numpy as np
from scipy.signal import resample_poly

src, backing, out, count = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
lo = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
hi = float(sys.argv[6]) if len(sys.argv) > 6 else 10.0
os.makedirs(out, exist_ok=True)
rng = random.Random(0)
band = resample_poly(np.fromfile(backing, np.float16).astype(np.float32), 441, 320)  # 16 -> 22.05 kHz
files = sorted(f for f in os.listdir(src) if f.endswith(".f32"))
for f in rng.sample(files, min(count, len(files))):
    y = np.fromfile(os.path.join(src, f), np.float32)
    start = rng.randrange(0, max(1, len(band) - len(y)))
    b = band[start : start + len(y)]
    if len(b) < len(y):
        b = np.pad(b, (0, len(y) - len(b)))
    g, k = np.sqrt(np.mean(y**2)) + 1e-6, np.sqrt(np.mean(b**2)) + 1e-6
    z = y + b * (g / k) * 10 ** (-rng.uniform(lo, hi) / 20)
    z = (z / (np.abs(z).max() + 1e-9) * 0.8).astype(np.float32)
    name = f.replace(".f32", "_band")
    z.tofile(os.path.join(out, name + ".f32"))
    shutil.copy(os.path.join(src, f.replace(".f32", ".json")), os.path.join(out, name + ".json"))
print("mixed", min(count, len(files)), "into", out)
