"""Score Plectrum output (from scripts/guitarset-bench.mts) against GuitarSet JAMS chord annotations.

Usage: python -I scripts/guitarset-score.py <jams-dir> <bench-out-dir>

GuitarSet comp JAMS carry two "chord" annotations: index 0 is the instructed lead sheet chord,
index 1 is the performed chord (semi-automatic transcription of what was actually played).
Both are scored. Accuracy is duration-weighted and pooled over all files (mir_eval semantics:
reference segments a metric cannot map, e.g. non-majmin under "majmin", are excluded).
"""
import json, os, sys, re
from collections import Counter, defaultdict
import numpy as np
import mir_eval

METRICS = ["root", "majmin", "sevenths", "mirex", "thirds", "triads"]
jams_dir, out_dir = sys.argv[1], sys.argv[2]


def load_ref(path, idx):
    j = json.load(open(path))
    chords = [a for a in j["annotations"] if a["namespace"] == "chord"]
    a = chords[idx]
    iv = np.array([[d["time"], d["time"] + d["duration"]] for d in a["data"]])
    lab = [d["value"] for d in a["data"]]
    return iv, lab


def fill(items, dur):
    """items: [start, end, label]; fill gaps (e.g. before first beat) with N."""
    iv, lab, t = [], [], 0.0
    for s, e, l in items:
        if s > t + 1e-3:
            iv.append([t, s]); lab.append("N")
        if e > s:
            iv.append([s, e]); lab.append(l)
        t = max(t, e)
    if t < dur - 1e-3:
        iv.append([t, dur]); lab.append("N")
    return np.array(iv), lab


def compare(ref_iv, ref_lab, est_iv, est_lab):
    est_iv, est_lab = mir_eval.util.adjust_intervals(est_iv, est_lab, ref_iv.min(), ref_iv.max(),
                                                     mir_eval.chord.NO_CHORD, mir_eval.chord.NO_CHORD)
    iv, rl, el = mir_eval.util.merge_labeled_intervals(ref_iv, ref_lab, est_iv, est_lab)
    return iv, rl, el, mir_eval.util.intervals_to_durations(iv)


QUAL_BITS = {"maj": [0, 4, 7], "min": [0, 3, 7], "7": [0, 4, 7, 10], "maj7": [0, 4, 7, 11], "min7": [0, 3, 7, 10],
             "dim": [0, 3, 6], "hdim7": [0, 3, 6, 10], "dim7": [0, 3, 6, 9], "aug": [0, 4, 8], "sus2": [0, 2, 7],
             "sus4": [0, 5, 7], "maj6": [0, 4, 7, 9], "min6": [0, 3, 7, 9], "minmaj7": [0, 3, 7, 11]}
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def simple(lab):
    """Reduce any Harte label (extensions, omissions, inversions) to root:quality in the BTC vocabulary.
    Unknown shapes fall back to the sevenths-style reduction (third + seventh), then maj/min."""
    if lab in ("N", "X"):
        return lab
    r, bits, _ = mir_eval.chord.encode(lab)
    pcs = {i for i in range(12) if bits[i]}
    for q, iv in QUAL_BITS.items():
        if pcs == set(iv):
            return f"{NAMES[r]}:{q}"
    third = "min" if 3 in pcs and 4 not in pcs else "maj" if 4 in pcs else ("sus4" if 5 in pcs else "sus2" if 2 in pcs else "maj")
    sev = "7" if 10 in pcs else "maj7" if 11 in pcs else ""
    q = {("maj", "7"): "7", ("maj", "maj7"): "maj7", ("min", "7"): "min7", ("min", "maj7"): "minmaj7"}.get((third, sev), third)
    return f"{NAMES[r]}:{q}"


def root_pc(lab):
    try:
        r, _, _ = mir_eval.chord.encode(lab)
        return int(r)
    except Exception:
        return -1


