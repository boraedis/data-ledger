// Tally's look (#73): a little thermal receipt with a face. Its first line
// item is a tally, four strokes and the fifth across them, and its lines are
// printed in the app's status colours: green on track, yellow needs a look,
// red over. The total is double-ruled, like the rule under the app's top
// bar. Original art, drawn here as shapes so the app's component
// (src/components/tally-mascot.tsx) and the icon generator
// (scripts/generate-icons.mjs) draw the same one. No imports, so plain Node
// can load it for the icons.
//
// Its colours don't follow the theme: a character keeps its own colours,
// and the brown edge keeps the paper's shape on a dark background as well
// as a light one. Two levels of detail: "full" for 24px and up, and "mark"
// for smaller, which keeps only what survives 16px (the slip, its zigzag,
// the eyes and three status bars).

export const MASCOT_COLOURS = {
  paper: "#faf3e5",
  ink: "#523d2d",
  green: "#1a6444",
  yellow: "#e0a526",
  red: "#b6322b",
  cheek: "#f2b0a0",
  shine: "#ffffff",
} as const;

export type MascotVariant = "full" | "mark";
export type MascotShape = { tag: "path" | "ellipse" | "circle" | "line" | "rect"; attrs: Record<string, string | number>; part?: "eye" };

// Tally's moods: the same receipt with a different face, for wherever the
// app has something to say about how things stand. `happy` is the default
// and the one the icons are drawn from. `worried` is for something over,
// `wow` for something that needs a look, `party` for all caught up,
// `sleepy` for waiting (the model waking, a note not written yet), `cool`
// for the markets and `waving` for hello. Only the "full" variant has them:
// the "mark" is for sizes where a mood wouldn't read.
export const MASCOT_MOODS = ["happy", "worried", "wow", "cool", "sleepy", "party", "waving"] as const;
export type MascotMood = (typeof MASCOT_MOODS)[number];

/** The slip's outline in a 100×100 box: rounded top, `teeth` zigzag teeth along the bottom. */
function slip(teeth: number, left = 21, right = 79, top = 10, bottom = 88, depth = 6) {
  const w = (right - left) / teeth;
  let zigzag = "";
  for (let i = 0; i < teeth; i++) zigzag += `L${right - w * (i + 0.5)} ${bottom + depth}L${right - w * (i + 1)} ${bottom}`;
  return `M${left + 5} ${top}h${right - left - 10}a5 5 0 015 5V${bottom}${zigzag}V${top + 5}a5 5 0 015-5z`;
}

const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, width: number): MascotShape => ({
  tag: "line",
  attrs: { x1, y1, x2, y2, stroke, "stroke-width": width, "stroke-linecap": "round" },
});

/**
 * The part of the 100×100 box each variant actually covers, as an SVG
 * viewBox: the receipt is tall and narrow, so in the app it's drawn to this
 * box (sized by height) rather than the square, and isn't shrunk to fit air.
 */
export const MASCOT_VIEWBOX: Record<MascotVariant, { x: number; y: number; width: number; height: number }> = {
  full: { x: 18, y: 8, width: 64, height: 88 },
  mark: { x: 14, y: 2, width: 72, height: 96 },
};

/**
 * The viewBox a variant and mood are drawn in: a party hat adds height above
 * the slip and a waving arm adds width beside it. The receipt itself keeps
 * the base box's scale, so a mood never makes it smaller.
 */
export function mascotViewBox(variant: MascotVariant, mood: MascotMood = "happy") {
  const base = MASCOT_VIEWBOX[variant];
  if (variant === "mark") return base;
  if (mood === "party") return { ...base, y: -12, height: 108 };
  if (mood === "waving") return { ...base, width: 78 };
  return base;
}

