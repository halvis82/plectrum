"""Trains the fingering model on corpus.py's tabs, with the kinds of mistakes a transcription makes
(missed and extra notes, onset jitter, strums spread over a few ms).
Usage: python train.py <corpus.npz> <out.pt> <steps> [eval refs dir (GuitarSet .json: start, end, midi, string)]"""

import glob
import json
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(__file__))
from model import CHORD, HI, LO, MAX_FRET, STANDARD, FingerNet, features  # noqa: E402

T = 256
B = 64
STD = STANDARD.numpy()


def crops(notes, lens, song, rng, val):
    starts = np.concatenate([[0], np.cumsum(lens)[:-1]])
    keep = (song % 50 == 0) == val  # 2% of songs held out for validation
    parts = np.where(keep & (lens >= 40))[0]
    w = lens[parts] / lens[parts].sum()
    while True:
        i = rng.choice(parts, p=w)
        a = starts[i] + rng.integers(0, max(1, lens[i] - T))
        yield notes[a : a + min(T, lens[i])]


def corrupt(seg, rng):
    t, p, d, s = seg[:, 0].copy(), seg[:, 1].copy(), seg[:, 2].copy(), seg[:, 3].astype(np.int64)
    n = len(t)
    keep = rng.random(n) > rng.uniform(0, 0.15)  # missed notes
    t, p, d, s = t[keep], p[keep], d[keep], s[keep]
    t = t - t.min() if len(t) else t
    # strums: chord notes spread low to high by a few ms; plus onset jitter
    t = t + rng.normal(0, 0.008, len(t)) + (rng.random() < 0.5) * rng.uniform(0, 0.012) * (p - p.min()) / 12
    d = d * np.exp(rng.normal(0, 0.4, len(d)))
    # extra notes (string label -1: no loss), often an octave or a fifth from a real one
    k = rng.binomial(len(t), rng.uniform(0, 0.1))
    if k:
        j = rng.integers(0, len(t), k)
        ep = np.clip(p[j] + rng.choice([-12, 12, 7, -5, 1, -1, 2], k), LO, HI)
        t = np.concatenate([t, t[j] + rng.normal(0, 0.02, k)])
        p = np.concatenate([p, ep])
        d = np.concatenate([d, d[j]])
        s = np.concatenate([s, -np.ones(k, np.int64)])
    # random transposition within what keeps every labeled note playable
    fret = p[s >= 0] - STD[s[s >= 0]]
    lo, hi = -int(fret.min()) if len(fret) else 0, MAX_FRET - int(fret.max()) if len(fret) else 0
    if hi >= lo:
        sh = int(rng.integers(max(lo, -5), min(hi, 5) + 1)) if min(hi, 5) >= max(lo, -5) else 0
        p = p + sh
    order = np.lexsort((p, np.round(t / CHORD)))
    t, p, d, s = t[order], p[order], d[order], s[order]
    ok = (s < 0) | ((p - STD[np.maximum(s, 0)] >= 0) & (p - STD[np.maximum(s, 0)] <= MAX_FRET))
    s = np.where(ok, s, -1)
    return t, p, d, s


def batch(gen, rng, noisy=True):
    X, Y = [], []
    for _ in range(B):
        seg = next(gen)
        t, p, d, s = corrupt(seg, rng) if noisy else (seg[:, 0] - seg[0, 0], seg[:, 1], seg[:, 2], seg[:, 3].astype(np.int64))
        t, p, d, s = t[:T], p[:T], d[:T], s[:T]
        pad = T - len(t)
        X.append(np.stack([np.pad(p, (0, pad), constant_values=LO), np.pad(t, (0, pad), mode="edge" if len(t) else "constant"), np.pad(d, (0, pad))], -1))
        Y.append(np.pad(s, (0, pad), constant_values=-1))
    X = torch.from_numpy(np.array(X, np.float32))
    return features(X[..., 0], X[..., 1], X[..., 2]), torch.from_numpy(np.array(Y))


def gs_eval(net, refs, dev):
    """String accuracy on GuitarSet's annotated notes, from pitch and timing alone."""
    net.eval()
    hit = tot = 0
    with torch.no_grad():
        for f in refs:
            r = np.array(json.load(open(f)), np.float32)
            r = r[(r[:, 2] >= LO) & (r[:, 2] <= HI) & (r[:, 3] >= 0)]
            order = np.lexsort((r[:, 2], np.round(r[:, 0] / CHORD)))
            r = r[order]
            pred = predict(net, r[:, 0], r[:, 2], r[:, 1] - r[:, 0], dev)
            hit += (pred.argmax(1) == r[:, 3]).sum()
            tot += len(r)
    net.train()
    return hit / max(1, tot)


def predict(net, onset, pitch, dur, dev, win=T, hop=T // 2):
    """Log-probabilities [n, 6] for a whole piece, in overlapping windows (the middle of each counts)."""
    n = len(onset)
    out = np.zeros((n, 6), np.float32)
    weight = np.zeros(n, np.float32)
    for a in range(0, max(1, n - hop), hop) if n > win else [0]:
        b = min(n, a + win)
        a = max(0, b - win)
        x = features(*(torch.from_numpy(np.asarray(v[a:b], np.float32))[None] for v in (pitch, onset - onset[a], dur)))
        lp = torch.log_softmax(net(x.to(dev))[0], -1).cpu().numpy()
        w = np.minimum(np.arange(1, b - a + 1), np.arange(b - a, 0, -1)).astype(np.float32)
        out[a:b] += lp * w[:, None]
        weight[a:b] += w
    return out / weight[:, None]


def main():
    corpus, out, steps = sys.argv[1], sys.argv[2], int(sys.argv[3])
    refs = sorted(glob.glob(os.path.join(sys.argv[4], "*_mic.json"))) if len(sys.argv) > 4 else []
    z = np.load(corpus)
    notes, lens, song = z["notes"], z["lens"], z["song"]
    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    torch.manual_seed(0)
    rng = np.random.default_rng(0)
    net = FingerNet().to(dev)
    print("params", sum(p.numel() for p in net.parameters()))
    opt = torch.optim.AdamW(net.parameters(), 3e-4, weight_decay=0.01)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 6e-4, total_steps=steps, pct_start=0.05)
    gen, vgen = crops(notes, lens, song, rng, False), crops(notes, lens, song, np.random.default_rng(1), True)
    t0, tot = time.time(), 0.0
    for step in range(1, steps + 1):
        x, y = batch(gen, rng)
        loss = F.cross_entropy(net(x.to(dev)).reshape(-1, 6), y.to(dev).reshape(-1), ignore_index=-1)
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
        opt.step()
        sched.step()
        tot += loss.item()
        if step % 500 == 0 or step == steps:
            with torch.no_grad():
                net.eval()
                xv, yv = batch(vgen, rng, noisy=False)
                pv = net(xv.to(dev)).argmax(-1).cpu()
                m = yv >= 0
                vacc = (pv[m] == yv[m]).float().mean().item()
                net.train()
            msg = f"step {step} loss {tot / 500:.3f} val tab acc {vacc:.3f}"
            if refs and (step % 2500 == 0 or step == steps):
                msg += f" | GuitarSet string acc {gs_eval(net, refs, dev):.3f}"
            print(msg, f"{time.time() - t0:.0f}s", flush=True)
            tot = 0.0
            torch.save(net.state_dict(), out)


if __name__ == "__main__":
    main()
