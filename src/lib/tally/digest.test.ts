import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, balanceSnapshots, categories, digests, holdingSnapshots, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import type { ChatRequest, ChatResult } from "@/lib/model/client";
import { applySeed } from "@/lib/seed/apply";
import { formatCents } from "@/lib/money";
import { gatherFacts, latestDigest, summaryHeadline, writeDigest } from "@/lib/tally/digest";
import { testDb } from "@/lib/test-utils/db";
import { execute } from "@/operations/runtime";

// The nightly digest against a fake model, on the synthetic seed.

let db: Db;
beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
});

describe("digest", () => {
  it("gathers the day's facts without balances", async () => {
    await execute(db, { operation: "alerts.refresh", input: { on: "2026-06-30" }, actor: "matcher", reason: "test" });
    await execute(db, { operation: "budgets.setTarget", input: { categoryId: null, amountCents: 50_000, today: "2026-06-30" }, actor: "user", reason: "test" });
    const facts = await gatherFacts(db, "2026-06-30");
    expect(facts.inbox).toBeGreaterThan(0);
    expect(facts.alerts.map((a) => a.title)).toContain("Streamflix went up to $17.99");
    expect(facts.budgets[0]).toMatchObject({ name: "Everything else (buffer)", periodElapsed: "100%" });
    expect(JSON.stringify(facts)).not.toMatch(/balance/i);
  });

  it("asks the model with just the facts, stores the note beside them, and replaces it on a rerun", async () => {
    const sent: ChatRequest[] = [];
    const chat = async (request: ChatRequest): Promise<ChatResult> => {
      sent.push(request);
      return { content: `- Note ${sent.length}`, toolCalls: [], usage: { promptTokens: null, completionTokens: null }, latencyMs: 1, coldStartRetries: 0 };
    };
    // The seed's holdings add the fixed investments line after the note (#214).
    expect(await writeDigest(db, { today: "2026-06-30", chat })).toBe("- Note 1\n- Investments since 2026-06-29: holdings about flat.");
    expect(sent[0]).toMatchObject({ feature: "digest", mode: "background" });
    expect(sent[0].tools).toBeUndefined();
    expect(JSON.parse(sent[0].messages[1].content as string)).toMatchObject({ date: "2026-06-30" });

    await writeDigest(db, { today: "2026-06-30", chat });
    expect(await db.select().from(digests)).toHaveLength(1);
    expect((await latestDigest(db))?.content).toMatch(/^- Note 2\n/);
  });

  it("writes nothing when the model can't be reached", async () => {
    const chat = async (): Promise<ChatResult> => {
      throw new Error("still starting");
    };
    expect(await writeDigest(db, { today: "2026-06-30", chat })).toBeNull();
    expect(await latestDigest(db)).toBeNull();
  });

  describe("as the Inbox's summary (#214)", () => {
    const note = (content: string) => async (request: ChatRequest): Promise<ChatResult> => {
      sent.push(request);
      return { content, toolCalls: [], usage: { promptTokens: null, completionTokens: null }, latencyMs: 1, coldStartRetries: 0 };
    };
    let sent: ChatRequest[];
    beforeEach(() => {
      sent = [];
    });

    async function holdings(on: string, zqxCents: number, blndCents: number) {
      // Only these two days' positions, not the seed's own.
      await db.delete(holdingSnapshots).where(eq(holdingSnapshots.on, on));
      const [{ id }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, "Index Fund Account"));
      await db.insert(holdingSnapshots).values([
        { accountId: id, on, externalId: "zqx", symbol: "ZQX", description: "Zeta Quill Index", shares: "10", marketValueCents: zqxCents, currency: "USD" },
        { accountId: id, on, externalId: "blnd", symbol: "BLND", description: "Blend Bond Fund", shares: "100", marketValueCents: blndCents, currency: "USD" },
      ]);
    }

    it("calls out a $200 Dining target with $260 spent as over, by $60", async () => {
      const [{ id: dining }] = await db.select({ id: categories.id }).from(categories).where(eq(categories.name, "Dining"));
      const [{ id: card }] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, "Rewards Card"));
      await db.insert(transactions).values([
        { accountId: card, postedOn: "2026-06-10", amountCents: -16_000, description: "SALTMARSH BISTRO", merchant: "Saltmarsh Bistro", categoryId: dining, externalId: "d1" },
        { accountId: card, postedOn: "2026-06-24", amountCents: -10_000, description: "HARBOR NOODLE", merchant: "Harbor Noodle", categoryId: dining, externalId: "d2" },
      ]);
      await execute(db, { operation: "budgets.setTarget", input: { categoryId: dining, amountCents: 20_000, today: "2026-06-30" }, actor: "user", reason: "test" });
      const facts = await gatherFacts(db, "2026-06-30");
      expect(facts.budgets.find((b) => b.name === "Dining")).toMatchObject({ spent: "$260.00", over: true, overBy: "$60.00" });
      expect(facts.budgets.filter((b) => b.name !== "Dining").every((b) => b.overBy === null || b.over)).toBe(true);
    });

    it("adds big movers as fixed text after the model's note, and gives the model no holdings or balances", async () => {
      await holdings("2026-06-29", 100_000, 500_000);
      await holdings("2026-06-30", 108_000, 505_000);
      const content = await writeDigest(db, { today: "2026-06-30", chat: note("- All quiet tonight.") });
      expect(content).toBe("- All quiet tonight.\n- Investments since 2026-06-29: holdings up 2.2%.\n- Big movers: ZQX (Index Fund Account) up 8.0%.");
      expect(content).not.toContain("BLND");

      // Nothing the model is given carries a balance or a holding: no
      // holding names, and no account balance or position value, in
      // cents or as dollars.
      const given = sent[0].messages.map((m) => String(m.content)).join("\n");
      expect(given).not.toMatch(/ZQX|BLND|Zeta Quill|Blend Bond|investments/i);
      const balances = (await db.select({ c: balanceSnapshots.balanceCents }).from(balanceSnapshots)).map((r) => r.c);
      const positions = (await db.select({ c: holdingSnapshots.marketValueCents }).from(holdingSnapshots)).map((r) => r.c);
      expect(balances.length).toBeGreaterThan(0);
      for (const cents of [...balances, ...positions].filter((c) => Math.abs(c) >= 1_000_00)) {
        expect(given, String(cents)).not.toContain(formatCents(cents));
        expect(given, String(cents)).not.toContain(String(cents));
      }
      expect(JSON.parse(String(sent[0].messages[1].content))).not.toHaveProperty("fixed");
      expect((await latestDigest(db))?.facts).toMatchObject({ fixed: { investments: { from: "2026-06-29", to: "2026-06-30" } } });
    });

    it("keeps only the newest, with its time, and Home's line is its first", async () => {
      await writeDigest(db, { today: "2026-06-29", chat: note("- Old note.") });
      await writeDigest(db, { today: "2026-06-30", chat: note("- Two to categorize.\n- Dining is over by $60.00.") });
      const newest = await latestDigest(db);
      expect(newest).toMatchObject({ on: "2026-06-30" });
      expect(newest?.createdAt).toBeInstanceOf(Date);
      expect(summaryHeadline(newest!.content)).toBe("Two to categorize.");
    });
  });
});
