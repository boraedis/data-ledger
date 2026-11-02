// Tally marks: a count drawn the old way, four strokes and the fifth across
// them. Used where the summary counts what happened overnight. Past
// MAX_MARKS a count is too many strokes to read at a glance, so none are
// drawn and the number carries it alone.
//
// Pure geometry, so the layout is tested and the component only draws it.

export const MAX_MARKS = 30;

export type MarkStroke = { x1: number; y1: number; x2: number; y2: number };

const GROUP = 22; // width of one group of five, with its gap
const GAP = 4; // between strokes
const TOP = 2;
const BOTTOM = 16;

/** The strokes for `count`, in a box `width` by `height`; null when there's nothing to draw or too much. */
export function tallyMarks(count: number): { width: number; height: number; strokes: MarkStroke[] } | null {
  if (!Number.isInteger(count) || count < 1 || count > MAX_MARKS) return null;
  const groups = Math.floor(count / 5);
  const rest = count % 5;
  const strokes: MarkStroke[] = [];
  const upright = (x: number) => strokes.push({ x1: x, y1: TOP, x2: x, y2: BOTTOM });
  for (let g = 0; g < groups; g++) {
    const left = g * GROUP;
    for (let k = 0; k < 4; k++) upright(left + 2 + k * GAP);
    // The fifth, across the four and steep enough to read as one.
    strokes.push({ x1: left, y1: BOTTOM - 2, x2: left + 16, y2: TOP + 2 });
  }
  for (let k = 0; k < rest; k++) upright(groups * GROUP + 2 + k * GAP);
  const width = rest ? groups * GROUP + rest * GAP : groups * GROUP - 5;
  return { width, height: BOTTOM + TOP, strokes };
}
