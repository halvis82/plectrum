# Exports the BTC large-vocabulary chord model (github.com/jayg996/BTC-ISMIR19, MIT) for the browser.
# Usage: python scripts/export_model.py <path to BTC-ISMIR19 checkout> public/model
# Needs: torch librosa onnx onnxruntime pyyaml
#   btc170.v1.onnx   x[1,108,144] normalized log-CQT -> logp[1,108,170]
#   btc170.v1.json   feature mean/std and the 170 chord labels
#   cqt_basis.v1.bin sparse librosa CQT kernel (layout documented in src/lib/analysis/cqt.ts)
import json
import sys

import librosa
import numpy as np
import torch
import yaml
from librosa.core.constantq import __vqt_filter_fft as vqt_filter_fft

np.float, np.int = float, int  # BTC predates numpy 1.24

btc_dir, out = sys.argv[1], sys.argv[2]
sys.path.insert(0, btc_dir)
from btc_model import BTC_model  # noqa: E402
from utils.hparams import HParams  # noqa: E402
from utils.mir_eval_modules import idx2voca_chord  # noqa: E402

# ---- model ----
cfg = HParams(**yaml.safe_load(open(f"{btc_dir}/run_config.yaml")))
cfg.model["num_chords"] = 170
model = BTC_model(config=cfg.model)
ckpt = torch.load(f"{btc_dir}/test/btc_model_large_voca.pt", map_location="cpu", weights_only=False)
model.load_state_dict(ckpt["model"])
model.eval()


class Export(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        h, _ = self.m.self_attn_layers(x)
        return torch.log_softmax(self.m.output_layer.output_projection(h), -1)


torch.onnx.export(Export(model).eval(), torch.randn(1, 108, 144), f"{out}/btc170.v1.onnx",
                  input_names=["x"], output_names=["logp"], opset_version=17, dynamo=False)
labels = idx2voca_chord()
json.dump({"mean": float(ckpt["mean"]), "std": float(ckpt["std"]), "labels": [labels[i] for i in range(170)]},
          open(f"{out}/btc170.v1.json", "w"))

# ---- CQT kernel, identical to librosa.cqt(sr=22050, n_bins=144, bins_per_octave=24) at full rate ----
SR, NB, BPO = 22050, 144, 24
freqs = librosa.cqt_frequencies(NB, fmin=librosa.note_to_hz("C1"), bins_per_octave=BPO)
alpha = librosa.filters._relative_bandwidth(freqs=freqs)
lengths, _ = librosa.filters.wavelet_lengths(freqs=freqs, sr=SR, filter_scale=1, window="hann", alpha=alpha)
basis, n_fft, _ = vqt_filter_fft(SR, freqs, 1, 1, 0.01, window="hann", alpha=alpha)
basis = basis.toarray()
starts, counts, vals = [], [], []
for b in range(NB):
    nz = np.nonzero(basis[b])[0]
    s, e = nz.min(), nz.max() + 1
    starts.append(s)
    counts.append(e - s)
    v = basis[b, s:e] / np.sqrt(lengths[b])  # librosa's scale=True
    vals.append(np.stack([v.real, v.imag], -1).astype(np.float32).ravel())
header = np.array([NB, n_fft] + [x for pair in zip(starts, counts) for x in pair], dtype=np.int32)
with open(f"{out}/cqt_basis.v1.bin", "wb") as f:
    f.write(header.tobytes())
    f.write(np.concatenate(vals).tobytes())
print("exported to", out)