results = {}
for ref_idx, ref_name in [(0, "instructed"), (1, "performed")]:
    for kind in ["beat", "seg"]:
        num = defaultdict(float); den = defaultdict(float)
        by_style = defaultdict(lambda: [0.0, 0.0])
        conf = Counter(); root_off = Counter(); tot = 0.0
        est_q = Counter(); ref_q = Counter()
        n_start = 0.0; n_est = 0.0; n_ref = 0.0; n_gap = 0.0
        sev = Counter()  # (ref has 7th, est has 7th) -> duration
        files = 0
        for f in sorted(os.listdir(out_dir)):
            o = json.load(open(os.path.join(out_dir, f)))
            name = o["file"].replace("_mic.f32", "")
            ref_iv, ref_lab = load_ref(os.path.join(jams_dir, name + ".jams"), ref_idx)
            items = o[kind]
            n_gap += items[0][0] + max(0.0, o["duration"] - items[-1][1])
            est_iv, est_lab = fill(items, o["duration"])
            iv, rl, el, d = compare(ref_iv, ref_lab, est_iv, est_lab)
            files += 1
            for m in METRICS:
                c = getattr(mir_eval.chord, m)(rl, el)
                ok = c >= 0
                num[m] += float(np.sum(d[ok] * c[ok])); den[m] += float(np.sum(d[ok]))
            mm = mir_eval.chord.majmin(rl, el)
            style = re.match(r"\d+_([A-Za-z]+)", name).group(1)
            ok = mm >= 0
            by_style[style][0] += float(np.sum(d[ok] * mm[ok])); by_style[style][1] += float(np.sum(d[ok]))
            first_on = ref_iv[0][0]
            for (s, e), r, x, w in zip(iv, rl, el, d):
                tot += w
                sr, sx = simple(r), simple(x)
                ref_q[sr.split(":")[-1] if ":" in sr else sr] += w
                est_q[sx.split(":")[-1] if ":" in sx else sx] += w
                if sr not in ("N", "X") and sx not in ("N", "X"):
                    has7 = lambda q: q.split(":")[1] in ("7", "maj7", "min7", "hdim7", "dim7", "minmaj7")
                    sev[(has7(sr), has7(sx))] += w
                if sr != sx:
                    conf[(sr, sx)] += w
                pr, px = root_pc(r), root_pc(x)
                if pr >= 0 and px >= 0:
                    root_off[(px - pr) % 12] += w
                if x == "N":
                    n_est += w
                    if s < 3.0:
                        n_start += w
                if r == "N":
                    n_ref += w
        results[(ref_name, kind)] = dict(
            acc={m: num[m] / den[m] for m in METRICS}, cover={m: den[m] / tot for m in METRICS},
            style={k: v[0] / v[1] for k, v in by_style.items()}, conf=conf, root_off=root_off, tot=tot,
            est_q=est_q, ref_q=ref_q, n_start=n_start, n_est=n_est, n_ref=n_ref, files=files, n_gap=n_gap, sev=sev)

print(f"files: {results[('instructed', 'beat')]['files']}, total {results[('instructed', 'beat')]['tot'] / 60:.1f} min\n")
print("| reference | level | " + " | ".join(METRICS) + " |")
print("|---|---|" + "---|" * len(METRICS))
for (rn, k), r in results.items():
    print(f"| {rn} | {k} | " + " | ".join(f"{100 * r['acc'][m]:.1f}" for m in METRICS) + " |")
print("\nscored coverage (fraction of duration each metric can score):")
for (rn, k), r in results.items():
    print(f"  {rn:10s} {k:4s} " + " ".join(f"{m}={100 * r['cover'][m]:.0f}%" for m in METRICS))
print("\nmajmin by style:")
for (rn, k), r in results.items():
    print(f"  {rn:10s} {k:4s} " + " ".join(f"{s}={100 * v:.1f}" for s, v in sorted(r["style"].items())))
for (rn, k), r in results.items():
    print(f"\n== {rn} / {k} ==")
    print("top confusions (ref -> est, % of total duration):")
    for (a, b), w in r["conf"].most_common(10):
        print(f"  {a:10s} -> {b:10s} {100 * w / r['tot']:.2f}%")
    so = sum(r["root_off"].values())
    print("root offset est-ref (semitones), % of rooted duration:",
          " ".join(f"{o}:{100 * w / so:.1f}" for o, w in sorted(r["root_off"].items())))
    print("est quality share:", " ".join(f"{q}:{100 * w / r['tot']:.1f}" for q, w in r["est_q"].most_common(10)))
    print("ref quality share:", " ".join(f"{q}:{100 * w / r['tot']:.1f}" for q, w in r["ref_q"].most_common(10)))
    print(f"est N: {100 * r['n_est'] / r['tot']:.2f}% of time ({100 * r['n_start'] / max(r['n_est'], 1e-9):.0f}% of it in first 3 s), ref N: {100 * r['n_ref'] / r['tot']:.2f}%")
    print(f"   N from gaps before first / after last beat or segment: {100 * r['n_gap'] / r['tot']:.2f}% of time")
    sv = r["sev"]
    p = sv[(True, True)] / max(sv[(True, True)] + sv[(False, True)], 1e-9)
    rc = sv[(True, True)] / max(sv[(True, True)] + sv[(True, False)], 1e-9)
    print(f"seventh-family: precision {100 * p:.1f}% recall {100 * rc:.1f}% (est 7th share {100 * (sv[(True, True)] + sv[(False, True)]) / r['tot']:.1f}%, ref 7th share {100 * (sv[(True, True)] + sv[(True, False)]) / r['tot']:.1f}%)")
