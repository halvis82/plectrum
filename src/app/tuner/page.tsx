import type { Metadata } from "next";
import { Tuner } from "@/components/Tuner";

export const metadata: Metadata = { title: "Guitar tuner", description: "Tune your guitar with the microphone: it finds the string and tells you up or down." };

export default function TunerPage() {
  return (
    <>
      <h1 className="sr-only">Guitar tuner</h1>
      <div className="pt-6">
        <Tuner />
      </div>
    </>
  );
}
