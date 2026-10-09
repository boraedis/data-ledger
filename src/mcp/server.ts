import { createMcpHandler } from "mcp-handler";
import { ZodError, z } from "zod";
import type { Db } from "@/db/types";
import { verifyApiToken } from "@/lib/auth/api-tokens";
import type { Operation } from "@/operations/define";
import { operations } from "@/operations/registry";
import { execute } from "@/operations/runtime";

// The MCP server is generated from the operations registry: one tool per
// operation, nothing maintained by hand. A new operation shows up here
// automatically, with its description and input schema.
//
// Reads run directly. Writes run with actor "mcp", which the runtime always
// turns into a proposal — the owner approves or rejects it on /activity —
// so a client holding a token can look at everything but change nothing on
// its own.

export type McpDeps = {
  // A database for reads (and the token check).
  readDb: () => Db;
  // A database that supports transactions, for writes.
  withWriteDb: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
};

// Many MCP clients (and the Claude API underneath them) only accept
// [a-zA-Z0-9_-] in tool names, so "transactions.list" → "transactions_list".
export function toolName(operationName: string): string {
  return operationName.replace(/\./g, "_");
}

const reason = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("One sentence on why this change should be made. The owner sees it when deciding whether to approve.");

const PROPOSAL_NOTE =
  " This doesn't change anything immediately: it creates a proposal that the owner approves or rejects in Data Ledger's Activity page.";

function text(value: string, isError = false) {
  return { content: [{ type: "text" as const, text: value }], ...(isError ? { isError: true } : {}) };
}

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) return `Invalid input: ${z.prettifyError(error)}`;
  return error instanceof Error ? error.message : "Something went wrong";
}

function registerOperation(server: Parameters<Parameters<typeof createMcpHandler>[0]>[0], op: Operation, deps: McpDeps) {
  if (op.kind === "read") {
    server.registerTool(
      toolName(op.name),
      { description: op.description, inputSchema: op.input, annotations: { readOnlyHint: true } },
      async (args) => {
        try {
          const result = await execute(deps.readDb(), { operation: op.name, input: args, actor: "mcp", reason: "" });
          return text(JSON.stringify(result.status === "read" ? result.output : result));
        } catch (error) {
          return text(errorMessage(error), true);
        }
      },
    );
    return;
  }

  server.registerTool(
    toolName(op.name),
    {
      description: op.description + PROPOSAL_NOTE,
      inputSchema: op.input.extend({ reason }),
      // Not read-only, but nothing is applied without the owner's approval.
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const { reason, ...input } = args as { reason: string } & Record<string, unknown>;
      try {
        const result = await deps.withWriteDb((db) =>
          execute(db, { operation: op.name, input, actor: "mcp", reason }),
        );
        if (result.status !== "proposed") {
          // The runtime always proposes for "mcp"; if that ever changes,
          // fail loudly rather than quietly reporting an applied write.
          throw new Error(`Expected a proposal, got "${result.status}"`);
        }
        return text(`Proposed as ${result.commandId}. Nothing has changed yet; the owner will approve or reject it.`);
      } catch (error) {
        return text(errorMessage(error), true);
      }
    },
  );
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

export function createLedgerMcpHandler(deps: McpDeps) {
  const mcp = createMcpHandler(
    (server) => {
      for (const op of operations) registerOperation(server, op, deps);
    },
    { serverInfo: { name: "data-ledger", version: "0.1.0" } },
  );

  // Every request is authenticated, including discovery and tools/list:
  // even the shape of the ledger's operations isn't for anonymous callers.
  return async (request: Request): Promise<Response> => {
    const tokenId = await verifyApiToken(deps.readDb(), bearerToken(request));
    if (!tokenId) {
      return Response.json(
        { error: "A valid API token is required (Authorization: Bearer dl_…). Create one in Data Ledger's Settings." },
        { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="data-ledger"' } },
      );
    }
    return mcp(request);
  };
}
