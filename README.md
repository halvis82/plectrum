# Plectrum

Guitar chords and tabs from any song. Paste a link (YouTube, Spotify, Apple Music, Deezer, SoundCloud, Bandcamp, Mixcloud, the Internet Archive, a direct audio file, or anything else [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports), upload a file, or record what's playing, and Plectrum works the chords out from the audio itself. Every result is saved to a public library.

Live: https://plectrum.vercel.app

## How it works

All audio analysis runs in the browser (a Web Worker), so there is no server compute and no cost per song.

1. **Audio in**: files and linked audio are decoded with Web Audio; Listen records the mic with an AudioWorklet (voice processing off) and shows live chords while it listens.
2. **Features**: a constant-Q transform identical to `librosa.cqt(sr=22050, n_bins=144, bins_per_octave=24, hop_length=2048)` on 10 s chunks, using a sparse kernel exported from librosa (`src/lib/analysis/cqt.ts`). Matches librosa to 0.02 mean abs log difference.
3. **Chords**: [BTC](https://github.com/jayg996/BTC-ISMIR19) (Bi-directional Transformer for Chord recognition, ISMIR 2019, MIT), large vocabulary: 12 roots x 14 qualities, exported to ONNX and run with `onnxruntime-web`.
4. **Beats**: spectral-flux onset envelope, autocorrelation tempo and Ellis dynamic-programming beat tracking (`beats.ts`).
5. **Sheet**: frame log-probs are averaged per beat and Viterbi-smoothed. A second pass makes chord changes cheaper on downbeats, after 3/4 vs 4/4 and the bar phase are picked. Noisy 7ths/sus chords fall back to the triad unless the model clearly prefers them (`decode.ts`).

Key detection (Krumhansl), capo suggestions (open-chord friendliness), transpose and simplify (All / 7ths / Basic) all run client-side from the stored analysis (`src/lib/music.ts`).

### Links

A pasted or typed link starts on its own. `/api/resolve` sorts it:

- **YouTube**: streamed through `/api/audio/:videoId` with range support (`src/lib/server/youtube-audio.ts`), which also plays the song back on its page.
- **Spotify, Apple Music, Deezer**: these have no downloadable audio, so the title, artist and length come from the track page, the iTunes lookup API or the Deezer API, and the song is fetched from YouTube.
- **Anything else**: `/api/media?url=` (`src/lib/server/media.ts`) asks the Python function `api/ytdlp.py` to extract the page with yt-dlp, then downloads the audio. Plain files are proxied in ranged chunks. HLS playlists are joined into one file, and MPEG-TS segments are unpacked to raw AAC or MP3, because browsers can't decode TS. Bandcamp shows yt-dlp a bot challenge, so its pages are read as a link-preview crawler instead. Copy-protected tracks (official SoundCloud uploads) are matched by title and length on YouTube.

YouTube blocks anonymous downloads from cloud IPs. `/api/audio` tries, in order:

1. YouTube itself, signed in with browser cookies in `YT_COOKIES_B64` when set, otherwise with device-flow OAuth tokens stored by `/api/admin/youtube-login`.
2. Public [Invidious](https://invidious.io) instances with their API enabled (from `api.invidious.io`, healthiest first), using `local=true` so the instance fetches the stream.
3. The client then tries up to three other uploads of the same song.
4. As a last resort, `/api/media?q=&title=&artist=&duration=` takes the first full-length SoundCloud copy whose title and length match. Remixes and other rearrangements are skipped, covers and live takes rank last, and the song page says which copy was used.

The YouTube search behind Spotify and similar links falls back to Invidious search the same way. Uploading the file or using Listen always works.

Songs without audio on the current device (uploaded or recorded elsewhere, or YouTube unreachable) get a silent play-along clock with a metronome click, so the sheet still follows the beat.

## Tabs: every note

Besides chords, every song gets a note-by-note tab: string, fret and timing for each note heard.

1. **Notes**: the guitar transcription model of Riley, Edwards and Dixon ("High resolution guitar transcription via domain adaptation", ICASSP 2024, MIT, [weights](https://huggingface.co/xavriley/midi-transcription-models), the `guitar-fl` checkpoint), a 24.7M parameter CRNN after Kong et al.'s piano model. It never trained on GuitarSet. Its post-processing is ported to TypeScript and matches the Python package note for note (`src/lib/analysis/guitar.ts`). The weights ship as float16 (49 MB, downloaded once and only when someone catches a song) and run as float32 on WebGPU when the device has it, otherwise on multi-threaded WebAssembly. The model reads 10 s windows that overlap by 1 s; the reference overlaps them by 5 s, which doubles the work for no measurable gain (identical note F1 on held-out GuitarSet players and mixes). A 4:17 song takes about 14 s on a Mac with WebGPU and about 45 s on WebAssembly alone.
2. **Which string**: a small CNN (2 MB, `scripts/strings/`) hears which string each note was played on from a pitch-aligned patch of its first 16 harmonics just after the onset; wound low strings sound darker and less harmonic than plain high strings at the same pitch. It is trained on GuitarSet (acoustic, mic) and EGDB (electric, clean DI plus five amp sounds; labels whose notes don't fit their string are skipped). Feature extraction in the browser matches the Python training code to 1e-7 (`src/lib/analysis/strings.ts`).
3. **Fingering**: notes that start together form an event. Each event's fingerings are scored for stretch, height on the neck, fit to common chord shapes (chords-db) and the string model's opinion, and a Viterbi pass over a 4-fret hand position keeps the hand still and avoids cutting off notes that are still ringing (`src/lib/tab.ts`).
4. **Tuning**: standard, half step down, Drop D, whole step down or Drop C. Pitches alone can't tell a song played half a step down from the same song in another key, so Auto only picks a lowered tuning on real evidence: notes below low E that come with their fifth (power chords), and no sign of a bass below them. On 360 GuitarSet recordings and 30 band mixes it never chose a lowered tuning by mistake. When low notes would drop out, the tab offers the lowered tunings in one tap. A lowered tuning also moves the chord shapes, like a negative capo.
5. **View**: one box per bar with chord names above, a live playhead, tap to play from a bar. Transpose moves the pitches and frets count from the capo.

A new song opens as soon as its chords are in (a few seconds), and its tab fills in on the song page while the notes are transcribed; the browser then saves them to the song with a one-time edit key. A link that is already in the library opens the saved song instead of being analyzed again.

Once the notes are in, the chords are decided again with them: each frame's chord scores get a bonus for the pitch classes actually ringing, a penalty for notes outside the chord and for chord tones never played, and a bass bonus (`src/lib/analysis/notechords.ts`, weight tuned on players 00-02 with `scripts/notechords-tune.mts`). On held-out players 03-05 the root accuracy goes from 72.9 to 74.1 and sevenths, scored against the chords actually played, from 57.4 to 66.4. Only 37% of the 7th chords shown were real before, so the sheet now shows basic chords by default (All and 7ths are one tap away).

The string model is also trained on GuitarSet re-recorded through simulated laptop and phone mics (band-limited, room reverb, noise, limiting). On held-out players through a phone-like mic, the right string goes from 76.5% to 80.1% on solos and 86.0% to 87.8% on comping, with clean recordings unchanged (89.7% solo, 92.9% comping).

Notes are stored with the song (`analysis.notes`, with each note's string probabilities), so the tab is recomputed instantly when transpose, capo or tuning change.

### Tab accuracy (GuitarSet)

Note onset within 50 ms and the right semitone. "String" is the share of correctly found notes on the player's string, and tab F1 counts a note only when its pitch and string are both right. Thresholds and costs were chosen on players 00-02 (with a string model that never saw them); players 03-05 are held out, and the string model scored here never saw them either.

| held-out players | note F1 | string right | tab F1 | before (Basic Pitch, fingering rules only): note F1 / string |
|---|---|---|---|---|
| comping (chords, arpeggios) | 89.2 | 92.7% | 82.7 | 73.4 / 72.5% |
| solos (single lines) | 91.4 | 89.7% | 82.0 | 87.3 / 43.4% |
| comping + bass and vocals at equal loudness | 86.0 | 87.3% | 75.1 | 69.1 / 70.1% |

On electric guitar (EGDB clips 216-241, never trained on) the string model alone is right for 86% of notes on the clean DI and 77% through high-gain amps; trained on GuitarSet only it managed 57 to 61%.

```bash
npx tsx scripts/guitar/bench.mts <f32 dir> <model.onnx> <out dir>      # caches activations (export.py --single)
NOTES=guitar STRINGS=<strings.onnx> F32=<f32 dir> npx tsx scripts/tab-score.mts <out dir> <jams dir> ['{"notes":{..},"tab":{..}}'] [comp|solo]
npx tsx scripts/tuning-test.mts <out dir>                               # tuning detection on shifted GuitarSet
python scripts/strings/build.py <f32 dir> <jams dir> gs.npz 3           # string model data
python scripts/strings/build_egdb.py <egdb dir> egdb.npz
python scripts/strings/train.py out.pt 12 gs.npz:012 egdb.npz:egdb [--all] && python scripts/strings/export.py out.pt strings.onnx
python scripts/guitar/export.py guitar-fl.pth <dir> guitar           # browser model: guitar.onnx + guitar.f16
```

## Chord accuracy

### Real acoustic guitar: GuitarSet

All 180 comping excerpts of [GuitarSet](https://zenodo.org/records/3371780) (CC BY 4.0, 6 players x 5 styles, mic recordings) scored with mir_eval against the instructed chords. Decoder settings were tuned on players 00-02; players 03-05 are held out:

| beat-level sheet | root | majmin | sevenths | mirex |
|---|---|---|---|---|
| tuning half | 87.9 | 82.6 | 74.7 | 79.7 |
| held-out half | 72.5 | 71.4 | 62.7 | 70.8 |
| held-out, before tuning | 70.4 | 69.5 | 60.9 | 69.0 |
| held-out, with note evidence | 74.1 | 71.9 | 59.1 | 72.7 |

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

`node scripts/e2e-links.mjs <url> <screenshot dir> <link> [<link> ...]` pastes each link, waits for the song page, and reports the time, the number of tab bars, whether the audio loads, and which fallback copy was used, if any.

## Development

```bash
npm install
vercel env pull .env.local   # DATABASE_URL (Neon) etc.
npm run dev
# the yt-dlp function, for /api/media during local development:
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python api/ytdlp.py 5328 &   # then run next with YTDLP_URL=http://127.0.0.1:5328/
```

- Database: Neon Postgres via the Vercel Marketplace. Schema in `scripts/schema.sql`.
- Model files in `public/model/`: the BTC files are produced by `scripts/export_model.py` from a BTC checkout. `guitar.v1.onnx` and `guitar.v1.f16` come from `scripts/guitar/export.py`, `strings.v1.onnx` from `scripts/strings/`. `basicpitch.v1.onnx` (`nmp.onnx` from the basic-pitch 0.4.0 wheel) is no longer used by the app and stays for the before/after benchmark.
- Chord diagrams come from [@tombatossals/chords-db](https://github.com/tombatossals/chords-db) (MIT) via `scripts/extract-shapes.mjs`.

## API

| Route | |
|---|---|
| `GET /api/resolve?url=` | link to `{ kind, videoId, title, artist, alternatives, duration }`; `kind: "web"` means use `/api/media` |
| `GET /api/resolve?title=&artist=&duration=&url=` | YouTube uploads of a named song |
| `GET /api/media?url=` | audio from any page yt-dlp supports, described in the `x-media` header |
| `GET /api/media?q=&title=&artist=&duration=` | best full-length SoundCloud copy of a song |
| `GET /api/ytdlp?url=` or `?q=` | Python yt-dlp extractor, needs header `x-key: $ADMIN_TOKEN` |
| `GET /api/songs?q=` | library search |
| `POST /api/songs` | save an analysis |
| `PATCH /api/songs/:id` | rename (public) |
| `DELETE /api/songs/:id` | needs header `x-admin-token: $ADMIN_TOKEN` |
| `GET /api/lyrics?title=&artist=&duration=` | LRCLIB lookup |
| `GET /api/audio/:videoId` | YouTube audio stream (range requests) |
