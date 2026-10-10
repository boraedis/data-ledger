import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { categories, categorySuggestions, commandLog, modelEvals, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { classifyWithModel, runCategorization, type Classify } from "@/lib/categorize/pipeline";
import { evaluateModel, recommendedThreshold } from "@/lib/model/evaluate";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute, read, undoCommand } from "@/operations/runtime";
import { listInbox } from "@/operations/transactions";

// The model step of the pipeline (#6 phase 3), with a fake classifier in
// place of the GPU. All data synthetic.

const env = { ...process.env };
let db: Db;
let cat: Record<string, string>;

// A fake model that "knows" a few seed merchants by description.
const KNOWN: [RegExp, string, number][] = [
  [/CORNER BEAN/, "Coffee", 0.97],
  [/QUILLFIELD/, "Groceries", 0.95],
  [/ZIPRIDE/, "Transport", 0.6], // unsure: suggestion only
];
function fakeModel(calls: { count: number; inputs: unknown[] } = { count: 0, inputs: [] }): Classify {
  return async (cats, txns) => {
    calls.count++;
    calls.inputs.push(...txns);
    return txns.map((t) => {
      const hit = KNOWN.find(([re]) => re.test(t.description));
      const id = hit ? cats.find((c) => c.label === hit[1])?.id : undefined;
      return id ? { categoryId: id, confidence: hit![2] } : { categoryId: null, confidence: 0 };
    });
  };
}

beforeEach(async () => {
  process.env.MODEL_BASE_URL = "https://ledger-model.example.test/v1";
  process.env.MODEL_API_KEY = "test-key-that-is-long-enough-0123";
  delete process.env.MODEL_AUTO_APPLY_THRESHOLD;
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  cat = Object.fromEntries((await db.select().from(categories)).map((c) => [c.name, c.id]));
});
afterEach(() => {
  process.env = { ...env };
  vi.unstubAllGlobals();
});

const byMerchant = (m: string) => db.select().from(transactions).where(eq(transactions.merchant, m));

