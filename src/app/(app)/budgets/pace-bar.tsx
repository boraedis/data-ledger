import { paceSegments, type Colour } from "@/lib/budgets/pace-colour";

// A horizontal budget bar coloured by pace (#159): green, then yellow past
// the pace line or the budget, then red past the budget. Scaled to the
// larger of budget and spend, so an overspend fills the bar and the split
// shows where the budget ran out. Overlays (ticks for the limit and the
// pace) go in `children`, positioned against the track.

export const COLOUR_CLASS: Record<Colour, string> = { green: "bg-positive", yellow: "bg-warning", red: "bg-negative" };

export function PaceBar({
  spentCents,
  budgetCents,
  paceCents,
  className,
  rounded = "rounded-sm",
  dim = false,
  children,
}: {
  spentCents: number;
  budgetCents: number;
  paceCents: number | null;
  /** Height and anything else for the track. */
  className: string;
  rounded?: string;
  dim?: boolean;
  children?: React.ReactNode;
}) {
  const scale = Math.max(budgetCents, spentCents, 1);
  const segments = paceSegments(spentCents, budgetCents, paceCents);
  return (
    <div className={`relative bg-muted ${rounded} ${className}`} aria-hidden>
      <div className={`flex h-full overflow-hidden ${rounded} ${dim ? "opacity-80" : ""}`} style={{ width: `${(Math.max(0, spentCents) / scale) * 100}%` }}>
        {segments.map((s, i) => (
          <span key={i} className={`h-full ${COLOUR_CLASS[s.colour]}`} style={{ flexGrow: s.cents, flexBasis: 0 }} />
        ))}
      </div>
      {children}
    </div>
  );
}
