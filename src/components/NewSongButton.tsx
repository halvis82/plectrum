"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Back to the catcher from any song page. */
export function NewSongButton() {
  if (usePathname() === "/") return null;
  return (
    <Link href="/" className="rounded-xl bg-accent text-accent-fg px-3.5 py-2 text-sm font-medium">
      + New song
    </Link>
  );
}
