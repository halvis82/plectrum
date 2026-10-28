"""The fingering model: which string each note of a passage is played on, from the notes alone (pitch,
timing, what sounds together), learned from guitarists' tabs. Shared by train.py, eval.py and export.py.

Per note inputs: pitch, seconds since the previous onset, length, and whether it starts with the previous
note (a chord). Output: one logit per string, low E first; strings that can't play the pitch get -1e4."""

import math

import torch
import torch.nn as nn

STANDARD = torch.tensor([40, 45, 50, 55, 59, 64])
MAX_FRET = 20
LO, HI = 40, 88  # pitch range
CHORD = 0.03  # onsets this close are one event


def features(pitch, onset, dur):
    """pitch, onset, dur: [B, T] float tensors (notes in time order) -> [B, T, 4] model inputs."""
    dt = torch.diff(onset, dim=1, prepend=onset[:, :1])
    together = (dt < CHORD).float()
    return torch.stack([pitch, torch.log1p(dt.clamp(min=0) * 20), torch.log1p(dur.clamp(min=0) * 10), together], -1)


class FingerNet(nn.Module):
    def __init__(self, d=192, layers=4, heads=4):
        super().__init__()
        self.pitch = nn.Embedding(HI - LO + 1, d)
        self.cont = nn.Linear(3, d)
        enc = nn.TransformerEncoderLayer(d, heads, d * 4, dropout=0.1, batch_first=True, norm_first=True)
        self.enc = nn.TransformerEncoder(enc, layers)
        self.pos = nn.Parameter(torch.randn(1, 512, d) * 0.02)
        self.out = nn.Linear(d, 6)

    def forward(self, x):
        # x: [B, T, 4] from features(); T <= 512
        p = x[..., 0]
        h = self.pitch((p.round().long() - LO).clamp(0, HI - LO)) + self.cont(x[..., 1:]) + self.pos[:, : x.shape[1]]
        logits = self.out(self.enc(h))
        fret = p.unsqueeze(-1) - STANDARD.to(x.device).float()
        ok = (fret >= 0) & (fret <= MAX_FRET)
        return torch.where(ok, logits, torch.full_like(logits, -1e4))
