"""Builds string-classification data from evaluation sets made by scripts/eval/refs.py (<name>.f32 +
<name>.json with [start, end, midi, string]). Same layout as build.py: three copies per note, the
first at the annotated onset, two jittered. `player` is the given id for every note.
Usage: python build_refs.py <set dir> <out.npz> <player id> [name filter]"""

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from features import patch  # noqa: E402

src, out, player = sys.argv[1], sys.argv[2], int(sys.argv[3])
only = sys.argv[4] if len(sys.argv) > 4 else ""
COPIES = 3
rng = np.random.default_rng(0)
X, S, M, F = [], [], [], []
files = sorted(f for f in os.listdir(src) if f.endswith(".f32") and only in f)
for i, f in enumerate(files):
    y = np.fromfile(os.path.join(src, f), np.float32)
    cache = {}
    for start, _, m, s in json.load(open(os.path.join(src, f[:-4] + ".json"))):
        if s < 0 or not 40 <= m <= 88:
            continue
        for c in range(COPIES):
            t = start + (rng.uniform(-0.025, 0.025) if c else 0.0)
            X.append(patch(y, t, int(m), cache).astype(np.float16))
            S.append(s)
            M.append(m)
            F.append(i)
    print(f, len(S), flush=True)
n = len(S)
np.savez_compressed(out, X=np.stack(X), s=np.array(S, np.int8), midi=np.array(M, np.int8), player=np.full(n, player, np.int16), solo=np.zeros(n, np.int8), fid=np.array(F, np.int16))
print("notes", n // COPIES)
