"""String-classification patches from EGDB (electric guitar: a DI track plus five amp renderings per clip,
labels as one MIDI track per string, "1" = high e). Same layout as build.py; `player` holds the clip
number and `solo` the rendering index.
Usage: python build_egdb.py <egdb-dir> <out.npz> [renderings, default all]"""

import os
import sys

import librosa
import numpy as np
import pretty_midi

sys.path.insert(0, os.path.dirname(__file__))
from features import SR, patch  # noqa: E402

TUNING = [40, 45, 50, 55, 59, 64]
root, out = sys.argv[1:3]
tones = sys.argv[3].split(",") if len(sys.argv) > 3 else ["DI", "Marshall", "Plexi", "JCjazz", "Mesa", "Ftwin"]
rng = np.random.default_rng(0)
X, S, M, P, K, F = [], [], [], [], [], []
labels = sorted(os.listdir(os.path.join(root, "audio_label")), key=lambda f: int(f.split(".")[0]))
skipped = 0
for lf in labels:
    clip = int(lf.split(".")[0])
    pm = pretty_midi.PrettyMIDI(os.path.join(root, "audio_label", lf))
    notes = []
    for k, inst in enumerate(pm.instruments):
        name = inst.name.strip()
        num = int(name) if name.isdigit() else k + 1
        s = 6 - num  # 0 = low E
        for n in inst.notes:
            notes.append((n.start, n.pitch, s))
    # a label whose notes don't fit their string (sharp or unnamed tracks out of order) is unusable
    if any(not (0 <= m - TUNING[s] <= 24) for _, m, s in notes):
        skipped += 1
        continue
    for ti, tone in enumerate(tones):
        wav = os.path.join(root, f"audio_{tone}", f"{clip}.wav")
        if not os.path.exists(wav):
            continue
        y, _ = librosa.load(wav, sr=SR, mono=True)
        cache = {}
        for t, m, s in notes:
            for c in range(2):
                tt = t + (rng.uniform(-0.025, 0.025) if c else 0.0)
                X.append(patch(y, tt, m, cache).astype(np.float16))
                S.append(s)
                M.append(m)
                P.append(clip)
                K.append(ti)
                F.append(clip)
    print(clip, len(S), flush=True) if clip % 20 == 0 else None
np.savez_compressed(out, X=np.stack(X), s=np.array(S, np.int8), midi=np.array(M, np.int8), player=np.array(P, np.int16), solo=np.array(K, np.int8), fid=np.array(F, np.int16))
print("notes", len(S), "skipped labels", skipped)
