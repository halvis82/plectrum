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

### Why YouTube audio is captured in the browser

YouTube blocks audio downloads from cloud IPs. Tested and confirmed on Vercel (with and without BotGuard PO tokens) and on GitHub Actions: every music video returns "Sign in to confirm you're not a bot". So the link flow embeds the video and records it in real time:

- **Desktop Chrome/Edge**: captures the tab's own audio (`getDisplayMedia`), the cleanest signal.
- **Phones and other browsers**: listens through the microphone.

Player time is polled during capture and the recording is re-laid onto the video timeline (`alignToVideo`), so ads, buffering and seeks are dropped and the saved chords line up with playback. Videos that block embedding (Vevo) automatically fall back to another upload of the same song.

**Spotify links** are matched to YouTube: the track page gives title and artist, then a YouTube search picks the audio. Record mode can also capture any browser tab (for example the Spotify web player).

**Lyrics** come from [LRCLIB](https://lrclib.net) (free, time-synced). Chords are placed over lyric lines by timestamp, with an offset control for versions whose timing differs.

## Accuracy checks

`npx tsx scripts/synth-test.mts [--mic]` synthesizes strummed guitar (real voicings, bass, kick) over a known progression with 7ths, sus and minor chords:

| | tempo | beats | root + maj/min | exact chord |
|---|---|---|---|---|
| clean | 99.7 / 100 | 128 / 128 | 100% | 75% |
| simulated phone mic | 99.8 / 100 | 128 / 128 | 96.9% | 75% |

`npx tsx scripts/analyze-file.mts audio.f32` prints a bar chart for any raw mono 22.05 kHz float32 file (`ffmpeg -i song.mp3 -ac 1 -ar 22050 -f f32le song.f32`).

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
