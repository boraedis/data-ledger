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
  // Epoch ms by which the call must be over, whatever the mode's budget —
  // for callers inside a time-limited function (the nightly cron) that
  // must stop in time to record what they did.
  deadline?: number;
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

type Budget = { coldStartMs: number; requestMs: number };

function prepare(request: ChatRequest, deps: ClientDeps, stream: boolean) {
  const config = modelConfig();
  if (!config) throw new ModelNotConfiguredError();
  const now = deps.now ?? Date.now;
  const base = BUDGETS[request.mode ?? "background"];
  const remaining = request.deadline ? request.deadline - now() : Infinity;
  if (remaining <= 0) throw new ModelUnavailableError("No time left before the deadline");
  const budget: Budget = { coldStartMs: Math.min(base.coldStartMs, remaining), requestMs: Math.min(base.requestMs, remaining) };
  const body = JSON.stringify({
    model: config.model,
    messages: request.messages,
    temperature: request.temperature ?? 0,
    max_tokens: request.maxTokens ?? 512,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    ...(request.tools?.length
      ? { tools: request.tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }
      : {}),
    ...(request.jsonSchema
      ? { response_format: { type: "json_schema", json_schema: { ...request.jsonSchema, strict: true } } }
      : {}),
  });
  return { config, body, budget, now };
}

/** Records one call in model_calls (no content, ever). */
function recorder(request: ChatRequest, deps: ClientDeps, started: number, now: () => number) {
  return async (status: "ok" | "error" | "unavailable", retries: number, extra: Partial<typeof modelCalls.$inferInsert> = {}) => {
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
}

/**
 * POSTs until the model answers with something other than a cold-start
 * status, sleeping between tries. `onWaiting` hears about each retry so a
 * caller can tell the owner the model is waking up.
 */
async function connect(
  config: NonNullable<ReturnType<typeof modelConfig>>,
  body: string,
  budget: Budget,
  deps: ClientDeps,
  started: number,
  record: ReturnType<typeof recorder>,
  onWaiting?: (retries: number) => Promise<void> | void,
): Promise<{ response: Response; retries: number }> {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let retries = 0;
  let delay = 2_000;
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
        await record("error", retries, { error: `timed out after ${budget.requestMs / 1000}s` });
        throw new ModelError("The model took too long to answer");
      }
      response = new Response(null, { status: 503 });
    }

    if (RETRYABLE.has(response.status)) {
      if (now() - started + delay > budget.coldStartMs) {
        await record("unavailable", retries, { error: `still ${response.status} after ${Math.round((now() - started) / 1000)}s` });
        throw new ModelUnavailableError("The model is still starting up; try again in a minute");
      }
      retries++;
      await onWaiting?.(retries);
      await sleep(delay);
      delay = Math.min(delay * 2, 15_000);
      continue;
    }

    if (!response.ok) {
      // Our own description only: the response body could echo the prompt.
      const reason = response.status === 401 ? "API key rejected (401)" : `HTTP ${response.status}`;
      await record("error", retries, { error: reason });
      throw new ModelError(`Model request failed: ${reason}`);
    }
    return { response, retries };
  }
}

export async function chat(request: ChatRequest, deps: ClientDeps = {}): Promise<ChatResult> {
  const { config, body, budget, now } = prepare(request, deps, false);
  const started = now();
  const record = recorder(request, deps, started, now);
  const { response, retries } = await connect(config, body, budget, deps, started, record);

  const data = (await response.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = data.choices?.[0]?.message;
  if (!message) {
    await record("error", retries, { error: "response had no message" });
    throw new ModelError("Model returned no message");
  }
  const usage = { promptTokens: data.usage?.prompt_tokens ?? null, completionTokens: data.usage?.completion_tokens ?? null };
  await record("ok", retries, usage);
  return {
    content: message.content ?? null,
    toolCalls: message.tool_calls ?? [],
    usage,
    latencyMs: Math.round(now() - started),
    coldStartRetries: retries,
  };
}

export type StreamEvent =
  // The model is cold and booting; `elapsedMs` since the first try.
  | { type: "waiting"; retries: number; elapsedMs: number }
  | { type: "delta"; text: string }
  | ({ type: "done" } & ChatResult);

/**
 * The same call, streamed (#11): text arrives as it's generated, and while
 * the model is cold the caller hears "waiting" instead of silence. Tool
 * calls arrive in pieces and are assembled; they come out whole in "done".
 */
export async function* chatStream(request: ChatRequest, deps: ClientDeps = {}): AsyncGenerator<StreamEvent> {
  const { config, body, budget, now } = prepare(request, deps, true);
  const started = now();
  const record = recorder(request, deps, started, now);

  // connect() reports retries through a callback; queue them so this
  // generator can yield them while the retry loop sleeps.
  const waiting: StreamEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const connecting = connect(config, body, budget, deps, started, record, (retries) => {
    waiting.push({ type: "waiting", retries, elapsedMs: Math.round(now() - started) });
    wake?.();
  }).finally(() => {
    finished = true;
    wake?.();
  });
  while (!finished || waiting.length) {
    if (waiting.length) {
      yield waiting.shift()!;
      continue;
    }
    await new Promise<void>((resolve) => (wake = resolve));
    wake = null;
  }
  const { response, retries } = await connecting;

  let content = "";
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: ChatResult["usage"] = { promptTokens: null, completionTokens: null };
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        };
        if (chunk.usage) usage = { promptTokens: chunk.usage.prompt_tokens ?? null, completionTokens: chunk.usage.completion_tokens ?? null };
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          yield { type: "delta", text: delta.content };
        }
        for (const part of delta?.tool_calls ?? []) {
          const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.arguments += part.function.arguments;
          calls.set(part.index, call);
        }
      }
    }
  } catch (error) {
    await record("error", retries, { error: error instanceof Error && error.name === "TimeoutError" ? "stream timed out" : "stream broke off" });
    throw new ModelError("The model's reply broke off");
  }

  await record("ok", retries, usage);
  yield {
    type: "done",
    content: content || null,
    toolCalls: [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({ id: c.id || `call_${index}`, type: "function" as const, function: { name: c.name, arguments: c.arguments || "{}" } })),
    usage,
    latencyMs: Math.round(now() - started),
    coldStartRetries: retries,
  };
}
