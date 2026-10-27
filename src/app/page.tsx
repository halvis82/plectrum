import { Suspense } from "react";
import { Catcher } from "@/components/Catcher";
import { Library } from "@/components/Library";
import { ScratchButton } from "@/components/ScratchButton";

export default function Home() {
  return (
    <>
      <section className="pt-4 pb-6 max-w-2xl">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Chords and tabs for any song.</h1>
        <p className="mt-2 text-muted">Paste a link, upload a file, or let it listen. ChordCatch works out the chords and every note, string and fret from the audio itself.</p>
      </section>
      <div className="max-w-2xl">
        <Catcher />
        <ScratchButton />
      </div>
      <section className="mt-12">
        <h2 className="text-xl font-semibold mb-3">Library</h2>
        <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
          <Library />
        </Suspense>
      </section>
    </>
  );
}
