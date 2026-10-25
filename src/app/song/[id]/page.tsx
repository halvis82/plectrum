import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SongHeader } from "@/components/SongHeader";
import { SongView } from "@/components/SongView";
import { getSong } from "@/lib/server/db";

export async function generateMetadata({ params }: PageProps<"/song/[id]">): Promise<Metadata> {
  const { id } = await params;
  const song = await getSong(id);
  return { title: song ? `${song.title}${song.artist ? ` · ${song.artist}` : ""} chords` : "Song not found" };
}

async function Song({ params }: { params: PageProps<"/song/[id]">["params"] }) {
  const { id } = await params;
  const song = await getSong(id);
  if (!song) notFound();
  return (
    <>
      <SongHeader id={song.id} title={song.title} artist={song.artist} />
      <SongView song={song} />
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
