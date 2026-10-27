"""Builds evaluation sets in one format: <name>.f32 (mono float32, 22.05 kHz) and <name>.json
(reference notes [[start, end, midi, string]], string 0 = low E, -1 when unknown).
Usage:
  python refs.py techs <Guitar-TECHS part dir, e.g. P3_music> <out dir> [micamp|directinput] [max seconds]
  python refs.py slakh <babyslakh_16k dir> <out dir> [mix|guitar]   (mix: full band; guitar: guitar stems only)
  python refs.py guitarset <f32 dir> <out dir> <jams dir> <players, e.g. 345>   (f32 files named like GuitarSet's)
  python refs.py egdb <egdb dir> <out dir> <tones, e.g. DI,Marshall> <first clip>"""

import json
import os
import subprocess
import sys

import numpy as np
import pretty_midi
import yaml

STRINGS = {"E": 0, "A": 1, "D": 2, "G": 3, "B": 4, "e": 5}
# the hexaphonic MIDI pickup reports notes this late (median over the excerpts, scripts/eval/offsets.mts)
TECHS_DELAY = 0.022


def to_f32(src, dst, max_s=None):
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", src, "-ac", "1", "-ar", "22050"]
    if max_s:
        cmd += ["-t", str(max_s)]
    subprocess.run(cmd + ["-f", "f32le", dst], check=True)


def mix_f32(srcs, dst):
    ys = []
    for s in srcs:
        out = subprocess.run(["ffmpeg", "-v", "error", "-i", s, "-ac", "1", "-ar", "22050", "-f", "f32le", "-"], check=True, capture_output=True).stdout
        ys.append(np.frombuffer(out, np.float32))
    n = max(len(y) for y in ys)
    y = np.zeros(n, np.float32)
    for x in ys:
        y[: len(x)] += x
    y.tofile(dst)


kind, src, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
if kind == "techs":
    chan = sys.argv[4] if len(sys.argv) > 4 else "micamp"
    max_s = float(sys.argv[5]) if len(sys.argv) > 5 else None
    part = os.path.basename(src.rstrip("/"))
    for f in sorted(os.listdir(os.path.join(src, "midi"))):
        if not f.endswith(".mid"):
            continue
        tag = f[len("midi_"):-4]
        wav = os.path.join(src, "audio", chan, f"{chan}_{tag}.wav")
        if not os.path.exists(wav):
            continue
        name = f"techs_{part}_{tag}_{chan}"
        to_f32(wav, os.path.join(out, name + ".f32"), max_s)
        notes = []
        for inst in pretty_midi.PrettyMIDI(os.path.join(src, "midi", f)).instruments:
            s = STRINGS.get(inst.name.strip())
            if s is None:
                raise SystemExit(f"unknown track {inst.name!r} in {f}")
            notes += [[n.start - TECHS_DELAY, n.end - TECHS_DELAY, n.pitch, s] for n in inst.notes if not max_s or n.start < max_s]
        json.dump(sorted(notes), open(os.path.join(out, name + ".json"), "w"))
        print(name, len(notes), "notes")
elif kind == "guitarset":
    jams, players = sys.argv[4], sys.argv[5]
    for f in sorted(os.listdir(src)):
        if not f.endswith(".f32") or f[1] not in players:
            continue
        j = json.load(open(os.path.join(jams, f.replace("_mic.f32", ".jams"))))
        notes = [[d["time"], d["time"] + d["duration"], round(d["value"]), int(a["annotation_metadata"]["data_source"])] for a in j["annotations"] if a["namespace"] == "note_midi" for d in a["data"]]
        os.symlink(os.path.join(src, f), os.path.join(out, f)) if not os.path.exists(os.path.join(out, f)) else None
        json.dump(sorted(notes), open(os.path.join(out, f[:-4] + ".json"), "w"))
elif kind == "egdb":
    tones, first = sys.argv[4].split(","), int(sys.argv[5])
    for lf in sorted(os.listdir(os.path.join(src, "audio_label")), key=lambda f: int(f.split(".")[0])):
        clip = int(lf.split(".")[0])
        if clip < first:
            continue
        notes = []
        for k, inst in enumerate(pretty_midi.PrettyMIDI(os.path.join(src, "audio_label", lf)).instruments):
            num = int(inst.name.strip()) if inst.name.strip().isdigit() else k + 1
            notes += [[n.start, n.end, n.pitch, 6 - num] for n in inst.notes]
        # labels whose notes don't fit their string have unusable string numbers (see build_egdb.py)
        if any(not 0 <= m - [40, 45, 50, 55, 59, 64][s] <= 24 for _, _, m, s in notes if 0 <= s < 6):
            notes = [[a, b, m, -1] for a, b, m, _ in notes]
        for tone in tones:
            wav = os.path.join(src, f"audio_{tone}", f"{clip}.wav")
            if os.path.exists(wav):
                to_f32(wav, os.path.join(out, f"egdb_{clip}_{tone}.f32"))
                json.dump(sorted(notes), open(os.path.join(out, f"egdb_{clip}_{tone}.json"), "w"))
elif kind == "slakh":
    what = sys.argv[4] if len(sys.argv) > 4 else "mix"
    for t in sorted(os.listdir(src)):
        d = os.path.join(src, t)
        meta = yaml.safe_load(open(os.path.join(d, "metadata.yaml")))
        gtr = [k for k, v in meta["stems"].items() if v.get("inst_class") == "Guitar" and os.path.exists(os.path.join(d, "MIDI", k + ".mid"))]
        if not gtr:
            continue
        notes = []
        for k in gtr:
            for inst in pretty_midi.PrettyMIDI(os.path.join(d, "MIDI", k + ".mid")).instruments:
                notes += [[n.start, n.end, n.pitch, -1] for n in inst.notes]
        name = f"slakh_{t}_{what}"
        if what == "mix":
            to_f32(os.path.join(d, "mix.wav"), os.path.join(out, name + ".f32"))
        else:
            mix_f32([os.path.join(d, "stems", k + ".wav") for k in gtr], os.path.join(out, name + ".f32"))
        json.dump(sorted(notes), open(os.path.join(out, name + ".json"), "w"))
        print(name, len(gtr), "guitars", len(notes), "notes", [meta["stems"][k]["midi_program_name"] for k in gtr])
