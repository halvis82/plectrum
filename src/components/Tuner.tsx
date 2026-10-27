"use client";

import { useEffect, useRef, useState } from "react";
import { getMicStream } from "@/lib/audio";
import { detectPitch, hzOf, midiOf } from "@/lib/pitch";
import { GuitarSynth } from "@/lib/synth";
import { TUNINGS, stringNames, type TuningId } from "@/lib/tab";

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const IN_TUNE = 5; // cents

type Reading = { string: number; cents: number; hz: number; midi: number };

/** A guitar tuner: listens through the mic, finds the string you're playing and says which way to turn. */
export function Tuner() {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tuningId, setTuningId] = useState<TuningId>("standard");
  const [locked, setLocked] = useState<number | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [tuned, setTuned] = useState<boolean[]>([false, false, false, false, false, false]);
  const stop = useRef<(() => void) | null>(null);
  const synth = useRef<{ ctx: AudioContext; s: GuitarSynth } | null>(null);
  const tuning = TUNINGS.find((t) => t.id === tuningId)!;
  const targets = tuning.strings;
  const labels = stringNames(targets);
  const lockedRef = useRef(locked);
  const targetsRef = useRef<readonly number[]>(targets);
  useEffect(() => {
    lockedRef.current = locked;
    targetsRef.current = targets;
  }, [locked, targets]);

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
    const an = new AnalyserNode(ctx, { fftSize: 4096 });
    src.connect(hp).connect(an);
    const raw = new Float32Array(an.fftSize);
    const dec = Math.max(1, Math.round(ctx.sampleRate / 24000));
    const x = new Float32Array(1536);
    const recent: number[] = [];
    let smooth: number | null = null;
    let inTuneSince = 0;
    let quietSince = 0;
    const timer = window.setInterval(() => {
      an.getFloatTimeDomainData(raw);
      const from = raw.length - x.length * dec;
      let rms = 0;
      for (let i = 0; i < x.length; i++) {
        let v = 0;
        for (let k = 0; k < dec; k++) v += raw[from + i * dec + k];
        x[i] = v / dec;
        rms += x[i] * x[i];
      }
      rms = Math.sqrt(rms / x.length);
      const p = rms > 0.004 ? detectPitch(x, ctx.sampleRate / dec, 60, 1100) : null;
      if (!p || p.clarity < 0.8) {
        // keep the last reading on screen for a moment as the string dies away
        if (!quietSince) quietSince = performance.now();
        if (performance.now() - quietSince > 1500) {
          setReading(null);
          smooth = null;
          recent.length = 0;
        }
        return;
      }
      quietSince = 0;
      const m = midiOf(p.hz);
      // a median over the last few readings removes single wild ones
      recent.push(m);
      if (recent.length > 5) recent.shift();
      const med = [...recent].sort((a, b) => a - b)[recent.length >> 1];
      smooth = smooth === null || Math.abs(smooth - med) > 0.5 ? med : smooth + 0.35 * (med - smooth);
      const ts = targetsRef.current;
      const string = lockedRef.current ?? ts.reduce((best, t, i) => (Math.abs(smooth! - t) < Math.abs(smooth! - ts[best]) ? i : best), 0);
      const cents = (smooth - ts[string]) * 100;
      setReading({ string, cents, hz: hzOf(smooth), midi: smooth });
      if (Math.abs(cents) <= IN_TUNE) {
        if (!inTuneSince) inTuneSince = performance.now();
        else if (performance.now() - inTuneSince > 700) setTuned((t) => (t[string] ? t : t.map((v, i) => (i === string ? true : v))));
      } else inTuneSince = 0;
    }, 40);
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
    s.play(targets[i], ctx.currentTime + 0.02, 2.5, 0.9);
  };

  const cents = reading ? Math.max(-50, Math.min(50, reading.cents)) : 0;
  const good = reading && Math.abs(reading.cents) <= IN_TUNE;
  const angle = (cents / 50) * 60;
  const playedName = reading ? `${NAMES[((Math.round(reading.midi) % 12) + 12) % 12]}${Math.floor(Math.round(reading.midi) / 12) - 1}` : null;

  return (
    <div className="max-w-xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Tuning</span>
          <select
            value={tuningId}
            onChange={(e) => {
              setTuningId(e.target.value as TuningId);
              setTuned([false, false, false, false, false, false]);
            }}
            className="select"
          >
            {TUNINGS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {on && (
          <button onClick={() => (stop.current?.(), setOn(false), setReading(null))} className="btn btn-sm">
            Stop listening
          </button>
        )}
      </div>

      {/* gauge */}
      <div className={`mt-5 rounded-3xl border bg-surface p-5 transition-colors ${good ? "border-green-500/60" : "border-line"}`}>
        <svg viewBox="0 0 300 170" className="w-full" role="img" aria-label={reading ? `${Math.round(reading.cents)} cents ${reading.cents < 0 ? "flat" : "sharp"}` : "No note heard"}>
          {Array.from({ length: 21 }, (_, k) => {
            const a = ((k - 10) / 10) * 60 * (Math.PI / 180);
            const r1 = k % 5 === 0 ? 112 : 120;
            return <line key={k} x1={150 + Math.sin(a) * r1} y1={160 - Math.cos(a) * r1} x2={150 + Math.sin(a) * 130} y2={160 - Math.cos(a) * 130} stroke="var(--line)" strokeWidth={k === 10 ? 3 : 2} strokeLinecap="round" />;
          })}
          <path d={describeArc(150, 160, 140, -6, 6)} stroke="rgb(34 197 94 / 0.5)" strokeWidth="8" fill="none" strokeLinecap="round" />
          <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: "150px 160px", transition: "transform 0.12s ease-out" }} opacity={reading ? 1 : 0.25}>
            <line x1="150" y1="160" x2="150" y2="34" stroke={good ? "rgb(34 197 94)" : "var(--accent)"} strokeWidth="4" strokeLinecap="round" />
          </g>
          <circle cx="150" cy="160" r="8" fill={good ? "rgb(34 197 94)" : "var(--accent)"} />
          <text x="22" y="166" fontSize="12" fill="var(--muted)">
            flat
          </text>
          <text x="254" y="166" fontSize="12" fill="var(--muted)">
            sharp
          </text>
        </svg>
        <div className="mt-1 text-center min-h-24">
          {!on ? (
            <button onClick={() => void start()} className="btn btn-primary mt-2 px-6 py-3 text-base">
              🎙️ Start tuning
            </button>
          ) : reading ? (
            <>
              <p className="text-5xl font-bold tracking-tight">{labels[reading.string]}</p>
              <p className={`mt-1 text-lg font-semibold ${good ? "text-green-500" : "text-accent"}`}>
                {good ? "✓ In tune" : reading.cents < 0 ? `↑ Tune up ${Math.round(-reading.cents)}¢` : `↓ Tune down ${Math.round(reading.cents)}¢`}
              </p>
              <p className="text-xs text-muted tabular-nums mt-1">
                Hearing {playedName} at {reading.hz.toFixed(1)} Hz
                {Math.abs(reading.cents) > 50 ? `, far from ${labels[reading.string]}: is it the right string?` : ""}
              </p>
            </>
          ) : (
            <p className="text-muted pt-6">Pluck one string and let it ring…</p>
          )}
        </div>
      </div>
      {error && <p className="mt-3 text-sm rounded-xl bg-accent-soft px-3 py-2.5">{error}</p>}

      {/* strings */}
      <div className="mt-4 grid grid-cols-6 gap-2">
        {labels.map((n, i) => {
          const active = reading?.string === i;
          return (
            <button
              key={i}
              onClick={() => {
                setLocked(locked === i ? null : i);
                if (!on) hear(i);
              }}
              className={`relative rounded-2xl border py-3 text-center transition ${locked === i ? "border-accent bg-accent-soft" : active ? "border-accent" : "border-line bg-surface"}`}
              aria-pressed={locked === i}
              aria-label={`${n} string${tuned[i] ? ", in tune" : ""}${locked === i ? ", locked" : ""}`}
            >
              <span className="block text-xl font-bold">{n}</span>
              <span className="block text-[10px] text-muted tabular-nums">{hzOf(targets[i]).toFixed(0)} Hz</span>
              {tuned[i] && <span className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-green-500 text-white text-[11px] grid place-items-center">✓</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>{locked === null ? "It finds the string you play. Tap a string to tune only that one." : `Tuning only the ${labels[locked]} string. Tap it again to let it find the string.`}</span>
        <span className="flex gap-1">
          {labels.map((n, i) => (
            <button key={i} onClick={() => hear(i)} className="btn btn-ghost btn-sm px-2" aria-label={`Hear the ${n} string`}>
              🔊{n}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

function describeArc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p = (a: number) => [cx + Math.sin((a * Math.PI) / 180) * r, cy - Math.cos((a * Math.PI) / 180) * r];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0},${y0} A${r},${r} 0 0 1 ${x1},${y1}`;
}
