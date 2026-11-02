import { tallyMarks } from "@/lib/tally/marks";

// A count as tally marks (src/lib/tally/marks.ts), in the current text
// colour so the caller sets it. Draws nothing for a count that's none or
// too many to read as strokes; the number printed beside it carries those.
// Decorative: the number is always shown next to it.

export function TallyMarks({ count, className }: { count: number; className?: string }) {
  const marks = tallyMarks(count);
  if (!marks) return null;
  return (
    <svg width={marks.width} height={marks.height} viewBox={`0 0 ${marks.width} ${marks.height}`} className={className} aria-hidden>
      {marks.strokes.map((s, i) => (
        <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
      ))}
    </svg>
  );
}
