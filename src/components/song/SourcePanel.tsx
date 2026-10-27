"use client";

import type { SongData } from "./SongView";

export type LyricsInfo = { kind: "lrclib"; track: string; artist: string; synced: boolean } | { kind: "youtube" } | { kind: "transcribed"; lang?: string | null } | null;

const SITE: Record<string, string> = {
  youtube: "YouTube",
  spotify: "Spotify",
  apple: "Apple Music",
  deezer: "Deezer",
  soundcloud: "SoundCloud",
  bandcamp: "Bandcamp",
  web: "a web link",
};

/** Where everything on the page came from: the audio, the lyrics, the tab. */
export function SourcePanel({ song, lyrics, edited, playback }: { song: SongData; lyrics: LyricsInfo | "loading"; edited: boolean; playback: string }) {
  const date = (s: string | null | undefined) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null);
  const yt = song.youtube_id ? `https://www.youtube.com/watch?v=${song.youtube_id}` : null;
  let origin: React.ReactNode;
  if (song.source === "record") origin = <>Recorded with the microphone{date(song.created_at) ? `, ${date(song.created_at)}` : ""}</>;
  else if (song.source === "upload") origin = <>Uploaded file</>;
  else if (song.source === "scratch") origin = <>Written from scratch here</>;
  else if (song.source === "youtube" && yt) origin = <A href={yt}>YouTube video</A>;
  else
    origin = (
      <>
        {song.source_url ? <A href={song.source_url}>{SITE[song.source] ?? song.source} link</A> : SITE[song.source] ?? song.source}
        {yt && song.source !== "youtube" && (
          <>
            , played from <A href={yt}>this YouTube upload</A> of it
          </>
        )}
        {!yt && song.audio_url && song.audio_url !== song.source_url && (
          <>
            , played from <A href={song.audio_url}>{new URL(song.audio_url).hostname.replace(/^www\./, "")}</A>
          </>
        )}
      </>
    );

  const lyricRow =
    lyrics === "loading" ? (
      "Looking…"
    ) : !lyrics ? (
      "None found"
    ) : lyrics.kind === "lrclib" ? (
      <>
        <A href={`https://lrclib.net/search/${encodeURIComponent(`${lyrics.artist} ${lyrics.track}`)}`}>LRCLIB</A>: {lyrics.track} by {lyrics.artist}
        {lyrics.synced ? ", timed" : ", not timed"}
      </>
    ) : lyrics.kind === "youtube" ? (
      "The video's own captions"
    ) : (
      <>Transcribed from the audio on this site{lyrics.lang ? ` (${lyrics.lang})` : ""}</>
    );

  return (
    <details className="group mt-8 rounded-2xl border border-line bg-surface">
      <summary className="cursor-pointer list-none px-4 py-3 flex items-center justify-between text-sm font-medium">
        About this song
        <span className="text-muted transition group-open:rotate-180" aria-hidden>
          ▾
        </span>
      </summary>
      <dl className="px-4 pb-4 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted">Source</dt>
        <dd className="min-w-0 break-words">{origin}</dd>
        <dt className="text-muted">Playback</dt>
        <dd>{playback}</dd>
        <dt className="text-muted">Lyrics</dt>
        <dd className="min-w-0 break-words">{lyricRow}</dd>
        <dt className="text-muted">Chords and tab</dt>
        <dd>
          {song.source === "scratch"
            ? "Written by hand"
            : "Recognized from the audio in the browser: chords with BTC (ISMIR 2019), notes with Riley et al. (ICASSP 2024), strings with a model trained on GuitarSet, EGDB and Guitar-TECHS"}
          {edited && song.source !== "scratch" ? ", then edited by hand" : ""}
        </dd>
        <dt className="text-muted">Length</dt>
        <dd className="tabular-nums">
          {Math.floor(song.analysis.duration / 60)}:{String(Math.round(song.analysis.duration % 60)).padStart(2, "0")}
        </dd>
        <dt className="text-muted">Added</dt>
        <dd>{date(song.created_at) ?? "Unknown"}</dd>
        {song.updated_at && song.updated_at !== song.created_at && (
          <>
            <dt className="text-muted">Last changed</dt>
            <dd>{date(song.updated_at)}</dd>
          </>
        )}
        <dt className="text-muted">Views</dt>
        <dd className="tabular-nums">{song.views}</dd>
      </dl>
    </details>
  );
}

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:decoration-accent">
      {children}
    </a>
  );
}
