"use client";

import Link from "next/link";
import { usePendingNotes } from "@/lib/pending";
import { SongHeader } from "../SongHeader";
import { SongView } from "./SongView";

/** A song made on this device that the library doesn't have (yet): shown from what this device has. */
export function LocalSong({ id }: { id: string }) {
  const job = usePendingNotes(id);
  if (!job?.local)
    return (
      <div className="py-16 text-center">
        <h1 className="text-2xl font-bold">This song isn&apos;t in the library</h1>
        <p className="mt-2 text-muted">It may have been removed, or the link is mistyped.</p>
        <Link href="/" className="btn btn-primary mt-6">
          Catch a song
        </Link>
      </div>
    );
  return (
    <>
      <SongHeader id={id} title={job.local.title} artist={job.local.artist} />
      <SongView song={job.local} />
    </>
  );
}
