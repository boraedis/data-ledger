import { describe, expect, it } from "vitest";
import { summaryView } from "@/lib/tally/summary";

// Synthetic nights only: invented budgets, amounts and funds.

const note = "- Quiet night: 14 new transactions came in.\n- Dining is close to its limit.";
const calm = { sync: { newTransactions: 14, problems: [] }, inbox: 12, flaggedCharges: 0, alerts: [], budgets: [], owedToYou: null };
const withInvestments = { ...calm, fixed: { investments: { from: "2026-10-30", to: "2026-11-02", changePct: 1.24, movers: [{ label: "Sample Tech Co (Example Brokerage)", changePct: -5.8 }] } } };

describe("how the night went", () => {
  it("is calm and happy with nothing wrong, and a party when nothing waits", () => {
    expect(summaryView(note, calm)).toMatchObject({ tone: "calm", mood: "happy" });
    expect(summaryView(note, { ...calm, inbox: 0 })).toMatchObject({ tone: "calm", mood: "party" });
  });

  it("looks twice at a flagged charge or an open alert", () => {
    expect(summaryView(note, { ...calm, flaggedCharges: 2 })).toMatchObject({ tone: "look", mood: "wow" });
    expect(summaryView(note, { ...calm, alerts: [{ title: "Example Streaming went up" }] })).toMatchObject({ tone: "look", mood: "wow" });
  });

  it("is over for a budget that's over or a sync that failed, ahead of anything flagged", () => {
    const over = { ...calm, flaggedCharges: 2, budgets: [{ name: "Groceries", over: true, overBy: "$28.00" }, { name: "Fun", over: false, overBy: null }] };
    expect(summaryView(note, over)).toMatchObject({ tone: "over", mood: "worried" });
    expect(summaryView(note, { ...calm, sync: { newTransactions: 0, problems: ["Example Bank needs to be reconnected"] } })).toMatchObject({ tone: "over", mood: "worried" });
  });
});

describe("what needs the owner", () => {
  it("counts each flagged charge, over budget, alert and sync problem, and not the inbox", () => {
    expect(summaryView(note, calm).needs).toBe(0);
    const busy = {
      ...calm,
      flaggedCharges: 2,
      alerts: [{ title: "Example Streaming went up" }],
      sync: { newTransactions: 0, problems: ["Example Bank needs to be reconnected"] },
      budgets: [{ name: "Groceries", over: true, overBy: "$28.00" }],
    };
    expect(summaryView(note, busy).needs).toBe(5);
  });
});

describe("what's printed", () => {
  it("counts what happened, with the counts that read as tally marks", () => {
    const { lines, chips } = summaryView(note, { ...calm, flaggedCharges: 2, owedToYou: "$64.00" });
    expect(lines).toEqual([
      { label: "New transactions", value: "14", tone: "plain", count: 14 },
      { label: "Waiting in inbox", value: "12", tone: "look", count: 12 },
      { label: "Charges to check", value: "2", tone: "over", count: 2 },
      { label: "Owed to you", value: "$64.00", tone: "good" },
    ]);
    expect(chips.map((c) => c.label)).toEqual(["14 new", "12 in inbox", "2 flagged", "$64.00 owed to you"]);
  });

  it("counts draft trades waiting (#325), and says nothing at zero", () => {
    const { lines, chips, tone } = summaryView(note, { ...calm, tradesToReview: 3 });
    expect(lines.find((l) => l.label === "Trades to review")).toEqual({ label: "Trades to review", value: "3", tone: "look", count: 3 });
    expect(chips.map((c) => c.label)).toContain("3 trades to review");
    // A nudge, not a problem.
    expect(tone).toBe("calm");
    expect(summaryView(note, { ...calm, tradesToReview: 0 }).lines.map((l) => l.label)).not.toContain("Trades to review");
  });

  it("names each budget that's over, three at most, and says how many more", () => {
    const budgets = ["A", "B", "C", "D", "E"].map((name) => ({ name: `Budget ${name}`, over: true, overBy: "$5.00" }));
    const { lines } = summaryView(note, { ...calm, budgets });
    expect(lines.filter((l) => l.tone === "over").map((l) => l.label)).toEqual(["Budget A, over by", "Budget B, over by", "Budget C, over by", "2 more over budget"]);
  });

  it("prints the investments from their numbers, and leaves them out of the note", () => {
    const text = `${note}\n- Investments since 2026-10-30: holdings up 1.2%.\n- Big movers: Sample Tech Co (Example Brokerage) down 5.8%.`;
    const view = summaryView(text, withInvestments);
    expect(view.body).toEqual(["Dining is close to its limit."]);
    expect(view.lines.slice(-2)).toEqual([
      { label: "Holdings since 2026-10-30", value: "up 1.2%", tone: "good" },
      { label: "Sample Tech Co (Example Brokerage)", value: "down 5.8%", tone: "look" },
    ]);
  });

  it("keeps the note's investments lines when the numbers weren't stored", () => {
    const text = `${note}\n- Investments since 2026-10-30: holdings up 1.2%.`;
    expect(summaryView(text, calm).body).toEqual(["Dining is close to its limit.", "Investments since 2026-10-30: holdings up 1.2%."]);
  });

  it("says about flat for a quiet day", () => {
    const flat = { ...calm, fixed: { investments: { from: "2026-10-30", to: "2026-11-02", changePct: 0.01, movers: [] } } };
    expect(summaryView(note, flat).lines.at(-1)).toEqual({ label: "Holdings since 2026-10-30", value: "about flat", tone: "plain" });
  });
});

describe("the note", () => {
  it("takes its first line as the headline, bullet removed, and the rest as the body", () => {
    expect(summaryView(note, calm)).toMatchObject({ headline: "Quiet night: 14 new transactions came in.", body: ["Dining is close to its limit."] });
  });

  it("copes with facts from an older digest, or none", () => {
    for (const facts of [null, undefined, "nope", 7, [], {}, { sync: "x", budgets: "y", alerts: 3, fixed: { investments: "z" } }]) {
      const view = summaryView(note, facts);
      expect(view.tone).toBe("calm");
      expect(view.headline).toBe("Quiet night: 14 new transactions came in.");
    }
  });

  it("copes with an empty note", () => {
    expect(summaryView("", calm)).toMatchObject({ headline: "", body: [] });
  });
});
