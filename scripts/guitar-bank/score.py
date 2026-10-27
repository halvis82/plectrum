"""Score rendered guitars against the real GuitarSet mic recordings (same notes).
acoustic: AST AudioSet P(Acoustic guitar); synth: P(Synthesizer)+P(Electronic music)
sim: cosine similarity of AST embeddings to the real recording (same 10 s window)
ltas: dB RMS difference of 1/3-octave long-term spectra (60 Hz - 12 kHz), level matched
"""
import json, os, sys, numpy as np, soundfile as sf, librosa, torch
from transformers import ASTFeatureExtractor, ASTForAudioClassification
S = os.environ["S"]
fe = ASTFeatureExtractor.from_pretrained("MIT/ast-finetuned-audioset-10-10-0.4593")
m = ASTForAudioClassification.from_pretrained("MIT/ast-finetuned-audioset-10-10-0.4593").eval()
files = json.load(open(f"{S}/gtr/eval/files.json"))
bands = 60 * 2 ** (np.arange(0, 24) / 3)

def windows(path):
    y, sr = sf.read(path)
    if y.ndim > 1: y = y.mean(1)
    y16 = librosa.resample(y, orig_sr=sr, target_sr=16000)
    out = []
    for a in range(0, max(1, len(y16) - 16000 * 10 + 1), 16000 * 10):
        w = y16[a:a + 160000]
        if np.sqrt(np.mean(w ** 2)) > 1e-3: out.append(w)
    return y, sr, out[:3]

@torch.no_grad()
def ast(ws):
    x = fe(ws, sampling_rate=16000, return_tensors="pt")
    o = m(**x, output_hidden_states=True)
    p = torch.sigmoid(o.logits).numpy()
    emb = o.hidden_states[-1][:, :2].mean(1).numpy()
    return p, emb

def ltas(y, sr):
    Sx = np.abs(librosa.stft(y, n_fft=4096, hop_length=1024)) ** 2
    f = librosa.fft_frequencies(sr=sr, n_fft=4096)
    p = Sx.mean(1)
    v = np.array([p[(f >= b / 2 ** (1 / 6)) & (f < b * 2 ** (1 / 6))].sum() for b in bands])
    db = 10 * np.log10(v + 1e-12)
    return db - db.mean()

cache = f"{S}/gtr/eval/ref.npz"
if os.path.exists(cache):
    R = dict(np.load(cache, allow_pickle=True))["R"].item()
else:
    R = {}
    for f in files:
        y, sr, ws = windows(f); p, e = ast(ws); R[f] = (p, e, ltas(y, sr))
    np.savez(cache, R=np.array(R, dtype=object))

def report(name, rows):
    a = np.mean([r[0] for r in rows]); s = np.mean([r[1] for r in rows]); sim = np.mean([r[2] for r in rows]); l = np.mean([r[3] for r in rows])
    print(f"{name:18s} acoustic {a:.3f}  guitar {np.mean([r[4] for r in rows]):.3f}  synth {s:.3f}  sim {sim:.3f}  ltas {l:5.2f} dB", flush=True)

report("REAL mic", [(R[f][0][:, 143].mean(), (R[f][0][:, 158] + R[f][0][:, 239]).mean(), 1, 0, R[f][0][:, 140].mean()) for f in files])
for name in sys.argv[1:]:
    rows = []
    for f in files:
        base = os.path.basename(f).replace("_mic.wav", "")
        y, sr, ws = windows(f"{S}/gtr/eval/{name}/{base}.wav")
        p, e = ast(ws)
        rp, re_, rl = R[f]
        k = min(len(e), len(re_))
        sim = np.mean([np.dot(e[i], re_[i]) / np.linalg.norm(e[i]) / np.linalg.norm(re_[i]) for i in range(k)])
        rows.append((p[:, 143].mean(), (p[:, 158] + p[:, 239]).mean(), sim, np.sqrt(np.mean((ltas(y, sr) - rl) ** 2)), p[:, 140].mean()))
    report(name, rows)
