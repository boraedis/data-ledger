import type { MascotMood } from "@/lib/tally/mascot";
import { moveText } from "@/lib/tally/movers";

// What Tally's summary looks like (#214): the night's digest turned into the
// pieces the page draws, from the digest's stored facts rather than from the
// model's wording. How the night went is a rule over those numbers (the same
// every night, and never a second model call): something over budget or a
// failed sync is "over", a flagged charge or an open alert is "look",
// anything else is "calm". Tally's face and the banner's tint follow it.
//
// The facts are stored as JSON beside the digest, and older digests may lack
// a field, so everything is read defensively: a missing number is zero and
// a missing list is empty, never a crash on the Inbox.

export type SummaryTone = "calm" | "look" | "over";
export type LineTone = "good" | "look" | "over" | "plain";

/** One printed line: a label, its value, and a count to draw as tally marks. */
export type ReceiptLine = { label: string; value: string; tone: LineTone; count?: number };

export type SummaryView = {
  tone: SummaryTone;
  mood: MascotMood;
  /** The note's first line: what the banner says. */
  headline: string;
  /** The rest of the note, a line each, bullets removed. */
  body: string[];
  /** Short figures for the banner, only those worth saying. */
  chips: { label: string; tone: LineTone }[];
  lines: ReceiptLine[];
  /** What waits on the owner: each flagged charge, over-budget budget, open alert and sync problem. The inbox itself isn't counted; it's always there. */
  needs: number;
};

const MAX_OVER_LINES = 3;
const MAX_PROBLEM_LINES = 2;
const MAX_MOVER_LINES = 3;
const MAX_LABEL = 48;

const record = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const count = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
const text = (x: unknown) => (typeof x === "string" ? x.trim() : "");
const clip = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1).trimEnd()}…` : s);
const unbullet = (line: string) => line.replace(/^[-*•]\s*/, "");

/** The note's own words: first line as the headline, what follows as its body. */
function splitNote(content: string): { headline: string; rest: string[] } {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  return { headline: unbullet(lines[0] ?? ""), rest: lines.slice(1) };
}

export function summaryView(content: string, facts: unknown): SummaryView {
  const f = record(facts);
  const sync = record(f.sync);
  const newTransactions = count(sync.newTransactions);
  const problems = list(sync.problems).map(text).filter(Boolean);
  const inbox = count(f.inbox);
  const flagged = count(f.flaggedCharges);
  const alerts = list(f.alerts).length;
  const overBudgets = list(f.budgets)
    .map(record)
    .filter((b) => b.over === true)
    .map((b) => ({ name: text(b.name), overBy: text(b.overBy) }));
  const owed = text(f.owedToYou);
  const moves = record(record(f.fixed).investments);
  const holdings = typeof moves.changePct === "number" && Number.isFinite(moves.changePct) ? moves.changePct : null;

  const tone: SummaryTone = overBudgets.length || problems.length ? "over" : flagged || alerts ? "look" : "calm";
  // Calm with nothing waiting is all caught up, which gets a party.
  const mood: MascotMood = tone === "over" ? "worried" : tone === "look" ? "wow" : inbox === 0 ? "party" : "happy";

  const { headline, rest } = splitNote(content);
  // The investments lines are fixed text appended to the note; with the
  // numbers in hand the receipt prints them, so the note drops them.
  const body = (holdings === null ? rest : rest.filter((l) => !/^[-*•]\s*(Investments since|Big movers:)/.test(l))).map(unbullet);

  const lines: ReceiptLine[] = [
    { label: "New transactions", value: String(newTransactions), tone: "plain", count: newTransactions },
    { label: "Waiting in inbox", value: String(inbox), tone: inbox ? "look" : "good", count: inbox },
  ];
  if (flagged) lines.push({ label: "Charges to check", value: String(flagged), tone: "over", count: flagged });
  for (const b of overBudgets.slice(0, MAX_OVER_LINES)) lines.push({ label: `${clip(b.name)}, over by`, value: b.overBy, tone: "over" });
  if (overBudgets.length > MAX_OVER_LINES) lines.push({ label: `${overBudgets.length - MAX_OVER_LINES} more over budget`, value: "", tone: "over" });
  if (alerts) lines.push({ label: "Open alerts", value: String(alerts), tone: "look", count: alerts });
  for (const p of problems.slice(0, MAX_PROBLEM_LINES)) lines.push({ label: clip(p), value: "", tone: "over" });
  if (owed) lines.push({ label: "Owed to you", value: owed, tone: "good" });
  if (holdings !== null) {
    lines.push({ label: `Holdings since ${text(moves.from) || "last time"}`, value: moveText(holdings), tone: holdings >= 0.05 ? "good" : "plain" });
    for (const m of list(moves.movers).map(record).slice(0, MAX_MOVER_LINES)) {
      const change = typeof m.changePct === "number" ? m.changePct : 0;
      lines.push({ label: clip(text(m.label)), value: moveText(change), tone: change >= 0 ? "good" : "look" });
    }
  }

  const chips: SummaryView["chips"] = [];
  if (newTransactions) chips.push({ label: `${newTransactions} new`, tone: "plain" });
  if (inbox) chips.push({ label: `${inbox} in inbox`, tone: "plain" });
  if (flagged) chips.push({ label: `${flagged} flagged`, tone: "over" });
  if (overBudgets.length) chips.push({ label: `${overBudgets.length} over budget`, tone: "over" });
  if (owed) chips.push({ label: `${owed} owed to you`, tone: "good" });

  return { tone, mood, headline, body, chips, lines, needs: flagged + overBudgets.length + alerts + problems.length };
}
