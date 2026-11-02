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
export type MascotShape = { tag: "path" | "ellipse" | "circle" | "line"; attrs: Record<string, string | number>; part?: "eye" };

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

/** The shapes, in a 100×100 box, back to front. */
export function mascotShapes(variant: MascotVariant): MascotShape[] {
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
  const eye = (cx: number): MascotShape[] => [
    { tag: "ellipse", part: "eye", attrs: { cx, cy: 28, rx: 4.2, ry: 4.9, fill: c.ink } },
    { tag: "circle", part: "eye", attrs: { cx: cx + 1.5, cy: 26.3, r: 1.5, fill: c.shine } },
  ];
  // The tally: four strokes, and the fifth across them kept steep enough to read as one.
  const tally = [0, 1, 2, 3].map((i) => line(32.5 + i * 3, 50.5, 32.5 + i * 3, 57.5, c.green, 1.9));
  return [
    { tag: "path", attrs: { d: slip(6), fill: c.paper, stroke: c.ink, "stroke-width": 2.4, "stroke-linejoin": "round" } },
    ...eye(41),
    ...eye(59),
    { tag: "ellipse", attrs: { cx: 35, cy: 37, rx: 3, ry: 1.9, fill: c.cheek } },
    { tag: "ellipse", attrs: { cx: 65, cy: 37, rx: 3, ry: 1.9, fill: c.cheek } },
    { tag: "path", attrs: { d: "M45.5 37Q50 41 54.5 37", fill: "none", stroke: c.ink, "stroke-width": 2.2, "stroke-linecap": "round" } },
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
