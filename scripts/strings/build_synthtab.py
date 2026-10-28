"""String-classification patches from SynthTab audio (sampled by its fetch script) with the per-string
MIDI from its JAMS/MIDI archive. Each track is put through a random room, microphone EQ and noise first,
so the clean renders sound more like real recordings.
Usage: python build_synthtab.py <audio dir (timbre/track.flac)> <midi dir (outall/track/string_k.mid)> <out.npz> [notes per track] [workers]"""

import glob
import json
import os
import sys
from multiprocessing import Pool

import numpy as np
import pretty_midi
import soundfile as sf
from scipy.signal import butter, fftconvolve, resample_poly, sosfilt

sys.path.insert(0, os.path.dirname(__file__))
from features import SR, patch  # noqa: E402

STANDARD = [40, 45, 50, 55, 59, 64]
AUDIO, MIDI, OUT = sys.argv[1:4]
PER_TRACK = int(sys.argv[4]) if len(sys.argv) > 4 else 150
# measured against spectral-flux onsets: the renders start about 10 ms before the MIDI says
LEAD = -0.01


def room(y, rng):
    rt60 = rng.uniform(0.15, 0.9)
    n = int(rt60 * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal(n) * np.exp(-6.9 * t / rt60)
    ir[: int(0.003 * SR)] = 0
    ir *= rng.uniform(0.05, 0.6) / np.sqrt((ir**2).sum())
    ir[0] = 1.0
    return fftconvolve(y, ir)[: len(y)]


def mic(y, rng):
    if rng.random() < 0.8:
        y = sosfilt(butter(2, rng.uniform(60, 250), "highpass", fs=SR, output="sos"), y)
    if rng.random() < 0.7:
        y = sosfilt(butter(2, rng.uniform(3500, 10000), "lowpass", fs=SR, output="sos"), y)
    if rng.random() < 0.5:
        # a resonance or dip somewhere in the body/mic range
        f = rng.uniform(150, 3000)
        b = butter(2, [f / 1.3, f * 1.3], "bandpass", fs=SR, output="sos")
        y = y + rng.uniform(-0.5, 0.8) * sosfilt(b, y)
    if rng.random() < 0.4:
        y = np.tanh(y / (np.abs(y).max() + 1e-9) * rng.uniform(1, 3))
    y = y / (np.abs(y).max() + 1e-9)
    if rng.random() < 0.8:
        y = y + rng.standard_normal(len(y)) * 10 ** (rng.uniform(-65, -30) / 20)
    return y.astype(np.float32)


def track(job):
    path, timbre_id = job
    name = os.path.basename(path)[:-5]
    d = os.path.join(MIDI, "outall", name)
    try:
        j = json.load(open(glob.glob(os.path.join(d, "*.jams"))[0]))
        tun = {a["sandbox"]["string_index"]: a["sandbox"]["open_tuning"] for a in j["annotations"] if a["namespace"] == "note_tab"}
        if [tun.get(6 - s) for s in range(6)] != STANDARD:
            return None
        notes = []
        for k in range(1, 7):
            f = os.path.join(d, f"string_{k}.mid")
            if not os.path.exists(f):
                continue
            for inst in pretty_midi.PrettyMIDI(f).instruments:
                for n in inst.notes:
                    fret = n.pitch - STANDARD[6 - k]
                    if n.pitch > 30 and 0 <= fret <= 20:
                        notes.append((n.start + LEAD, n.pitch, 6 - k))
        if len(notes) < 10:
            return None
        y, sr = sf.read(path, dtype="float32")
        if y.ndim > 1:
            y = y.mean(1)
        y = resample_poly(y, SR, sr).astype(np.float32)
        rng = np.random.default_rng(abs(hash(name)) % 2**32)
        y = mic(room(y, rng), rng) if rng.random() < 0.85 else y / (np.abs(y).max() + 1e-9)
        pick = rng.choice(len(notes), min(PER_TRACK, len(notes)), replace=False)
        cache = {}
        X, S, M = [], [], []
        for i in sorted(pick):
            t, m, s = notes[i]
            if t < 0 or t * SR > len(y) - SR // 10:
                continue
            X.append(patch(y, t + rng.uniform(-0.02, 0.02), m, cache).astype(np.float16))
            S.append(s)
            M.append(m)
        return np.stack(X), np.array(S, np.int8), np.array(M, np.int8), timbre_id
    except Exception as e:
        print("skip", name, repr(e)[:120], flush=True)
        return None


if __name__ == "__main__":
    timbres = sorted(os.listdir(AUDIO))
    jobs = [(f, ti) for ti, t in enumerate(timbres) for f in sorted(glob.glob(os.path.join(AUDIO, t, "*.flac")))]
    X, S, M, P, F = [], [], [], [], []
    with Pool(int(sys.argv[5]) if len(sys.argv) > 5 else 4) as pool:
        for k, r in enumerate(pool.imap_unordered(track, jobs, chunksize=4)):
            if r:
                X.append(r[0]); S.append(r[1]); M.append(r[2])
                P.append(np.full(len(r[1]), 100 + r[3], np.int16)); F.append(np.full(len(r[1]), k, np.int32))
            if k % 200 == 0:
                print(k, len(jobs), sum(len(s) for s in S), flush=True)
    np.savez(OUT, X=np.concatenate(X), s=np.concatenate(S), midi=np.concatenate(M), player=np.concatenate(P), solo=np.zeros(sum(len(s) for s in S), np.int8), fid=np.concatenate(F), timbres=np.array(timbres))
    print("notes", sum(len(s) for s in S), "tracks", len(S))
