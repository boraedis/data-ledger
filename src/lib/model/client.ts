import { modelCalls } from "@/db/schema";
import type { Db } from "@/db/types";
import { modelConfig } from "@/lib/model/config";

// The gateway every AI feature calls: one OpenAI-compatible chat endpoint
// (vLLM on Modal; see model/serve.py). Plain fetch rather than an SDK:
// the surface used is small, and an SDK's provider abstractions are exactly
// the "swap in a hosted API" lever this app doesn't want.
//
// The server scales to zero, so the first request after idle meets a cold
// start: Modal answers 503 while the GPU boots and vLLM loads the weights.
// Background work (the nightly pipeline) waits that out; interactive work
// (chat) waits less and reports "the model is waking up" instead.

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type ChatRequest = {
  // Recorded with the call ("categorize", "tally", "digest", "test").
  feature: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  // Constrains the reply to JSON matching this schema (vLLM guided decoding).
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
  maxTokens?: number;
  mode?: "background" | "interactive";
};

export type ChatResult = {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { promptTokens: number | null; completionTokens: number | null };
  latencyMs: number;
  coldStartRetries: number;
};

export class ModelNotConfiguredError extends Error {
  constructor() {
    super("No model is configured (MODEL_BASE_URL / MODEL_API_KEY)");
  }
}
/** The model didn't become available within the wait budget — usually a cold start that ran long. */
export class ModelUnavailableError extends Error {}
export class ModelError extends Error {}

// How long to keep retrying through a cold start, and how long one request
// may take once the model is up. Measured on Modal (A100-80GB, weights
// cached on the volume): a cold start takes ~3.5 minutes, so even an
// interactive call must be willing to wait that long — the UI says the
// model is waking up rather than giving up first.
const BUDGETS = {
  background: { coldStartMs: 10 * 60_000, requestMs: 180_000 },
  interactive: { coldStartMs: 5 * 60_000, requestMs: 90_000 },
} as const;

const RETRYABLE = new Set([502, 503, 504]);

export type ClientDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Where to record the call. Omitted by tools like the eval script.
  db?: Db;
};

export function modelIsConfigured(): boolean {
  return modelConfig() !== null;
}

export async function chat(request: ChatRequest, deps: ClientDeps = {}): Promise<ChatResult> {
  const config = modelConfig();
  if (!config) throw new ModelNotConfiguredError();
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const budget = BUDGETS[request.mode ?? "background"];

  const body = JSON.stringify({
    model: config.model,
    messages: request.messages,
    temperature: request.temperature ?? 0,
    max_tokens: request.maxTokens ?? 512,
    ...(request.tools?.length
      ? { tools: request.tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }
      : {}),
    ...(request.jsonSchema
      ? { response_format: { type: "json_schema", json_schema: { ...request.jsonSchema, strict: true } } }
      : {}),
  });

  const started = now();
  let retries = 0;
  let delay = 2_000;
  const record = async (status: "ok" | "error" | "unavailable", extra: Partial<typeof modelCalls.$inferInsert> = {}) => {
    if (!deps.db) return;
    await deps.db.insert(modelCalls).values({
      feature: request.feature,
      status,
      startedAt: new Date(started),
      latencyMs: Math.round(now() - started),
      coldStartRetries: retries,
      ...extra,
    });
  };

  for (;;) {
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body,
        signal: AbortSignal.timeout(budget.requestMs),
      });
    } catch (error) {
      // A network error before the model answers is treated like a cold
      // start (the endpoint may be mid-boot); a timeout once it's up is not.
      if (error instanceof Error && error.name === "TimeoutError") {
        await record("error", { error: `timed out after ${budget.requestMs / 1000}s` });
        throw new ModelError("The model took too long to answer");
      }
      response = new Response(null, { status: 503 });
    }

    if (RETRYABLE.has(response.status)) {
      if (now() - started + delay > budget.coldStartMs) {
        await record("unavailable", { error: `still ${response.status} after ${Math.round((now() - started) / 1000)}s` });
        throw new ModelUnavailableError("The model is still starting up; try again in a minute");
      }
      retries++;
      await sleep(delay);
      delay = Math.min(delay * 2, 15_000);
      continue;
    }

    if (!response.ok) {
      // Our own description only: the response body could echo the prompt.
      const reason = response.status === 401 ? "API key rejected (401)" : `HTTP ${response.status}`;
      await record("error", { error: reason });
      throw new ModelError(`Model request failed: ${reason}`);
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = data.choices?.[0]?.message;
    if (!message) {
      await record("error", { error: "response had no message" });
      throw new ModelError("Model returned no message");
    }
    const usage = { promptTokens: data.usage?.prompt_tokens ?? null, completionTokens: data.usage?.completion_tokens ?? null };
    await record("ok", usage);
    return {
      content: message.content ?? null,
      toolCalls: message.tool_calls ?? [],
      usage,
      latencyMs: Math.round(now() - started),
      coldStartRetries: retries,
    };
  }
}
