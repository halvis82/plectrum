import shapes from "@/lib/chord-shapes.json";
import type { Chord } from "@/lib/music";

type Shape = { f: number[]; g: number[]; b: number; r: number[] };
const SHAPES = shapes as Record<string, Shape[]>;

export function voicings(c: Chord): Shape[] {
  return c ? (SHAPES[`${c.root}:${c.quality}`] ?? []) : [];
}

/** Standard 6-string chord box. Frets in `shape.f` are relative to `shape.b` (base fret). */
export function ChordDiagram({ chord, name, variant = 0, size = 76 }: { chord: Chord; name: string; variant?: number; size?: number }) {
  const all = voicings(chord);
  const shape = all[variant % Math.max(1, all.length)];
  const W = 100, H = 120, left = 18, top = 30, gap = 13, fretH = 16, frets = 5;
  return (
    <figure className="flex flex-col items-center" style={{ width: size }}>
      <figcaption className="font-semibold text-sm leading-none mb-1">{name}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width={size} height={(size * H) / W} role="img" aria-label={`${name} chord diagram`}>
        {!shape ? (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize="11" fill="var(--muted)">no diagram</text>
        ) : (
          <>
            {shape.b > 1 && (
              <text x={left - 6} y={top + fretH * 0.7} textAnchor="end" fontSize="10" fill="var(--muted)">{shape.b}</text>
            )}
            <line x1={left} x2={left + gap * 5} y1={top} y2={top} stroke="var(--fg)" strokeWidth={shape.b === 1 ? 4 : 1} />
            {Array.from({ length: frets }, (_, i) => (
              <line key={i} x1={left} x2={left + gap * 5} y1={top + fretH * (i + 1)} y2={top + fretH * (i + 1)} stroke="var(--muted)" strokeWidth="1" />
            ))}
            {Array.from({ length: 6 }, (_, s) => (
              <line key={s} x1={left + gap * s} x2={left + gap * s} y1={top} y2={top + fretH * frets} stroke="var(--muted)" strokeWidth="1" />
            ))}
            {shape.r.map((fret) => {
              const strings = shape.f.map((f, s) => (f === fret ? s : -1)).filter((s) => s >= 0);
              const a = Math.min(...strings), z = Math.max(...strings);
              return (
                <rect key={`b${fret}`} x={left + gap * a - 5} y={top + fretH * (fret - 0.5) - 5} width={gap * (z - a) + 10} height="10" rx="5" fill="var(--fg)" />
              );
            })}
            {shape.f.map((f, s) =>
              f < 0 ? (
                <text key={s} x={left + gap * s} y={top - 6} textAnchor="middle" fontSize="10" fill="var(--muted)">×</text>
              ) : f === 0 ? (
                <circle key={s} cx={left + gap * s} cy={top - 9} r="3.5" fill="none" stroke="var(--fg)" strokeWidth="1.2" />
              ) : shape.r.includes(f) ? null : (
                <circle key={s} cx={left + gap * s} cy={top + fretH * (f - 0.5)} r="5" fill="var(--fg)" />
              ),
            )}
          </>
        )}
      </svg>
    </figure>
  );
}
