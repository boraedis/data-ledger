import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { commandLog, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { createApiToken, revokeApiToken } from "@/lib/auth/api-tokens";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { createLedgerMcpHandler, toolName } from "@/mcp/server";
import { operations } from "@/operations/registry";

// A real MCP client talking to the handler over HTTP semantics, with fetch
// short-circuited straight into the handler — no server, no network.

let db: Db;
let handler: (request: Request) => Promise<Response>;
let token: string;
let tokenId: string;

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date("2026-06-30") });
  ({ token, id: tokenId } = await createApiToken(db, "test"));
  handler = createLedgerMcpHandler({ readDb: () => db, withWriteDb: (fn) => fn(db) });
});

async function connect(bearer: string | null = token) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://ledger.test/api/mcp"), {
    requestInit: bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : undefined,
    fetch: (input, init) => handler(new Request(input, init)),
  });
  await client.connect(transport);
  return client;
}

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text;
}

describe("MCP server", () => {
  it("rejects requests without a valid token", async () => {
    const response = await handler(new Request("http://ledger.test/api/mcp", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    await expect(connect(null)).rejects.toThrow();
    await expect(connect("dl_wrong")).rejects.toThrow();
  });

  it("rejects a revoked token", async () => {
    await revokeApiToken(db, tokenId);
    await expect(connect()).rejects.toThrow();
  });

  it("lists one tool per registered operation", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(operations.map((op) => toolName(op.name)).sort());
    const list = tools.find((t) => t.name === "transactions_list")!;
    expect(list.annotations?.readOnlyHint).toBe(true);
    const setCategory = tools.find((t) => t.name === "transactions_setCategory")!;
    expect(setCategory.inputSchema.required).toContain("reason");
    expect(setCategory.description).toMatch(/proposal/);
  });

  it("runs reads directly", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "transactions_list", arguments: { limit: 3 } });
    const rows = JSON.parse(textOf(result));
    expect(rows).toHaveLength(3);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["accountId", "amountCents", "categoryId", "description", "id", "postedOn"].sort(),
    );
  });

  it("turns writes into proposals and changes nothing", async () => {
    const client = await connect();
    const [txn] = await db.select().from(transactions).limit(1);
    const { categories } = await import("@/db/schema");
    const [category] = await db.select().from(categories).limit(1);

    const result = await client.callTool({
      name: "transactions_setCategory",
      arguments: { transactionId: txn.id, categoryId: category.id, reason: "Looks like groceries" },
    });
    expect(textOf(result)).toMatch(/^Proposed as/);

    const [after] = await db.select().from(transactions).limit(1);
    expect(after.categoryId).toBeNull();
    const [entry] = await db.select().from(commandLog);
    expect(entry).toMatchObject({ actor: "mcp", status: "proposed", reason: "Looks like groceries" });
  });

  it("reports invalid input as a tool error, not a crash", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "transactions_setCategory",
      arguments: { transactionId: "not-a-uuid", categoryId: null, reason: "x" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(await db.select().from(commandLog)).toHaveLength(0);
  });
});
