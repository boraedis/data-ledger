import { createElement } from "react";
import { MASCOT_VIEWBOX, mascotShapes, mascotViewBox, type MascotMood, type MascotVariant } from "@/lib/tally/mascot";

// Tally's face (#73), wherever the assistant appears: the chat bubble, its
// panel and the Tally page. The shapes live in src/lib/tally/mascot.ts, which
// the app icons are drawn from too. Below 24px the simpler "mark" is drawn,
// since the tally, the cheeks and the smile blur together that small, and it
// has no moods.
//
// `size` is the receipt's height: it is narrower than it is tall. A mood
// that adds to the drawing (a party hat, a waving arm) makes the whole
// figure taller or wider, so the receipt stays the same size.
//
// Decorative unless given a label: it always sits beside the word "Tally"
// or inside a labelled button. `blink` blinks now and then, and only for
// people who haven't asked for reduced motion (the .tally-blink rule).

type Props = { size?: number; variant?: MascotVariant; mood?: MascotMood; label?: string; blink?: boolean; className?: string };

export function TallyMascot({ size = 32, variant, mood = "happy", label, blink = false, className }: Props) {
  const v = variant ?? (size < 24 ? "mark" : "full");
  const base = MASCOT_VIEWBOX[v];
  const box = mascotViewBox(v, mood);
  const scale = size / base.height;
  const shapes = mascotShapes(v, mood);
  const eyes = shapes.filter((s) => s.part === "eye");
  const rest = shapes.filter((s) => s.part !== "eye");
  const draw = (s: (typeof shapes)[number], i: number) => createElement(s.tag, { key: i, ...reactAttrs(s.attrs) });
  return (
    <svg
      width={Math.round(box.width * scale)}
      height={Math.round(box.height * scale)}
      viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {rest.map(draw)}
      <g className={blink ? "tally-blink" : undefined}>{eyes.map(draw)}</g>
    </svg>
  );
}

// SVG attribute names as React spells them (stroke-width → strokeWidth).
function reactAttrs(attrs: Record<string, string | number>) {
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v]));
}
