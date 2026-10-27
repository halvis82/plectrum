"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The header's links: the tuner, and back to the catcher from anywhere else. */
export function NewSongButton() {
  const path = usePathname();
  return (
    <nav className="flex items-center gap-2">
      <Link href="/tuner" className={`btn btn-sm ${path === "/tuner" ? "btn-primary" : "btn-ghost"}`} aria-current={path === "/tuner" ? "page" : undefined}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 18a9 9 0 1 1 16 0" />
          <path d="M12 18l4-7" />
        </svg>
        Tuner
      </Link>
      {path !== "/" && (
        <Link href="/" onClick={() => window.dispatchEvent(new Event("cc:new-song"))} className="btn btn-sm btn-primary">
          + New song
        </Link>
      )}
    </nav>
  );
}

/** The logo link home, which also clears the catcher for a new song. */
export function HomeLink({ children }: { children: React.ReactNode }) {
  return (
    <Link href="/" onClick={() => window.dispatchEvent(new Event("cc:new-song"))} className="flex items-center gap-2 font-bold text-lg tracking-tight rounded-lg">
      {children}
    </Link>
  );
}
