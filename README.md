# ChordCatch

Guitar chords from any song. Paste a YouTube or Spotify link, upload a file, or record what's playing, and ChordCatch works the chords out from the audio itself. Every result is saved to a public library.

Live: https://chordcatch-seven.vercel.app

## How it works

All audio analysis runs in the browser (a Web Worker), so there is no server compute and no cost per song.

1. **Audio in**: files are decoded with Web Audio; recordings use `MediaRecorder` on the mic (voice processing off) or on a captured browser tab.
2. **Features**: a constant-Q transform identical to `librosa.cqt(sr=22050, n_bins=144, bins_per_octave=24, hop_length=2048)` on 10 s chunks, using a sparse kernel exported from librosa (`src/lib/analysis/cqt.ts`). Matches librosa to 0.02 mean abs log difference.
3. **Chords**: [BTC](https://github.com/jayg996/BTC-ISMIR19) (Bi-directional Transformer for Chord recognition, ISMIR 2019, MIT), large vocabulary: 12 roots x 14 qualities, exported to ONNX and run with `onnxruntime-web`.
4. **Beats**: spectral-flux onset envelope, autocorrelation tempo and Ellis dynamic-programming beat tracking (`beats.ts`).
5. **Sheet**: frame log-probs are averaged per beat and Viterbi-smoothed. A second pass makes chord changes cheaper on downbeats, after 3/4 vs 4/4 and the bar phase are picked. Noisy 7ths/sus chords fall back to the triad unless the model clearly prefers them (`decode.ts`).

Key detection (Krumhansl), capo suggestions (open-chord friendliness), transpose and simplify (All / 7ths / Basic) all run client-side from the stored analysis (`src/lib/music.ts`).

### Links: paste and it plays

YouTube blocks audio downloads from cloud IPs. This was tested on Vercel (with and without BotGuard PO tokens), on GitHub Actions, and through public Invidious, Piped and cobalt instances. Every one hits "Sign in to confirm you're not a bot", is down, or needs auth. So a pasted link plays in an embedded player while ChordCatch listens:

- **Paste is the only step.** The paste itself is the user gesture, so the browser's share prompt opens at once while the link resolves. A typed link resolves on its own and shows a single Start button.
- **Desktop Chrome/Edge** captures this tab's audio (`getDisplayMedia`). Phones and other browsers listen through the mic.
- **Live chords** appear about 2 s after the music starts. The model runs on a sliding 10 s window every 1.5 s, so you can play along during the capture.
- **Silent intros are skipped** (tab capture is digitally silent there), and capture stops on its own when a video's outro goes quiet.
- The player is driven over the embed's postMessage protocol on youtube-nocookie.com (`src/lib/youtube.ts`), with no `www.youtube.com/iframe_api`. It works on networks or hosts files that block youtube.com.
- Player time is polled during capture and the recording is re-laid onto the video timeline (`alignToVideo`), so ads, buffering and seeks drop out and saved chords line up with playback.
- Videos that block embedding (Vevo) fall through to other uploads of the same song. That search only runs when needed, so the common case is fast.

**Spotify links** are matched to YouTube: the track page gives title and artist, then a YouTube search picks the audio. "Catch that tab" records any other tab, for example the Spotify web player.

**Lyrics** come from [LRCLIB](https://lrclib.net) (free, time synced). Chords are placed over lyric lines by timestamp, with an offset control for versions whose timing differs.

Songs without audio on the current device (uploaded or recorded elsewhere, or YouTube unreachable) get a silent play-along clock with a metronome click, so the sheet still follows the beat.

## Accuracy

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

`ADMIN_TOKEN=... node scripts/e2e.mjs <url> <fake-mic.wav> <song file> <screenshot dir>` drives headless Chromium through paste-to-capture (YouTube, a Vevo-blocked video, Spotify), a typed link, upload, Listen on a phone, the play-along fallback and a bad link. It feeds a fake microphone from a WAV file, so no OS capture prompts are triggered. The app never offers tab capture to HeadlessChrome.

## Development

```bash
npm install
vercel env pull .env.local   # DATABASE_URL (Neon) etc.
npm run dev
```

- Database: Neon Postgres via the Vercel Marketplace. Schema in `scripts/schema.sql`.
- Model files in `public/model/` are produced by `scripts/export_model.py` from a BTC checkout.
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
