import { beforeEach, describe, expect, it } from "vitest";
import { digests } from "@/db/schema";
import type { Db } from "@/db/types";
import type { ChatRequest, ChatResult } from "@/lib/model/client";
import { applySeed } from "@/lib/seed/apply";
import { gatherFacts, latestDigest, writeDigest } from "@/lib/tally/digest";
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
    expect(await writeDigest(db, { today: "2026-06-30", chat })).toBe("- Note 1");
    expect(sent[0]).toMatchObject({ feature: "digest", mode: "background" });
    expect(sent[0].tools).toBeUndefined();
    expect(JSON.parse(sent[0].messages[1].content as string)).toMatchObject({ date: "2026-06-30" });

    await writeDigest(db, { today: "2026-06-30", chat });
    expect(await db.select().from(digests)).toHaveLength(1);
    expect(await latestDigest(db)).toMatchObject({ on: "2026-06-30", content: "- Note 2" });
  });

  it("writes nothing when the model can't be reached", async () => {
    const chat = async (): Promise<ChatResult> => {
      throw new Error("still starting");
    };
    expect(await writeDigest(db, { today: "2026-06-30", chat })).toBeNull();
    expect(await latestDigest(db)).toBeNull();
  });
});
