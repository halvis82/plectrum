"""Builds the string-classification dataset from GuitarSet mic audio (.f32, 22.05 kHz) and JAMS
annotations: one patch per annotated note, with jittered onsets for robustness to detection error.
Usage: python build.py <f32-dir> <jams-dir> <out.npz> [jitter-copies]"""

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from features import patch  # noqa: E402

TUNING = [40, 45, 50, 55, 59, 64]
f32, jams, out = sys.argv[1:4]
copies = int(sys.argv[4]) if len(sys.argv) > 4 else 1
rng = np.random.default_rng(0)
X, S, M, P, K, F = [], [], [], [], [], []
files = sorted(f for f in os.listdir(f32) if f.endswith(".f32"))
for i, name in enumerate(files):
    y = np.fromfile(os.path.join(f32, name), np.float32)
    base = name.replace("_mic.f32", "")
    j = json.load(open(os.path.join(jams, base + ".jams")))
    cache = {}
    for a in j["annotations"]:
        if a["namespace"] != "note_midi":
            continue
        s = int(a["annotation_metadata"]["data_source"])
        for d in a["data"]:
            m = int(round(d["value"]))
            for c in range(copies):
                t = d["time"] + (rng.uniform(-0.025, 0.025) if c else 0.0)
                X.append(patch(y, t, m, cache).astype(np.float16))
                S.append(s)
                M.append(m)
                P.append(int(base[:2]))
                K.append(0 if "comp" in base else 1)
                F.append(i)
    print(i, base, len(S), flush=True) if i % 30 == 0 else None
np.savez_compressed(out, X=np.stack(X), s=np.array(S, np.int8), midi=np.array(M, np.int8), player=np.array(P, np.int8), solo=np.array(K, np.int8), fid=np.array(F, np.int16))
print("notes", len(S))
