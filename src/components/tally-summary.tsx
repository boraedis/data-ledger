import Link from "next/link";
import { TallyMarks } from "@/components/tally-marks";
import { TallyMascot } from "@/components/tally-mascot";
import { MASCOT_COLOURS, type MascotMood } from "@/lib/tally/mascot";
import type { LineTone, ReceiptLine, SummaryTone, SummaryView } from "@/lib/tally/summary";

// Tally's summary of the night (#214), drawn. The night's figures lead, on
// a printed receipt: counts as tally marks, lines in the status colours, a
// double-ruled total. Under it, the full summary: a banner whose tint and
// face follow how the night went (src/lib/tally/summary.ts), with the
// note's own words. The receipt is always open; it's short, and it's what
// to glance at before the triage below.
//
// The receipt is paper whatever the theme, like the mascot: a character
// keeps its own colours, and a slip of paper on a dark page is the point.
// Status is never colour alone: each line says what it is, and the banner's
// headline says how the night went.

const BANNER: Record<SummaryTone, string> = {
  calm: "border-positive/30 bg-positive/10",
  look: "border-warning/40 bg-warning/10",
  over: "border-negative/30 bg-negative/10",
};

const CHIP: Record<LineTone, string> = {
  plain: "bg-secondary text-secondary-foreground",
  good: "bg-positive/15 text-positive",
  look: "bg-warning/15 text-warning",
  over: "bg-negative/15 text-negative",
};

// Status colours that read on the paper: the mascot's own green and red, and
// a darker amber, since its yellow is too light for text.
const INK: Record<LineTone, string> = { plain: MASCOT_COLOURS.ink, good: MASCOT_COLOURS.green, look: "#8a5d0a", over: "#a8281f" };
const PAPER_EDGE = "rgb(82 61 45 / 0.28)";
const PAPER_DOTS = "rgb(82 61 45 / 0.45)";

export function TallySummary({ view, written }: { view: SummaryView; written: string }) {
  return (
    <section aria-label="Tally's summary" className="space-y-3">
      <Receipt lines={view.lines} needs={view.needs} mood={view.mood} written={written} />
      <div className={`flex items-center gap-4 rounded-xl border p-4 ${BANNER[view.tone]}`}>
        <TallyMascot size={72} mood={view.mood} blink />
        <div className="min-w-0 space-y-2">
          <p className="text-xs text-muted-foreground">Tally&apos;s summary · Written {written}</p>
          {view.headline ? <p className="font-heading text-xl leading-snug">{view.headline}</p> : null}
          {view.chips.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {view.chips.map((chip) => (
                <li key={chip.label} className={`rounded-full px-2 py-0.5 text-xs ${CHIP[chip.tone]}`}>
                  {chip.label}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {view.body.length ? (
        <ul className="list-disc space-y-0.5 pl-9 text-sm">
          {view.body.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Receipt({ lines, needs, mood, written }: { lines: ReceiptLine[]; needs: number; mood: MascotMood; written: string }) {
  return (
    <div className="w-full max-w-sm">
      <div
        className="rounded-t-md border border-b-0 px-4 pt-3 pb-2 font-mono text-xs leading-relaxed"
        style={{ background: MASCOT_COLOURS.paper, color: MASCOT_COLOURS.ink, borderColor: PAPER_EDGE }}
      >
        <p className="flex items-center gap-2">
          <TallyMascot size={28} mood={mood} />
          <span>
            <span className="block text-[13px] font-medium">Tally&apos;s receipt</span>
            <span className="block opacity-80">Printed {written}</span>
          </span>
        </p>
        <hr className="my-2 border-t border-dashed" style={{ borderColor: PAPER_DOTS }} />
        <ul className="space-y-0.5">
          {lines.map((line, i) => (
            <li key={i} className="flex items-baseline gap-1.5" style={{ color: INK[line.tone] }}>
              <span>{line.label}</span>
              <i className="min-w-3 flex-1 -translate-y-[3px] self-end border-b border-dotted" style={{ borderColor: PAPER_DOTS }} />
              {line.count ? <TallyMarks count={line.count} className="self-center" /> : null}
              {line.value ? <span className="tabular-nums">{line.value}</span> : null}
            </li>
          ))}
        </ul>
        <hr className="my-2 border-t-[3px] border-double" style={{ borderColor: MASCOT_COLOURS.ink }} />
        <p className="flex items-baseline justify-between font-medium">
          <span>Needs you</span>
          <span>{needs === 0 ? "nothing" : needs === 1 ? "1 thing" : `${needs} things`}</span>
        </p>
        <p className="pt-2 text-center opacity-75">See you tomorrow night</p>
      </div>
      <svg width="100%" height="8" className="block" aria-hidden>
        <defs>
          <pattern id="tally-receipt-edge" width="12" height="8" patternUnits="userSpaceOnUse">
            <path d="M0 0H12L6 8z" fill={MASCOT_COLOURS.paper} stroke={PAPER_EDGE} strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="8" fill="url(#tally-receipt-edge)" />
      </svg>
    </div>
  );
}

/** Today's version: the banner alone, in one line, linking to the full summary on the Inbox. */
export function TallySummaryNote({ view, written }: { view: SummaryView; written: string }) {
  return (
    // On a phone the link takes its own line under the note (#67): beside it,
    // it left the headline a column a word or two wide.
    <section aria-label="Tally's note" className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border p-4 sm:flex-nowrap md:col-span-2 ${BANNER[view.tone]}`}>
      <TallyMascot size={56} mood={view.mood} blink />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs text-muted-foreground">Tally&apos;s note · Written {written}</p>
        {view.headline ? <p className="font-heading text-lg leading-snug">{view.headline}</p> : null}
        {view.chips.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {view.chips.map((chip) => (
              <li key={chip.label} className={`rounded-full px-2 py-0.5 text-xs ${CHIP[chip.tone]}`}>
                {chip.label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <Link href="/inbox" className="w-full text-right text-sm text-muted-foreground hover:text-foreground sm:w-auto sm:shrink-0 sm:self-start">
        Read the summary →
      </Link>
    </section>
  );
}
