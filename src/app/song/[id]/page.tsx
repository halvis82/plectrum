import type { Metadata } from "next";
import { Suspense } from "react";
import { SongHeader } from "@/components/SongHeader";
import { SongView } from "@/components/song/SongView";
import { LocalSong } from "@/components/song/LocalSong";
import { getSong } from "@/lib/server/db";

export async function generateMetadata({ params }: PageProps<"/song/[id]">): Promise<Metadata> {
  const { id } = await params;
  const song = await getSong(id);
  return { title: song ? `${song.title}${song.artist ? ` · ${song.artist}` : ""} chords` : "Song" };
}

async function Song({ params }: { params: PageProps<"/song/[id]">["params"] }) {
  const { id } = await params;
  const song = await getSong(id);
  // just made on this device and still being saved (or the save failed): shown from the device
  if (!song) return <LocalSong id={id} />;
  return (
    <>
      <SongHeader id={song.id} title={song.title} artist={song.artist} />
      <Suspense fallback={<div className="h-96" />}>
        <SongView song={song} />
      </Suspense>
    </>
  );
}

export default function Page({ params }: PageProps<"/song/[id]">) {
  return (
    <Suspense fallback={<p className="text-muted text-sm">Loading…</p>}>
      <Song params={params} />
    </Suspense>
  );
}
