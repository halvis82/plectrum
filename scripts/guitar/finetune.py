"""Fine-tunes the guitar note model (Riley et al.'s Kong-style CRNN) on the data from finetune_data.py.
Each example is a random 5 s crop with random EQ, room reverb and noise, and half the time a band
backing (other instruments) mixed underneath at a random level, so the model learns to ignore
what isn't guitar. Targets follow Kong et al. (piano_transcription): onset and offset regression
(triangles +-50 ms around each event) and frame activity, all with binary cross-entropy. Batch norm
statistics and the velocity head stay as trained.
Usage: python finetune.py <checkpoint.pth> <data dir> <out dir> [steps] [lr]
  writes <out dir>/step<N>.pth every 1000 steps"""

import json
import math
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F
import piano_transcription_inference.models as kong
from piano_transcription_inference.models import Regress_onset_offset_frame_velocity_CRNN
from scipy.signal import butter, fftconvolve, sosfilt

# 5 s crops: half the memory of the model's 10 s windows, which matters on a 16 GB laptop
SR, FPS, SEG = 16000, 100, 80000
FRAMES = SEG // 160 + 1
SOURCES = {"guitarset": 0.25, "techs": 0.35, "egdb": 0.25, "slakh": 0.15}


class Data(torch.utils.data.IterableDataset):
    def __init__(self, root, seed):
        self.index = json.load(open(os.path.join(root, "index.json")))
        self.bindex = json.load(open(os.path.join(root, "backing.json")))
        self.audio = np.memmap(os.path.join(root, "audio.f16"), np.float16, "r")
        self.backing = np.memmap(os.path.join(root, "backing.f16"), np.float16, "r")
        self.seed = seed
        self.by_source = {s: [i for i, r in enumerate(self.index) if r["source"] == s] for s in SOURCES}

    def __iter__(self):
        info = torch.utils.data.get_worker_info()
        rng = np.random.default_rng(self.seed + (info.id if info else 0))
        names = [s for s in SOURCES if self.by_source[s]]
        p = np.array([SOURCES[s] for s in names])
        p /= p.sum()
        while True:
            recs = self.by_source[names[rng.choice(len(names), p=p)]]
            w = np.array([self.index[i]["length"] for i in recs], float)
            r = self.index[recs[rng.choice(len(recs), p=w / w.sum())]]
            yield self.example(r, rng)

    def example(self, r, rng):
        start = int(rng.integers(0, max(1, r["length"] - SEG)))
        y = np.zeros(SEG, np.float32)
        seg = self.audio[r["offset"] + start : r["offset"] + min(r["length"], start + SEG)].astype(np.float32)
        y[: len(seg)] = seg
        y = augment(y, rng)
        if self.bindex and rng.random() < 0.5:
            b = self.bindex[rng.integers(len(self.bindex))]
            bs = int(rng.integers(0, max(1, b["length"] - SEG)))
            back = np.zeros(SEG, np.float32)
            part = self.backing[b["offset"] + bs : b["offset"] + min(b["length"], bs + SEG)].astype(np.float32)
            back[: len(part)] = part
            g, k = np.sqrt(np.mean(y**2)) + 1e-6, np.sqrt(np.mean(back**2)) + 1e-6
            snr = rng.uniform(-3, 12)  # guitar level over the band, dB
            y = y + back * (g / k) * 10 ** (-snr / 20)
        y = y / (np.abs(y).max() + 1e-6) * rng.uniform(0.3, 0.95)
        return torch.from_numpy(y.astype(np.float32)), targets(r["notes"], start / SR)


def augment(y, rng):
    if rng.random() < 0.7:  # tone: random low and high shelving
        lo, hi = rng.uniform(60, 400), rng.uniform(2500, 7500)
        y = y + rng.uniform(-0.5, 0.5) * sosfilt(butter(2, lo, "lp", fs=SR, output="sos"), y) + rng.uniform(-0.5, 0.5) * sosfilt(butter(2, hi, "hp", fs=SR, output="sos"), y)
    if rng.random() < 0.3:  # room
        rt = rng.uniform(0.1, 0.8)
        n = int(SR * rt)
        h = rng.standard_normal(n) * np.exp(-6.9 * np.arange(n) / SR / rt)
        h[0] = 1 / rng.uniform(0.15, 0.5)
        y = fftconvolve(y, h / np.abs(h).sum() * 4)[: len(y)]
    if rng.random() < 0.3:  # noise
        noise = sosfilt(butter(1, rng.uniform(500, 6000), "lp", fs=SR, output="sos"), rng.standard_normal(len(y)))
        y = y + noise * np.sqrt(np.mean(y**2) / (np.mean(noise**2) + 1e-9)) * 10 ** (-rng.uniform(15, 40) / 20)
    return y.astype(np.float32)


