"""Trains the string classifier: pitch-aligned spectral patch + pitch -> which of the 6 strings.
Usage: python train.py <out.pt> <epochs> <dataset spec>... [--all]
  spec: <guitarset.npz>:<train players, e.g. 012> or <egdb.npz>:egdb (clips below 216 train)"""

import sys

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

TUNING = torch.tensor([40, 45, 50, 55, 59, 64])
MAX_FRET = 20


class StringNet(nn.Module):
    def __init__(self, nb=200, nf=12):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(1, 32, (3, 5), padding=(1, 2)), nn.BatchNorm2d(32), nn.ReLU(),
            nn.Conv2d(32, 32, (3, 5), padding=(1, 2)), nn.BatchNorm2d(32), nn.ReLU(),
            nn.MaxPool2d((2, 2)),
            nn.Conv2d(32, 64, (3, 3), padding=1), nn.BatchNorm2d(64), nn.ReLU(),
            nn.MaxPool2d((2, 2)),
            nn.Conv2d(64, 64, (3, 3), padding=1), nn.BatchNorm2d(64), nn.ReLU(),
            nn.AdaptiveAvgPool2d((1, 25)),
        )
        self.head = nn.Sequential(nn.Linear(64 * 25 + 49, 256), nn.ReLU(), nn.Dropout(0.3), nn.Linear(256, 6))

    def forward(self, x, midi):
        # x: [B, NF, NB]; midi: [B] float. Infeasible strings get -1e4.
        h = self.conv(x.unsqueeze(1)).flatten(1)
        onehot = F.one_hot((midi.long() - 40).clamp(0, 48), 49).float()
        logits = self.head(torch.cat([h, onehot], 1))
        fret = midi.unsqueeze(1) - TUNING.to(x.device).unsqueeze(0).float()
        feasible = (fret >= 0) & (fret <= MAX_FRET)
        return torch.where(feasible, logits, torch.full_like(logits, -1e4))


def load(spec):
    """'gs.npz:012' (GuitarSet, train on those players) or 'egdb.npz:egdb' (EGDB, clips < 216 train).
    Returns X, string, midi, train mask, test mask (un-jittered copies only), group label per note."""
    path, split = spec.rsplit(":", 1)
    ds = np.load(path)
    s, midi, player = ds["s"].astype(np.int64), ds["midi"].astype(np.float32), ds["player"].astype(np.int64)
    if split == "egdb":
        copies = 2
        tr = player < 216
        group = np.where(ds["solo"] == 0, "egdb-DI", np.where(ds["solo"] == 1, "egdb-Marshall", np.where(ds["solo"] == 2, "egdb-Plexi", "egdb-other")))
    else:
        copies = 3
        tr = np.isin(player, [int(c) for c in split])
        group = np.where(ds["solo"] == 1, "gs-solo", "gs-comp")
    first = np.arange(len(s)) % copies == 0
    return ds["X"], s, midi, tr, ~tr & first, group


def main():
    # usage: train.py <out.pt> <epochs> <dataset spec>... [--all] (--all: train on the test parts too)
    out, epochs = sys.argv[1], int(sys.argv[2])
    specs = [a for a in sys.argv[3:] if ":" in a]
    parts = [load(sp) for sp in specs]
    X = np.concatenate([p[0] for p in parts])
    s = np.concatenate([p[1] for p in parts])
    midi = np.concatenate([p[2] for p in parts])
    tr = np.concatenate([p[3] for p in parts])
    te = np.concatenate([p[4] for p in parts])
    group = np.concatenate([p[5] for p in parts])
    if "--all" in sys.argv:
        tr = np.ones_like(tr)
    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    torch.manual_seed(0)
    net = StringNet().to(dev)
    opt = torch.optim.AdamW(net.parameters(), 1e-3, weight_decay=1e-4)
    idx = np.where(tr)[0]
    steps = epochs * (len(idx) // 256)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 2e-3, total_steps=steps)
    Xt = torch.from_numpy(X)

    def evaluate(mask):
        net.eval()
        ii = np.where(mask)[0]
        pred = []
        with torch.no_grad():
            for k in range(0, len(ii), 2048):
                b = ii[k : k + 2048]
                pred.append(net(Xt[b].float().to(dev), torch.from_numpy(midi[b]).to(dev)).argmax(1).cpu().numpy())
        net.train()
        return (np.concatenate(pred) if pred else np.array([])), ii

    for ep in range(epochs):
        rng = np.random.default_rng(ep)
        perm = rng.permutation(idx)
        tot = 0.0
        for k in range(0, len(perm) - 255, 256):
            b = perm[k : k + 256]
            x = Xt[b].float()
            # augmentation: random gain tilt over frequency and small level noise
            tilt = (torch.rand(len(b), 1, 1) - 0.5) * 0.2 * torch.linspace(-1, 1, x.shape[2])
            x = (x + tilt + torch.randn_like(x) * 0.01).to(dev)
            loss = F.cross_entropy(net(x, torch.from_numpy(midi[b]).to(dev)), torch.from_numpy(s[b]).to(dev))
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += loss.item()
        msg = f"epoch {ep} loss {tot / max(1, len(perm) // 256):.3f}"
        if te.any() and (ep == epochs - 1 or ep % 3 == 2):
            pred, ii = evaluate(te)
            ok = pred == s[ii]
            msg += " | held-out " + " ".join(f"{g} {ok[group[ii] == g].mean():.3f}" for g in sorted(set(group[ii])))
        print(msg, flush=True)
    torch.save(net.state_dict(), out)


if __name__ == "__main__":
    main()
