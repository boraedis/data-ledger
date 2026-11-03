// Merchants that are probably the same business (#287), for the owner to
// merge or reject. Conservative, as the epic asks (#284): a wrong merge
// would categorize the wrong things, so this only suggests, and only on
// strong signs, comparing every name and spelling of each merchant:
//   - one name is the other with words added at the end ("Corner Bean" and
//     "Corner Bean Cafe", "Lumen Bistro" and "Lumen Bistro Downtown"), the
//     shorter at least two words, so "Paypeer" alone doesn't pull in every
//     "Paypeer Payment From …";
//   - the same letters and digits once spaces and punctuation go ("Smoke &
//     Ember" and "Smoke Ember", "Corner-Bean" and "Cornerbean");
//   - spelled almost the same: one or two letters apart in a name of eight
//     or more ("Trattoria Verde" and "Tratoria Verde").
// Client-safe and pure.

export type NearInput = { id: string; name: string; aliases: string[] };
export type NearReason = "contains" | "punctuation" | "spelling";
export type NearPair = { aId: string; bId: string; reason: NearReason; aName: string; bName: string };

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Whether `short`'s words open `long`'s, with more words after. */
function opens(short: string[], long: string[]): boolean {
  return short.length >= 2 && long.length > short.length && short.every((w, i) => long[i] === w);
}

/** Edit distance, giving up past `max` (only small distances matter here). */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, row[j]);
    }
    if (best > max) return false;
    prev = row;
  }
  return prev[b.length] <= max;
}

function reasonFor(x: string, y: string): NearReason | null {
  const [wx, wy] = [words(x), words(y)];
  if (opens(wx, wy) || opens(wy, wx)) return "contains";
  const [sx, sy] = [squash(x), squash(y)];
  if (sx.length >= 4 && sx === sy) return "punctuation";
  if (Math.min(sx.length, sy.length) >= 8 && sx[0] === sy[0] && within(sx, sy, 2)) return "spelling";
  return null;
}

/** Pairs of merchants that look like one business, skipping pairs the owner rejected (`dismissed` holds "aId|bId", lower id first). */
export function nearDuplicates(merchants: NearInput[], dismissed: Set<string> = new Set()): NearPair[] {
  const names = merchants.map((m) => [...new Set([m.name, ...m.aliases])]);
  const out: NearPair[] = [];
  for (let i = 0; i < merchants.length; i++) {
    for (let j = i + 1; j < merchants.length; j++) {
      const [a, b] = merchants[i].id < merchants[j].id ? [merchants[i], merchants[j]] : [merchants[j], merchants[i]];
      if (dismissed.has(`${a.id}|${b.id}`)) continue;
      let reason: NearReason | null = null;
      for (const x of names[i]) {
        for (const y of names[j]) if ((reason = reasonFor(x, y))) break;
        if (reason) break;
      }
      if (reason) out.push({ aId: a.id, bId: b.id, reason, aName: a.name, bName: b.name });
    }
  }
  return out;
}

export const REASON_TEXT: Record<NearReason, string> = {
  contains: "One name is the other with words added",
  punctuation: "The same name apart from spaces and punctuation",
  spelling: "Spelled almost the same",
};
