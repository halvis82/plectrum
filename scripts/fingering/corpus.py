"""Builds a fingering corpus from SynthTab's JAMS tabs (DadaGP Guitar Pro files): for every standard-tuned
six-string guitar part, its notes in time order (ties by pitch) with pitch, onset (s), duration (s) and
the string the tab puts them on (0 = low E).
Usage: python corpus.py <dir with */*.jams> <out.npz> [workers]"""

import glob
import json
import os
import sys
from multiprocessing import Pool

import numpy as np

STANDARD = [40, 45, 50, 55, 59, 64]
TPQ = 960  # Guitar Pro ticks per quarter note


def seconds(tempos):
    """tick -> seconds through the tempo map [(tick, bpm)]."""
    tempos = sorted(tempos) or [(0.0, 120.0)]
    starts, acc = [], 0.0
    for i, (t, bpm) in enumerate(tempos):
        if i:
            pt, pb = tempos[i - 1]
            acc += (t - pt) / TPQ * 60 / pb
        starts.append(acc)

    def f(tick):
        i = max(0, np.searchsorted([t for t, _ in tempos], tick, side="right") - 1)
        return starts[i] + (tick - tempos[i][0]) / TPQ * 60 / tempos[i][1]

    return f


def track(path):
    try:
        name = os.path.basename(os.path.dirname(path))
        if "bass" in name.lower():
            return None
        j = json.load(open(path))
        strings = [a for a in j["annotations"] if a["namespace"] == "note_tab"]
        if len(strings) != 6:
            return None
        tuning = {a["sandbox"]["string_index"]: a["sandbox"]["open_tuning"] for a in strings}
        if [tuning.get(6 - s) for s in range(6)] != STANDARD:
            return None
        tempos = [(d["time"], d["value"]) for a in j["annotations"] if a["namespace"] == "tempo" for d in a["data"]]
        sec = seconds(tempos)
        rows = []
        for a in strings:
            s = 6 - a["sandbox"]["string_index"]
            for d in a["data"]:
                fret = d["value"]["fret"]
                if fret < 0 or fret > 24:
                    continue
                t0 = sec(d["time"])
                rows.append((t0, STANDARD[s] + fret, sec(d["time"] + d["duration"]) - t0, s))
        if len(rows) < 30:
            return None
        rows.sort(key=lambda r: (round(r[0], 4), r[1]))
        song = name.split(" - gp")[0]
        return song, np.array(rows, np.float32)
    except Exception:
        return None


if __name__ == "__main__":
    files = sorted(glob.glob(os.path.join(sys.argv[1], "*", "*.jams")))
    with Pool(int(sys.argv[3]) if len(sys.argv) > 3 else 4) as p:
        out = [r for r in p.imap(track, files, chunksize=64) if r]
    songs = sorted({s for s, _ in out})
    sid = {s: i for i, s in enumerate(songs)}
    lens = np.array([len(r) for _, r in out])
    np.savez_compressed(sys.argv[2], notes=np.concatenate([r for _, r in out]), lens=lens, song=np.array([sid[s] for s, _ in out]))
    print("parts", len(out), "of", len(files), "songs", len(songs), "notes", lens.sum())
