# ChordCatch

Guitar chords from any song. Paste a YouTube or Spotify link, upload a file, or record what's playing, and ChordCatch works the chords out from the audio itself. Every result is saved to a public library.

Live: https://chordcatch-seven.vercel.app

## How it works

All audio analysis runs in the browser (a Web Worker), so there is no server compute and no cost per song.

1. **Audio in**: files and linked audio are decoded with Web Audio; Listen records the mic with an AudioWorklet (voice processing off) and shows live chords while it listens.
2. **Features**: a constant-Q transform identical to `librosa.cqt(sr=22050, n_bins=144, bins_per_octave=24, hop_length=2048)` on 10 s chunks, using a sparse kernel exported from librosa (`src/lib/analysis/cqt.ts`). Matches librosa to 0.02 mean abs log difference.
3. **Chords**: [BTC](https://github.com/jayg996/BTC-ISMIR19) (Bi-directional Transformer for Chord recognition, ISMIR 2019, MIT), large vocabulary: 12 roots x 14 qualities, exported to ONNX and run with `onnxruntime-web`.
4. **Beats**: spectral-flux onset envelope, autocorrelation tempo and Ellis dynamic-programming beat tracking (`beats.ts`).
5. **Sheet**: frame log-probs are averaged per beat and Viterbi-smoothed. A second pass makes chord changes cheaper on downbeats, after 3/4 vs 4/4 and the bar phase are picked. Noisy 7ths/sus chords fall back to the triad unless the model clearly prefers them (`decode.ts`).

Key detection (Krumhansl), capo suggestions (open-chord friendliness), transpose and simplify (All / 7ths / Basic) all run client-side from the stored analysis (`src/lib/music.ts`).

### Links

A pasted or typed link starts on its own. The server resolves it (YouTube oEmbed, or Spotify's track page for title and artist, then a YouTube search), streams the audio through `/api/audio/:videoId` with range support (`src/lib/server/youtube-audio.ts`), and the browser analyzes it. The same route plays the song back on its page.

YouTube blocks anonymous downloads from cloud IPs (tested on Vercel with and without BotGuard PO tokens, on GitHub Actions, and through public Invidious, Piped and cobalt instances). The server therefore signs in: with browser cookies in `YT_COOKIES_B64` when set, otherwise with device-flow OAuth tokens stored by `/api/admin/youtube-login`. With OAuth only some uploads stream (others answer 403), so when the first video fails the app tries other uploads of the same song. Uploading the file or using Listen always works.

**Lyrics** come from [LRCLIB](https://lrclib.net) (free, time synced). Chords are placed over lyric lines by timestamp, with an offset control for versions whose timing differs.

Songs without audio on the current device (uploaded or recorded elsewhere, or YouTube unreachable) get a silent play-along clock with a metronome click, so the sheet still follows the beat.

## Tabs: every note

Besides chords, every song gets a note-by-note tab: string, fret and timing for each note heard.

1. **Notes**: [Basic Pitch](https://github.com/spotify/basic-pitch) (Spotify, ICASSP 2022, Apache-2.0), a 230 KB ONNX model that runs in the same worker. Windowing and note decoding are ported from the Python package and match it note for note (`src/lib/analysis/notes.ts`).
2. **Strings and frets**: notes that start together form an event. Each event's possible fingerings are scored for stretch, height on the neck and fit to common chord shapes (chords-db), and a Viterbi pass over a 4-fret hand position keeps the hand still and avoids cutting off notes that are still ringing (`src/lib/tab.ts`). Open strings are cost-neutral so rock riffs keep them.
3. **View**: one box per bar with chord names above, a live playhead, tap to play from a bar. Transpose moves the pitches and frets count from the capo.

Notes are stored with the song (`analysis.notes`), so the tab is recomputed instantly when transpose or capo change.

### Tab accuracy (GuitarSet)

Note onset within 50 ms and the right semitone; "string" means the chosen string matches the player's. Costs and thresholds were fitted on players 00-02, players 03-05 are held out. GuitarSet is in Basic Pitch's training data, so note scores there are optimistic.

| held-out players | note F1 | string right (of notes found) |
|---|---|---|
| comping (chords, arpeggios) | 73.4 | 72.5 |
| solos (single lines) | 87.3 | 43.4 |
| comping + bass and vocals at equal loudness | 69.1 | 70.1 |

For solos the same notes can be played in several places on the neck and players differ, so the tab is playable and right in pitch and rhythm but often in a different position than the original. Isolating the guitar first with Demucs (htdemucs_6s) only won back 1.8 points of note F1 in the mixed test, not worth a 136 MB model and minutes per song.

```bash
npx tsx scripts/notes-bench.mts <f32 dir> <out dir>                    # transcribe, caches activations
npx tsx scripts/tab-score.mts <out dir> <jams dir> ['{"notes":{..},"tab":{..}}'] [comp|solo]
npx tsx scripts/tab-sweep.mts <jams dir> [trials] [min fretted cost]   # fingering cost search
```

## Chord accuracy

### Real acoustic guitar: GuitarSet

All 180 comping excerpts of [GuitarSet](https://zenodo.org/records/3371780) (CC BY 4.0, 6 players x 5 styles, mic recordings) scored with mir_eval against the instructed chords. Decoder settings were tuned on players 00-02; players 03-05 are held out:

| beat-level sheet | root | majmin | sevenths | mirex |
|---|---|---|---|---|
| tuning half | 87.9 | 82.6 | 74.7 | 79.7 |
| held-out half | 72.5 | 71.4 | 62.7 | 70.8 |
| held-out, before tuning | 70.4 | 69.5 | 60.9 | 69.0 |

What helped: pitch-shift test-time augmentation (the model also hears the audio +-1 semitone and the predictions are rotated back and averaged), a "no chord" penalty that stops muted strumming from reading as silence (gated off for genuinely quiet audio), and lighter change penalties. Singer-songwriter and rock styles score highest; funk and jazz voicings are hardest.

```bash
npx tsx scripts/guitarset-bench.mts <f32 dir> <out dir>              # full pipeline per file
python -I scripts/guitarset-score.py <jams dir> <out dir>             # detailed report
npx tsx scripts/guitarset-tune.mts <f32 dir> <out root> -1,0,1        # decoder sweep
python -I scripts/guitarset-sweep.py <jams dir> <out root>            # tuning vs held-out table
```

### Synthetic check

`npx tsx scripts/synth-test.mts [--mic]` synthesizes strummed guitar over a known progression. Tempo comes out 99.7 vs 100 BPM with all 128 beats found, and root plus major/minor is 100% both clean and through a simulated phone mic.

`npx tsx scripts/analyze-file.mts audio.f32` prints a bar chart for any raw mono 22.05 kHz float32 file (`ffmpeg -i song.mp3 -ac 1 -ar 22050 -f f32le song.f32`).

### End to end

`ADMIN_TOKEN=... node scripts/e2e.mjs <url> <fake-mic.wav> <song file> <screenshot dir>` drives headless Chromium through pasted links (YouTube, a Vevo video, Spotify), a typed link, upload, Listen on a phone, the play-along fallback and a bad link, and checks the tab has notes. It feeds a fake microphone from a WAV file, so no OS prompts are triggered.

## Development

```bash
npm install
vercel env pull .env.local   # DATABASE_URL (Neon) etc.
npm run dev
```

- Database: Neon Postgres via the Vercel Marketplace. Schema in `scripts/schema.sql`.
- Model files in `public/model/`: the BTC files are produced by `scripts/export_model.py` from a BTC checkout. `basicpitch.v1.onnx` is `nmp.onnx` from the basic-pitch 0.4.0 wheel.
- Chord diagrams come from [@tombatossals/chords-db](https://github.com/tombatossals/chords-db) (MIT) via `scripts/extract-shapes.mjs`.

## API

| Route | |
|---|---|
| `GET /api/resolve?url=` | YouTube/Spotify link to `{ videoId, title, artist, alternatives }` |
| `GET /api/songs?q=` | library search |
| `POST /api/songs` | save an analysis |
| `PATCH /api/songs/:id` | rename (public) |
| `DELETE /api/songs/:id` | needs header `x-admin-token: $ADMIN_TOKEN` |
| `GET /api/lyrics?title=&artist=&duration=` | LRCLIB lookup |
| `GET /api/audio/:videoId` | YouTube audio stream (range requests) |
