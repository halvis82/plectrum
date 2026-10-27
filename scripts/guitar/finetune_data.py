"""Training data for fine-tuning the guitar note model: every source resampled to 16 kHz, concatenated
into one float16 file (read as a memmap, so training never holds it all in memory), with an index of
notes per recording. Also a pool of band backing (every non-guitar stem of the BabySlakh songs used)
that training mixes under the guitar at random levels.

Held out (never written here): GuitarSet players 03-05, Guitar-TECHS player 3, EGDB clips 216+,
BabySlakh songs 13-20.
Usage: python finetune_data.py <scratch dir with guitarset/ techs/ egdb/ slakh/> <out dir>"""

import json
import os
import subprocess
import sys

import numpy as np
import pretty_midi
import yaml

SR = 16000
root, out = sys.argv[1:3]
os.makedirs(out, exist_ok=True)
audio = open(os.path.join(out, "audio.f16"), "wb")
index, pos = [], 0


def load(path, sr_in=None):
    """Any audio file (or raw float32 at sr_in) -> mono float32 at 16 kHz."""
    if sr_in:
        cmd = ["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(sr_in), "-ac", "1", "-i", path]
    else:
        cmd = ["ffmpeg", "-v", "error", "-i", path]
    raw = subprocess.run(cmd + ["-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.float32)


def add(name, source, y, notes):
    global pos
    peak = float(np.abs(y).max()) or 1.0
    audio.write((y / peak * 0.8).astype(np.float16).tobytes())
    notes = sorted([float(s), float(e), int(m)] for s, e, m in notes if 21 <= m <= 108 and e > s)
    index.append({"name": name, "source": source, "offset": pos, "length": len(y), "notes": notes})
    pos += len(y)


# GuitarSet players 00-02 (acoustic, mic)
gs = os.path.join(root, "guitarset")
for f in sorted(os.listdir(os.path.join(gs, "f32"))):
    if f[:2] not in ("00", "01", "02"):
        continue
    j = json.load(open(os.path.join(gs, "data", "ann", f.replace("_mic.f32", ".jams"))))
    notes = [(d["time"], d["time"] + d["duration"], round(d["value"])) for a in j["annotations"] if a["namespace"] == "note_midi" for d in a["data"]]
    add(f, "guitarset", load(os.path.join(gs, "f32", f), 22050), notes)
print("guitarset", len(index), flush=True)

# Guitar-TECHS players 1 and 2, every part, amp mic and direct input (MIDI ~22 ms late, see refs.py)
techs = os.path.join(root, "techs", "data")
for part in sorted(os.listdir(techs)):
    if not part.startswith(("P1_", "P2_")):
        continue
    for f in sorted(os.listdir(os.path.join(techs, part, "midi"))):
        if not f.endswith(".mid"):
            continue
        tag = f[len("midi_"):-4]
        notes = [(n.start - 0.022, n.end - 0.022, n.pitch) for i in pretty_midi.PrettyMIDI(os.path.join(techs, part, "midi", f)).instruments for n in i.notes]
        for chan in ("micamp", "directinput"):
            wav = os.path.join(techs, part, "audio", chan, f"{chan}_{tag}.wav")
            if os.path.exists(wav):
                add(f"{part}_{tag}_{chan}", "techs", load(wav), notes)
print("techs", len(index), flush=True)

# EGDB clips 1-215: direct input and two amp renderings
eg = os.path.join(root, "egdb")
for lf in sorted(os.listdir(os.path.join(eg, "audio_label")), key=lambda f: int(f.split(".")[0])):
    clip = int(lf.split(".")[0])
    if clip >= 216:
        continue
    notes = [(n.start, n.end, n.pitch) for i in pretty_midi.PrettyMIDI(os.path.join(eg, "audio_label", lf)).instruments for n in i.notes]
    for tone in ("DI", "Marshall", "Mesa"):
        wav = os.path.join(eg, f"audio_{tone}", f"{clip}.wav")
        if os.path.exists(wav):
            add(f"egdb_{clip}_{tone}", "egdb", load(wav), notes)
print("egdb", len(index), flush=True)

# BabySlakh songs 1-12: guitar stems as targets, everything else as backing
sl = os.path.join(root, "slakh", "babyslakh_16k")
backing = open(os.path.join(out, "backing.f16"), "wb")
bpos, bindex = 0, []
for t in sorted(os.listdir(sl))[:12]:
    meta = yaml.safe_load(open(os.path.join(sl, t, "metadata.yaml")))
    stems = {k: v for k, v in meta["stems"].items() if os.path.exists(os.path.join(sl, t, "stems", k + ".wav"))}
    gtr = [k for k, v in stems.items() if v.get("inst_class") == "Guitar"]
    rest = [k for k in stems if k not in gtr]
    for k in gtr:
        mid = os.path.join(sl, t, "MIDI", k + ".mid")
        if os.path.exists(mid):
            notes = [(n.start, n.end, n.pitch) for i in pretty_midi.PrettyMIDI(mid).instruments for n in i.notes]
            add(f"slakh_{t}_{k}", "slakh", load(os.path.join(sl, t, "stems", k + ".wav")), notes)
    if rest:
        ys = [load(os.path.join(sl, t, "stems", k + ".wav")) for k in rest]
        n = max(len(y) for y in ys)
        mix = np.zeros(n, np.float32)
        for y in ys:
            mix[: len(y)] += y
        mix /= float(np.abs(mix).max()) or 1.0
        backing.write((mix * 0.8).astype(np.float16).tobytes())
        bindex.append({"name": t, "offset": bpos, "length": n})
        bpos += n
print("slakh", len(index), "backing", len(bindex), flush=True)

audio.close()
backing.close()
json.dump(index, open(os.path.join(out, "index.json"), "w"))
json.dump(bindex, open(os.path.join(out, "backing.json"), "w"))
hours = sum(i["length"] for i in index) / SR / 3600
print(f"{len(index)} recordings, {hours:.1f} h, {sum(len(i['notes']) for i in index)} notes; backing {bpos / SR / 60:.0f} min")
