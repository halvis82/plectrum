import type { Metadata } from "next";
import { Tuner } from "@/components/Tuner";

export const metadata: Metadata = { title: "Guitar tuner", description: "Tune your guitar with the microphone: it finds the string and tells you up or down." };

export default function TunerPage() {
  return (
    <>
      <section className="pt-2 pb-5 max-w-xl mx-auto">
        <h1 className="text-3xl font-bold tracking-tight">Tuner</h1>
        <p className="mt-1 text-muted">Pluck a string near your phone or laptop. The needle shows how far off it is.</p>
      </section>
      <Tuner />
    </>
  );
}