/** The shapes, in a 100×100 box, back to front. */
export function mascotShapes(variant: MascotVariant, mood: MascotMood = "happy"): MascotShape[] {
  const c = MASCOT_COLOURS;
  if (variant === "mark") {
    return [
      { tag: "path", attrs: { d: slip(4, 18, 82, 6, 86, 8), fill: c.paper, stroke: c.ink, "stroke-width": 6, "stroke-linejoin": "round" } },
      { tag: "ellipse", part: "eye", attrs: { cx: 38, cy: 32, rx: 7, ry: 8, fill: c.ink } },
      { tag: "ellipse", part: "eye", attrs: { cx: 62, cy: 32, rx: 7, ry: 8, fill: c.ink } },
      line(32, 54, 68, 54, c.green, 7),
      line(32, 69, 48, 69, c.yellow, 7),
      line(58, 69, 68, 69, c.red, 7),
    ];
  }
  // Wide eyes for wow, the same eyes otherwise.
  const eye = (cx: number): MascotShape[] => [
    { tag: "ellipse", part: "eye", attrs: { cx, cy: 28, rx: mood === "wow" ? 5 : 4.2, ry: mood === "wow" ? 5.7 : 4.9, fill: c.ink } },
    { tag: "circle", part: "eye", attrs: { cx: cx + 1.5, cy: 26.3, r: 1.5, fill: c.shine } },
  ];
  // Not blinking (no `part`): sunglasses and closed eyes have nothing to close.
  const sunglasses: MascotShape[] = [
    { tag: "rect", attrs: { x: 34.5, y: 23, width: 13, height: 9, rx: 3.2, fill: c.ink } },
    { tag: "rect", attrs: { x: 52.5, y: 23, width: 13, height: 9, rx: 3.2, fill: c.ink } },
    line(47.5, 26, 52.5, 26, c.ink, 2),
    line(37, 25.5, 40, 25.5, c.shine, 1.2),
    line(55, 25.5, 58, 25.5, c.shine, 1.2),
  ];
  const closedEye = (cx: number): MascotShape => ({ tag: "path", attrs: { d: `M${cx - 4} 28q4 3.5 8 0`, fill: "none", stroke: c.ink, "stroke-width": 2, "stroke-linecap": "round" } });
  const eyes: MascotShape[] = mood === "cool" ? sunglasses : mood === "sleepy" ? [closedEye(41), closedEye(59)] : [...eye(41), ...eye(59)];
  const mouth: MascotShape =
    mood === "wow"
      ? { tag: "ellipse", attrs: { cx: 50, cy: 39, rx: 2.4, ry: 3, fill: c.ink } }
      : {
          tag: "path",
          attrs: {
            d: mood === "worried" ? "M45.5 39.5Q50 35.5 54.5 39.5" : mood === "sleepy" ? "M46.5 38Q50 40 53.5 38" : "M45.5 37Q50 41 54.5 37",
            fill: "none",
            stroke: c.ink,
            "stroke-width": 2.2,
            "stroke-linecap": "round",
          },
        };
  // What a mood adds around the face: worried brows, sleepy z's, a party hat, a waving arm.
  const extras: MascotShape[] = [];
  // Raised at the inner ends, which is what reads as worried; lowered there reads as cross.
  if (mood === "worried") extras.push(line(36, 23, 45, 20.5, c.ink, 1.8), line(64, 23, 55, 20.5, c.ink, 1.8));
  if (mood === "sleepy") {
    extras.push(
      { tag: "path", attrs: { d: "M66 13h6l-6 7h6", fill: "none", stroke: c.ink, "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" } },
      { tag: "path", attrs: { d: "M73.5 17h3.5l-3.5 4h3.5", fill: "none", stroke: c.ink, "stroke-width": 1.2, "stroke-linecap": "round", "stroke-linejoin": "round" } },
    );
  }
  if (mood === "party") {
    extras.push(
      { tag: "path", attrs: { d: "M41 10L50 -6L59 10z", fill: c.yellow, stroke: c.ink, "stroke-width": 1.6, "stroke-linejoin": "round" } },
      { tag: "circle", attrs: { cx: 50, cy: -7, r: 2.4, fill: c.red } },
    );
  }
  if (mood === "waving") {
    extras.push(
      { tag: "path", attrs: { d: "M79 46q8-2 9-12", fill: "none", stroke: c.ink, "stroke-width": 2.4, "stroke-linecap": "round" } },
      { tag: "circle", attrs: { cx: 88.5, cy: 32, r: 2.8, fill: c.paper, stroke: c.ink, "stroke-width": 1.6 } },
    );
  }
  // The tally: four strokes, and the fifth across them kept steep enough to read as one.
  const tally = [0, 1, 2, 3].map((i) => line(32.5 + i * 3, 50.5, 32.5 + i * 3, 57.5, c.green, 1.9));
  return [
    { tag: "path", attrs: { d: slip(6), fill: c.paper, stroke: c.ink, "stroke-width": 2.4, "stroke-linejoin": "round" } },
    ...eyes,
    { tag: "ellipse", attrs: { cx: 35, cy: 37, rx: 3, ry: 1.9, fill: c.cheek } },
    { tag: "ellipse", attrs: { cx: 65, cy: 37, rx: 3, ry: 1.9, fill: c.cheek } },
    mouth,
    ...extras,
    ...tally,
    line(31.2, 56.7, 42.8, 51.3, c.green, 1.9),
    // Line items in the status colours, then the double-ruled total.
    line(52, 54, 69, 54, c.green, 2.4),
    line(31, 64, 58, 64, c.yellow, 2.4),
    line(63, 64, 69, 64, c.red, 2.4),
    line(31, 73, 69, 73, c.green, 1.5),
    line(31, 76.5, 69, 76.5, c.green, 1.5),
  ];
}

/** The mascot as an SVG document, for the icon generator. */
export function mascotSvg(variant: MascotVariant, { size = 100, background }: { size?: number; background?: string } = {}): string {
  const body = mascotShapes(variant)
    .map(({ tag, attrs }) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">${background ? `<rect width="100" height="100" fill="${background}"/>` : ""}${body}</svg>`;
}
