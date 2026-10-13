import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { categories, commandLog, tallyMessages, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { ModelUnavailableError, type ChatMessage, type ChatRequest, type StreamEvent } from "@/lib/model/client";
import { applySeed } from "@/lib/seed/apply";
import { runTurn, type TallyEvent } from "@/lib/tally/agent";
import { moneyForModel, runTool, toolSpecs } from "@/lib/tally/tools";
import { testDb } from "@/lib/test-utils/db";
import { approveProposal } from "@/operations/runtime";

// Tally against a scripted model: each round's reply is decided by a
// function of what the model was sent, so the tests also see exactly what
// reached it. All data synthetic (the seed).

let db: Db;
beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
});

type Round = { content?: string; toolCalls?: { name: string; arguments: Record<string, unknown> }[]; waiting?: number };

function scripted(rounds: ((messages: ChatMessage[]) => Round)[]) {
  const sent: ChatRequest[] = [];
  let i = 0;
  async function* chatStream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    sent.push(request);
    const round = rounds[Math.min(i++, rounds.length - 1)](request.messages);
    for (let w = 1; w <= (round.waiting ?? 0); w++) yield { type: "waiting", retries: w, elapsedMs: w * 2_000 };
    if (round.content) for (const word of round.content.split(/(?<= )/)) yield { type: "delta", text: word };
    yield {
      type: "done",
      content: round.content ?? null,
      toolCalls: (round.toolCalls ?? []).map((c, n) => ({ id: `call_${i}_${n}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
      usage: { promptTokens: null, completionTokens: null },
      latencyMs: 1,
      coldStartRetries: round.waiting ?? 0,
    };
  }
  return { chatStream: chatStream as never, sent };
}

async function collect(gen: AsyncGenerator<TallyEvent>) {
  const events: TallyEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("runTurn", () => {
  it("reads with a tool, answers from the result, and keeps the thread", async () => {
    const model = scripted([
      () => ({ toolCalls: [{ name: "transactions__inbox", arguments: { limit: 3 } }] }),
      (messages) => {
        const result = JSON.parse((messages.at(-1) as { content: string }).content) as unknown[];
        return { content: `You have ${result.length} to look at.` };
      },
    ]);
    const events = await collect(runTurn(db, { conversationId: null, text: "What's in my inbox?" }, model));
    const conversation = events.find((e) => e.type === "conversation") as { id: string };
    expect(events.filter((e) => e.type === "tool")).toEqual([{ type: "tool", operation: "transactions.inbox", kind: "read", ok: true }]);
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("")).toBe("You have 3 to look at.");
    expect(events.at(-1)).toEqual({ type: "done" });

    // The model got the system prompt, the tools, and the tool result.
    expect(model.sent[0].messages[0].role).toBe("system");
    expect(model.sent[0].tools?.length).toBe(toolSpecs().length);
    expect(model.sent[1].messages.at(-1)).toMatchObject({ role: "tool" });

    // Stored, and replayed on the next turn.
    const stored = await db.select().from(tallyMessages).where(eq(tallyMessages.conversationId, conversation.id));
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    const next = scripted([() => ({ content: "Still 3." })]);
    await collect(runTurn(db, { conversationId: conversation.id, text: "And now?" }, next));
    expect(next.sent[0].messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
  });

  it("turns a write into a proposal the owner approves, logged as tally", async () => {
    const [txn] = await db.select().from(transactions).limit(1);
    const [coffee] = await db.select().from(categories).where(eq(categories.name, "Coffee"));
    const model = scripted([
      () => ({ toolCalls: [{ name: "transactions__setCategory", arguments: { transactionId: txn.id, categoryId: coffee.id, reason: "It's a café" } }] }),
      () => ({ content: "I've proposed filing it under Coffee." }),
    ]);
    const events = await collect(runTurn(db, { conversationId: null, text: "File that as coffee" }, model));
    const proposal = events.find((e) => e.type === "proposal") as Extract<TallyEvent, { type: "proposal" }>;
    expect(proposal).toMatchObject({ operation: "transactions.setCategory", reason: "It's a café", input: { transactionId: txn.id, categoryId: coffee.id } });

    // Nothing changed yet.
    expect((await db.select().from(transactions).where(eq(transactions.id, txn.id)))[0].categoryId).toBeNull();
    const [logged] = await db.select().from(commandLog).where(eq(commandLog.id, proposal.commandId));
    expect(logged).toMatchObject({ actor: "tally", status: "proposed", reason: "It's a café" });

    await approveProposal(db, proposal.commandId);
    expect((await db.select().from(transactions).where(eq(transactions.id, txn.id)))[0].categoryId).toBe(coffee.id);
    const [applied] = await db.select().from(commandLog).where(eq(commandLog.id, proposal.commandId));
    expect(applied).toMatchObject({ actor: "tally", status: "applied", decidedBy: "user" });
  });

  it("passes the cold start through as waiting, and reports a model that never wakes", async () => {
    const model = scripted([() => ({ waiting: 2, content: "Morning." })]);
    const events = await collect(runTurn(db, { conversationId: null, text: "hi" }, model));
    expect(events.filter((e) => e.type === "waiting")).toHaveLength(2);

    async function* cold(): AsyncGenerator<StreamEvent> {
      yield { type: "waiting", retries: 1, elapsedMs: 2_000 };
      throw new ModelUnavailableError("still starting");
    }
    const failed = await collect(runTurn(db, { conversationId: null, text: "hi" }, { chatStream: cold as never }));
    expect(failed.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/waking up/) });
  });

  it("stops a model going in circles", async () => {
    const model = scripted([() => ({ toolCalls: [{ name: "categories__list", arguments: {} }] })]);
    const events = await collect(runTurn(db, { conversationId: null, text: "loop" }, model));
    expect(events.filter((e) => e.type === "tool")).toHaveLength(6);
    expect(events.find((e) => e.type === "message")).toMatchObject({ content: expect.stringMatching(/more steps/) });
  });
});

describe("the tool boundary", () => {
  it("offers only what Tally may run, and nothing that carries balances", () => {
    const names = toolSpecs().map((t) => t.name);
    expect(names).toContain("transactions__list");
    for (const hidden of ["import__applySnapshot", "transactions__applyCategories", "alerts__refresh", "accounts__createManual", "accounts__setManualValue"]) {
      expect(names).not.toContain(hidden);
    }
    expect(JSON.stringify(toolSpecs())).not.toMatch(/balanceCents/);
  });

  it("returns errors the model can act on, and redacts sensitive keys", async () => {
    expect(JSON.parse((await runTool(db, { name: "nope__nothing", arguments: "{}" })).content)).toEqual({ error: "There's no tool called nope__nothing." });
    expect(JSON.parse((await runTool(db, { name: "transactions__get", arguments: "not json" })).content).error).toMatch(/valid JSON/);
    expect(JSON.parse((await runTool(db, { name: "transactions__get", arguments: '{"transactionId":"x"}' })).content).error).toMatch(/Invalid input/);
    const accountsResult = (await runTool(db, { name: "accounts__list", arguments: "{}" })).content;
    expect(accountsResult).not.toMatch(/balance|externalId|connectionId/i);
  });

  it("gives the model money already formatted, never raw cents", async () => {
    expect(moneyForModel([{ amountCents: -1299, nested: { spentCents: 4550 }, description: "x", count: 3 }])).toEqual([
      { amount: "-$12.99", nested: { spent: "$45.50" }, description: "x", count: 3 },
    ]);
    const inbox = (await runTool(db, { name: "transactions__inbox", arguments: '{"limit": 2}' })).content;
    expect(inbox).not.toMatch(/Cents/);
    expect(inbox).toMatch(/"amount":"-?\$[\d,]+\.\d\d"/);
  });

  it("caps a huge result and says how to narrow it", async () => {
    const result = await runTool(db, { name: "transactions__list", arguments: JSON.stringify({ limit: 500 }) });
    expect(result.content.length).toBeLessThan(12_200);
    expect(result.content).toMatch(/Narrow the request/);
  });
});
