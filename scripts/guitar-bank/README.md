# Guitar note bank (public/guitar/v1)

The guitar that plays tabs back is built from GuitarSet (CC BY 4.0): each string's own pickup track,
colored by a body, room and microphone filter fit to GuitarSet's mic recordings. Work dir `$S` holds
GuitarSet (`guitarset/data/{audio,ann}`) and these scripts' outputs under `$S/gtr`.

1. `fetch.py 00,01,02 90` (in `$S/gtr/hex`): per-string pickup files for players 00 to 02, by range requests.
2. `fit.py`: the 6-in, 1-out filter from pickup to mic (`NFFT=32768`).
3. `bank.py`: per string and fret, the longest-ringing note that is at least 90% on its own harmonics.
4. `pack.py` (`PICK=0.15 SMOOTH=0.17 EQ=eq.json KBPS=96k`): render, tune, level, pack to `bank.mp3` and `bank.json`.
5. `eqfit.py`: the corrective EQ, fit on renders of players 00 to 02 only.
6. Scoring on held-out players 03 to 05: `render_bank.py` (or the app's own synth in Chrome), `post.py`, `score.py`
   (AudioSet "Acoustic guitar" probability, AST embedding similarity, long-term spectrum error).

Held-out results (24 excerpts): real mic 0.60 acoustic, the previous Karplus-Strong synth 0.05, the best
free sample set (FreePats nylon) 0.39, this bank through the app's synth 0.52 (similarity 0.78 vs 0.53).