describe("model step", () => {
  it("applies confident answers as one 'model' command and suggests the rest", async () => {
    const result = await runCategorization(db, { model: { classify: fakeModel(), limit: 500 } });
    const coffee = await byMerchant("Corner Bean Cafe");
    expect(coffee.every((t) => t.categoryId === cat.Coffee)).toBe(true);
    expect(result.byModel).toBe(coffee.length + (await byMerchant("Quillfield Market")).length);

    const [entry] = await db.select().from(commandLog).where(eq(commandLog.actor, "model"));
    expect(entry).toMatchObject({ operation: "transactions.applyCategories", reason: "Model: confident categorizations (≥90% confidence)" });

    // The unsure one stays in the inbox, with the model's suggestion shown.
    const inbox = await read(db, listInbox, { limit: 500 });
    const ride = inbox.find((r) => r.merchant === "Zipride Trip")!;
    expect(ride).toMatchObject({ suggestedCategoryId: cat.Transport, suggestionSource: "model", suggestionConfidence: 0.6 });
  });

  it("does nothing unless asked, and nothing when no model is configured", async () => {
    const calls = { count: 0, inputs: [] as unknown[] };
    await runCategorization(db); // inbox corrections, "Sync now": no model
    expect(calls.count).toBe(0);
    delete process.env.MODEL_BASE_URL;
    expect(await runCategorization(db, { model: { classify: fakeModel(calls) } })).toMatchObject({ byModel: 0, modelSeen: 0 });
    expect(calls.count).toBe(0);
  });

  it("never sends a transaction twice, even when it had no answer", async () => {
    const calls = { count: 0, inputs: [] as unknown[] };
    const first = await runCategorization(db, { model: { classify: fakeModel(calls), limit: 500 } });
    expect(first.modelSeen).toBeGreaterThan(0);
    const before = calls.inputs.length;
    expect((await runCategorization(db, { model: { classify: fakeModel(calls), limit: 500 } })).modelSeen).toBe(0);
    expect(calls.inputs.length).toBe(before);
  });

  it("leaves what memory or rules can handle alone, and memory's suggestion beats the model's", async () => {
    const [a, b] = await byMerchant("Quillfield Market");
    const user = (transactionId: string, categoryId: string) =>
      execute(db, { operation: "transactions.setCategory", input: { transactionId, categoryId }, actor: "user", reason: "x" });
    await user(a.id, cat.Groceries);
    await user(b.id, cat.Dining); // mixed history: the owner's call, not the model's
    const calls = { count: 0, inputs: [] as { description: string }[] };
    await runCategorization(db, { model: { classify: fakeModel(calls as never), limit: 500 } });
    expect(calls.inputs.some((t) => /QUILLFIELD/.test(t.description))).toBe(false);
    const inbox = await read(db, listInbox, { limit: 500 });
    expect(inbox.find((r) => r.merchant === "Quillfield Market")?.suggestionSource).toBe("memory");
  });

  it("records nothing when the model fails, so it's tried again next time", async () => {
    const failing: Classify = async () => {
      throw new Error("The model is still starting up; try again in a minute");
    };
    const result = await runCategorization(db, { model: { classify: failing } });
    expect(result).toMatchObject({ byModel: 0, modelSeen: 0, modelError: "The model is still starting up; try again in a minute" });
    expect(await db.select().from(categorySuggestions)).toHaveLength(0);
    expect((await runCategorization(db, { model: { classify: fakeModel(), limit: 500 } })).modelSeen).toBeGreaterThan(0);
  });

  it("skips quietly when the deadline leaves no time, and stops starting batches near it", async () => {
    const calls = { count: 0, inputs: [] as unknown[] };
    expect(await runCategorization(db, { model: { classify: fakeModel(calls), deadline: Date.now() + 5_000 } })).toMatchObject({ modelSeen: 0 });
    expect(calls.count).toBe(0);
    // Enough for the first batch only: one call, then no more.
    await runCategorization(db, { model: { classify: fakeModel(calls), deadline: Date.now() + 60_000, limit: 500 } });
    expect(calls.count).toBe(1);
  });

  it("respects a configured threshold, and the model's batch is undoable", async () => {
    process.env.MODEL_AUTO_APPLY_THRESHOLD = "0.5";
    await runCategorization(db, { model: { classify: fakeModel(), limit: 500 } });
    expect((await byMerchant("Zipride Trip")).every((t) => t.categoryId === cat.Transport)).toBe(true);
    const [entry] = await db.select().from(commandLog).where(eq(commandLog.actor, "model"));
    await undoCommand(db, entry.id);
    expect((await byMerchant("Corner Bean Cafe")).every((t) => t.categoryId === null)).toBe(true);
  });

  it("sends the model description, amount and date only — no ids, accounts or merchants", async () => {
    let body = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return Response.json({ choices: [{ message: { content: '{"results":[]}' } }] });
    });
    const [t] = await byMerchant("Corner Bean Cafe");
    const cats = [{ id: cat.Coffee, label: "Coffee", kind: "expense" }];
    await classifyWithModel(cats, [t], { mode: "background", db });
    expect(body).toContain("CORNER BEAN CAFE");
    for (const leak of [t.id, t.accountId, cat.Coffee, "Corner Bean Cafe"]) expect(body).not.toContain(leak);
  });
});

describe("evaluateModel", () => {
  it("scores against the owner's categorizations and stores only aggregates", async () => {
    const coffee = await byMerchant("Corner Bean Cafe");
    const groceries = await byMerchant("Quillfield Market");
    const rides = await byMerchant("Zipride Trip");
    const label = async (rows: { id: string }[], categoryId: string) => {
      for (const r of rows.slice(0, 3)) {
        await execute(db, { operation: "transactions.setCategory", input: { transactionId: r.id, categoryId }, actor: "user", reason: "x" });
      }
    };
    await label(coffee, cat.Coffee);
    await label(groceries, cat.Dining); // the owner files these differently: the model will be "wrong"
    await label(rides, cat.Transport);

    const summary = await evaluateModel(db, { classify: fakeModel(), sampleSize: 30 });
    expect(summary).toMatchObject({ sampleSize: 9, correct: 6, wrong: 3, abstained: 0 });
    const at90 = summary.thresholds.find((t) => t.threshold === 0.9)!;
    expect(at90).toEqual({ threshold: 0.9, applied: 6, correct: 3 });
    expect(recommendedThreshold(summary.thresholds)).toBeNull();

    const stored = JSON.stringify(await db.select().from(modelEvals));
    expect(stored).not.toMatch(/CORNER|QUILLFIELD|ZIPRIDE/);
    for (const r of [...coffee, ...groceries]) expect(stored).not.toContain(r.id);
  });

  it("recommends the lowest threshold with no wrong auto-applied answers", () => {
    expect(
      recommendedThreshold([
        { threshold: 0.7, applied: 10, correct: 9 },
        { threshold: 0.85, applied: 8, correct: 8 },
        { threshold: 0.95, applied: 4, correct: 4 },
      ]),
    ).toBe(0.85);
  });
});
