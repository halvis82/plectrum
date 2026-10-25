import { connection } from "next/server";
import { listSongs } from "@/lib/server/db";
import { LibraryList } from "./LibraryList";

export async function Library() {
  await connection();
  const songs = await listSongs().catch(() => null);
  if (!songs) return <p className="text-sm text-muted">The library couldn&apos;t load right now. Refresh to try again.</p>;
  return <LibraryList initial={songs} />;
}
