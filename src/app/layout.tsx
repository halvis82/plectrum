import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { HomeLink, NewSongButton } from "@/components/NewSongButton";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "ChordCatch", template: "%s · ChordCatch" },
  description: "Get guitar chords from any song: paste a link, upload a file or just record it.",
  appleWebApp: { capable: true, title: "ChordCatch", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f3ee" },
    { media: "(prefers-color-scheme: dark)", color: "#12100e" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <header className="mx-auto w-full max-w-5xl px-4 pt-5 pb-3 flex items-center justify-between">
          <HomeLink>
            <Logo />
            ChordCatch
          </HomeLink>
          <Suspense fallback={null}>
            <NewSongButton />
          </Suspense>
        </header>
        <main className="mx-auto w-full max-w-5xl px-4 pb-16 flex-1">{children}</main>
        <footer className="mx-auto w-full max-w-5xl px-4 py-6 text-xs text-muted">
          Chords and notes are recognized from the audio itself, in your browser, with the open BTC (ISMIR 2019) and Riley et al. guitar transcription (ICASSP 2024) models, plus a string model trained on GuitarSet, EGDB and Guitar-TECHS. Lyrics from LRCLIB, the video&apos;s captions, or Whisper listening in your browser. The guitar that plays tabs back is made from GuitarSet&apos;s acoustic guitar recordings (CC BY 4.0).
        </footer>
      </body>
    </html>
  );
}

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      {[9, 13, 17, 21].map((x) => (
        <line key={x} x1={x + 1} x2={x + 1} y1="7" y2="25" stroke="var(--accent-fg)" strokeWidth="1.4" opacity="0.55" />
      ))}
      <circle cx="14" cy="13" r="2.6" fill="var(--accent-fg)" />
      <circle cx="18" cy="19" r="2.6" fill="var(--accent-fg)" />
    </svg>
  );
}