def regression(times, frames):
    """Kong et al.: 1 at an event, falling linearly to 0 at 50 ms from it (per frame, nearest event)."""
    out = np.zeros(frames, np.float32)
    if len(times):
        t = np.arange(frames) / FPS
        d = np.min(np.abs(t[:, None] - np.array(times)[None, :]), axis=1)
        out = 1 - np.clip(d, 0, 0.05) * 20
    return out


def targets(notes, t0):
    onset = np.zeros((FRAMES, 88), np.float32)
    offset = np.zeros((FRAMES, 88), np.float32)
    frame = np.zeros((FRAMES, 88), np.float32)
    dur = SEG / SR
    on_t, off_t = {}, {}
    for s, e, m in notes:
        s, e = s - t0, e - t0
        if e < 0 or s > dur:
            continue
        k = m - 21
        if 0 <= s <= dur:
            on_t.setdefault(k, []).append(s)
        if 0 <= e <= dur:
            off_t.setdefault(k, []).append(e)
        frame[max(0, round(s * FPS)) : min(FRAMES, round(e * FPS) + 1), k] = 1
    for k, ts in on_t.items():
        onset[:, k] = regression(ts, FRAMES)
    for k, ts in off_t.items():
        offset[:, k] = regression(ts, FRAMES)
    return torch.from_numpy(np.stack([onset, offset, frame]))


def main():
    # the inference package uses in-place ReLU and dropout, which autograd can't differentiate through
    kong.F.relu_ = F.relu
    dropout = F.dropout
    kong.F.dropout = lambda x, p=0.5, training=True, inplace=False: dropout(x, p, training, False)
    ckpt, root, out = sys.argv[1:4]
    steps = int(sys.argv[4]) if len(sys.argv) > 4 else 3000
    lr = float(sys.argv[5]) if len(sys.argv) > 5 else 1e-4
    os.makedirs(out, exist_ok=True)
    torch.set_num_threads(4)
    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    model = Regress_onset_offset_frame_velocity_CRNN(frames_per_second=FPS, classes_num=88)
    state = torch.load(ckpt, map_location="cpu", weights_only=False)
    model.load_state_dict(state["model"] if "model" in state else state)
    model.to(dev).train()
    for m in model.modules():
        if isinstance(m, torch.nn.BatchNorm2d) or isinstance(m, torch.nn.BatchNorm1d):
            m.eval()
            for p in m.parameters():
                p.requires_grad = False
    for p in model.velocity_model.parameters():
        p.requires_grad = False
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / 200) * 0.5 * (1 + math.cos(math.pi * min(s, steps) / steps)))
    # batches of 2, two per optimizer step: an effective batch of 4 within a laptop's GPU memory
    batch, accum = 2, 2
    loader = torch.utils.data.DataLoader(Data(root, 0), batch_size=batch, num_workers=1)
    t0, tot, step = time.time(), 0.0, 0
    for k, (x, y) in enumerate(loader):
        x, y = x.to(dev), y.to(dev)
        o = model(x)
        n = min(o["frame_output"].shape[1], y.shape[2])
        loss = sum(F.binary_cross_entropy(o[key][:, :n].clamp(1e-6, 1 - 1e-6), y[:, i, :n]) for i, key in enumerate(["reg_onset_output", "reg_offset_output", "frame_output"]))
        (loss / accum).backward()
        tot += loss.item() / accum
        if (k + 1) % accum:
            continue
        torch.nn.utils.clip_grad_norm_(params, 1.0)
        opt.step()
        opt.zero_grad()
        sched.step()
        step += 1
        if step % 50 == 0:
            print(f"step {step} loss {tot / 50:.4f} lr {sched.get_last_lr()[0]:.2e} {(time.time() - t0) / step:.2f}s/step", flush=True)
            tot = 0.0
        if step % 1000 == 0 or step == steps:
            torch.save({"model": model.state_dict()}, os.path.join(out, f"step{step}.pth"))
        if step >= steps:
            break


if __name__ == "__main__":
    main()
