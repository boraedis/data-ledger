import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelCalls } from "@/db/schema";
import type { Db } from "@/db/types";
import { testDb } from "@/lib/test-utils/db";
import { ModelError, ModelNotConfiguredError, ModelUnavailableError, chat } from "@/lib/model/client";
import { modelConfig } from "@/lib/model/config";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

function configure() {
  process.env.MODEL_BASE_URL = "https://ledger-model.example.test/v1";
  process.env.MODEL_API_KEY = "test-key-that-is-long-enough-0123";
}

// A fake clock: sleep advances it, so cold-start budgets are exercised
// without real waiting.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const reply = (content: string) => ok({ choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });

let db: Db;
beforeEach(async () => {
  db = await testDb();
  configure();
});

describe("modelConfig", () => {
  it("is null when not configured, and defaults the model name", () => {
    delete process.env.MODEL_BASE_URL;
    expect(modelConfig()).toBeNull();
    configure();
    expect(modelConfig()).toMatchObject({ baseUrl: "https://ledger-model.example.test/v1", model: "ledger" });
  });

  it("requires https except on this machine", () => {
    process.env.MODEL_BASE_URL = "http://ledger-model.example.test/v1";
    expect(() => modelConfig()).toThrow(/https/);
    process.env.MODEL_BASE_URL = "http://localhost:11434/v1";
    expect(modelConfig()?.baseUrl).toBe("http://localhost:11434/v1");
  });
});

describe("chat", () => {
  it("throws a clear error when no model is configured", async () => {
    delete process.env.MODEL_API_KEY;
    await expect(chat({ feature: "test", messages: [] })).rejects.toBeInstanceOf(ModelNotConfiguredError);
  });

  it("sends an OpenAI-compatible request with the key, tools and schema", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const result = await chat(
      {
        feature: "test",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "categories_list", description: "List categories", parameters: { type: "object" } }],
        jsonSchema: { name: "x", schema: { type: "object" } },
      },
      { fetch: (async (url: string, init: RequestInit) => ((sent = { url, init }), reply("OK"))) as typeof fetch },
    );
    expect(result.content).toBe("OK");
    expect(sent!.url).toBe("https://ledger-model.example.test/v1/chat/completions");
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key-that-is-long-enough-0123");
    const body = JSON.parse(sent!.init.body as string);
    expect(body).toMatchObject({ model: "ledger", temperature: 0, tool_choice: "auto" });
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "categories_list", description: "List categories", parameters: { type: "object" } } });
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "x", strict: true } });
  });

  it("waits out a cold start (503s) and records how many retries it took", async () => {
    const c = clock();
    let calls = 0;
    const result = await chat(
      { feature: "categorize", messages: [{ role: "user", content: "secret description" }] },
      { db, now: c.now, sleep: c.sleep, fetch: (async () => (++calls < 4 ? new Response(null, { status: 503 }) : reply("OK"))) as typeof fetch },
    );
    expect(result.coldStartRetries).toBe(3);
    const [row] = await db.select().from(modelCalls);
    expect(row).toMatchObject({ feature: "categorize", status: "ok", coldStartRetries: 3, promptTokens: 12, completionTokens: 3 });
  });

  it("gives up after the cold-start budget, shorter for interactive calls", async () => {
    const c = clock();
    const always503 = (async () => new Response(null, { status: 503 })) as typeof fetch;
    await expect(chat({ feature: "tally", mode: "interactive", messages: [] }, { db, now: c.now, sleep: c.sleep, fetch: always503 })).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(c.now()).toBeLessThanOrEqual(150_000);
    const [row] = await db.select().from(modelCalls);
    expect(row.status).toBe("unavailable");
  });

  it("reports a rejected key without echoing the server's response", async () => {
    const leaky = (async () => new Response("prompt was: secret description", { status: 401 })) as typeof fetch;
    await expect(chat({ feature: "test", messages: [] }, { db, fetch: leaky })).rejects.toThrow(/API key rejected/);
    const [row] = await db.select().from(modelCalls);
    expect(row).toMatchObject({ status: "error", error: "API key rejected (401)" });
  });

  it("treats a timeout once the model is up as an error, not a cold start", async () => {
    const timeout = (async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as typeof fetch;
    await expect(chat({ feature: "test", messages: [] }, { db, fetch: timeout })).rejects.toBeInstanceOf(ModelError);
  });

  it("never records prompt or response content", async () => {
    await chat({ feature: "test", messages: [{ role: "user", content: "CORNER BEAN CAFE -4.25" }] }, { db, fetch: (async () => reply("Coffee")) as typeof fetch });
    const rows = await db.select().from(modelCalls);
    expect(JSON.stringify(rows)).not.toMatch(/CORNER BEAN|Coffee/);
  });

  it("records nothing without a db (e.g. the eval script)", async () => {
    await chat({ feature: "eval", messages: [] }, { fetch: (async () => reply("OK")) as typeof fetch });
    expect(await db.select().from(modelCalls)).toHaveLength(0);
  });
});
