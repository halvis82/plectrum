"use client";

import { useEffect, useRef, useState } from "react";
import { getMicStream } from "@/lib/audio";
import { hzOf } from "@/lib/pitch";
import { GuitarSynth } from "@/lib/synth";
import { TUNINGS, stringNames, type TuningId } from "@/lib/tab";
import { FRAME, STEP_MS, TunerTracker } from "@/lib/tuner";

const IN_TUNE = 5; // cents

type Reading = { string: number; cents: number; hz: number; midi: number };

/** A guitar tuner: listens through the mic, finds the string you're playing and says which way to turn. */
export function Tuner() {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tuningId, setTuningId] = useState<TuningId>("standard");
  const [reading, setReading] = useState<Reading | null>(null);
  const [tuned, setTuned] = useState<boolean[]>([false, false, false, false, false, false]);
  const stop = useRef<(() => void) | null>(null);
  const synth = useRef<{ ctx: AudioContext; s: GuitarSynth } | null>(null);
  const tuning = TUNINGS.find((t) => t.id === tuningId)!;
  const targets = tuning.strings;
  const labels = stringNames(targets);
  const targetsRef = useRef<readonly number[]>(targets);
  useEffect(() => {
    targetsRef.current = targets;
  }, [targets]);

  useEffect(() => () => stop.current?.(), []);

  async function start() {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await getMicStream();
    } catch {
      return setError("The tuner needs the microphone. Allow it in the browser and try again.");
    }
    const ctx = new AudioContext();
    await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const hp = new BiquadFilterNode(ctx, { type: "highpass", frequency: 55 });
    const dec = Math.max(1, Math.round(ctx.sampleRate / 24000));
    const an = new AnalyserNode(ctx, { fftSize: 2 ** Math.ceil(Math.log2(FRAME * dec)) });
    src.connect(hp).connect(an);
    const raw = new Float32Array(an.fftSize);
    const x = new Float32Array(FRAME);
    const tracker = new TunerTracker();
    let inTuneSince = 0;
    const timer = window.setInterval(() => {
      an.getFloatTimeDomainData(raw);
      const from = raw.length - x.length * dec;
      for (let i = 0; i < x.length; i++) {
        let v = 0;
        for (let k = 0; k < dec; k++) v += raw[from + i * dec + k];
        x[i] = v / dec;
      }
      const r = tracker.push(x, ctx.sampleRate / dec);
      if (!r) return setReading(null);
      const ts = targetsRef.current;
      const string = ts.reduce((best, t, i) => (Math.abs(r.midi - t) < Math.abs(r.midi - ts[best]) ? i : best), 0);
      const cents = (r.midi - ts[string]) * 100;
      setReading({ string, cents, hz: hzOf(r.midi), midi: r.midi });
      if (Math.abs(cents) <= IN_TUNE) {
        if (!inTuneSince) inTuneSince = performance.now();
        else if (performance.now() - inTuneSince > 700) setTuned((t) => (t[string] ? t : t.map((v, i) => (i === string ? true : v))));
      } else inTuneSince = 0;
    }, STEP_MS);
    stop.current = () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      stop.current = null;
    };
    setOn(true);
  }

  const hear = (i: number) => {
    if (!synth.current) {
      const ctx = new AudioContext();
      synth.current = { ctx, s: new GuitarSynth(ctx) };
    }
    const { ctx, s } = synth.current;
    void ctx.resume();
    s.play({ midi: targets[i], string: i, when: ctx.currentTime + 0.02, dur: 2.5, gain: 0.9, tech: 0 });
  };

  const cents = reading ? Math.max(-50, Math.min(50, reading.cents)) : 0;
  const good = reading && Math.abs(reading.cents) <= IN_TUNE;
  const angle = (cents / 50) * 60;
  const color = good ? "rgb(34 197 94)" : "var(--accent)";

  return (
    <div className="max-w-md mx-auto text-center">
      <svg viewBox="0 0 300 175" className="w-full" role="img" aria-label={reading ? `${Math.round(reading.cents)} cents ${reading.cents < 0 ? "flat" : "sharp"}` : "No note heard"}>
        {Array.from({ length: 21 }, (_, k) => {
          const a = ((k - 10) / 10) * 60 * (Math.PI / 180);
          const r1 = k % 5 === 0 ? 114 : 122;
          return <line key={k} x1={150 + Math.sin(a) * r1} y1={165 - Math.cos(a) * r1} x2={150 + Math.sin(a) * 132} y2={165 - Math.cos(a) * 132} stroke="var(--line)" strokeWidth={k === 10 ? 3 : 2} strokeLinecap="round" />;
        })}
        <path d={describeArc(150, 165, 142, -6, 6)} stroke="rgb(34 197 94 / 0.55)" strokeWidth="7" fill="none" strokeLinecap="round" />
        <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: "150px 165px", transition: "transform 0.2s ease-out" }} opacity={reading ? 1 : 0.2}>
          <line x1="150" y1="165" x2="150" y2="38" stroke={color} strokeWidth="4" strokeLinecap="round" />
        </g>
        <circle cx="150" cy="165" r="7" fill={color} opacity={reading ? 1 : 0.3} />
      </svg>

      <div className="h-28 flex flex-col items-center justify-center">
        {!on ? (
          <button onClick={() => void start()} className="btn btn-primary px-8 py-3.5 text-base rounded-full">
            Start tuning
          </button>
        ) : reading ? (
          <>
            <p className="text-6xl font-bold tracking-tight leading-none">{labels[reading.string]}</p>
            <p className={`mt-2 text-lg font-semibold ${good ? "text-green-500" : "text-accent"}`}>
              {good ? "In tune" : reading.cents < 0 ? `Tune up ↑` : `Tune down ↓`}
              <span className="ml-2 text-sm font-normal text-muted tabular-nums">
                {reading.cents > 0 ? "+" : reading.cents < 0 ? "−" : ""}
                {Math.abs(Math.round(reading.cents))} cents
              </span>
            </p>
          </>
        ) : (
          <p className="text-muted">Play a string</p>
        )}
      </div>
      {error && <p className="mt-2 text-sm rounded-xl bg-accent-soft px-3 py-2.5 text-left">{error}</p>}

      <div className="mt-6 flex justify-center gap-2.5">
        {labels.map((n, i) => (
          <button
            key={i}
            onClick={() => !on && hear(i)}
            className={`relative h-12 w-12 rounded-full text-lg font-semibold transition ${reading?.string === i ? (good ? "bg-green-500 text-white" : "bg-accent text-accent-fg") : tuned[i] ? "bg-green-500/15 text-green-600 dark:text-green-400" : "bg-surface-2"}`}
            aria-label={`${n} string${tuned[i] ? ", in tune" : ""}`}
            title={on ? undefined : `Hear the ${n} string`}
          >
            {n}
          </button>
        ))}
      </div>

      <div className="mt-6 flex items-center justify-center gap-4 text-sm text-muted">
        <select
          value={tuningId}
          onChange={(e) => {
            setTuningId(e.target.value as TuningId);
            setTuned([false, false, false, false, false, false]);
          }}
          className="bg-transparent text-muted hover:text-fg cursor-pointer"
          aria-label="Tuning"
        >
          {TUNINGS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} tuning
            </option>
          ))}
        </select>
        {on && (
          <button onClick={() => (stop.current?.(), setOn(false), setReading(null))} className="hover:text-fg">
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

function describeArc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p = (a: number) => [cx + Math.sin((a * Math.PI) / 180) * r, cy - Math.cos((a * Math.PI) / 180) * r];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0},${y0} A${r},${r} 0 0 1 ${x1},${y1}`;
}
