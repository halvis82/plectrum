"""Scores every combo directory written by guitarset-tune.mts (beat-level sheet vs GuitarSet).
Players 00-02 are the tuning half, 03-05 the held-out half.
Usage: python -I scripts/guitarset-sweep.py <jams-dir> <out-root>"""
import json, os, sys
import numpy as np
import mir_eval

jams_dir, root = sys.argv[1], sys.argv[2]
METRICS = ["root", "majmin", "sevenths", "mirex"]


def load_ref(path, idx):
    a = [x for x in json.load(open(path))["annotations"] if x["namespace"] == "chord"][idx]
    return np.array([[d["time"], d["time"] + d["duration"]] for d in a["data"]]), [d["value"] for d in a["data"]]


refs = {}
rows = []
for combo in sorted(os.listdir(root)):
    acc = {h: {m: [0.0, 0.0] for m in METRICS} for h in ("tune", "held")}
    for f in os.listdir(os.path.join(root, combo)):
        o = json.load(open(os.path.join(root, combo, f)))
        name = o["file"].replace("_mic.f32", "")
        half = "tune" if int(name[:2]) <= 2 else "held"
        if name not in refs:
            refs[name] = load_ref(os.path.join(jams_dir, name + ".jams"), 0)
        ref_iv, ref_lab = refs[name]
        iv, lab, t = [], [], 0.0
        for s, e, l in o["beat"]:
            if s > t + 1e-3:
                iv.append([t, s]); lab.append("N")
            if e > s:
                iv.append([s, e]); lab.append(l)
            t = max(t, e)
        est_iv, est_lab = mir_eval.util.adjust_intervals(np.array(iv), lab, ref_iv.min(), ref_iv.max(), "N", "N")
        miv, rl, el = mir_eval.util.merge_labeled_intervals(ref_iv, ref_lab, est_iv, est_lab)
        d = mir_eval.util.intervals_to_durations(miv)
        for m in METRICS:
            c = getattr(mir_eval.chord, m)(rl, el)
            ok = c >= 0
            acc[half][m][0] += float(np.sum(d[ok] * c[ok])); acc[half][m][1] += float(np.sum(d[ok]))
    rows.append((combo, {h: {m: 100 * v[0] / v[1] for m, v in acc[h].items()} for h in acc}))

rows.sort(key=lambda r: -(r[1]["tune"]["majmin"] + r[1]["tune"]["sevenths"]))
print("combo | tune root/majmin/7ths/mirex | held root/majmin/7ths/mirex")
for combo, r in rows:
    print(f"{combo:28s} | " + " / ".join(f"{r['tune'][m]:.1f}" for m in METRICS) + " | " + " / ".join(f"{r['held'][m]:.1f}" for m in METRICS))
