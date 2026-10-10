import { afterEach, describe, expect, it } from "vitest";
import { MAX_CHAIN_DEPTH, chainUrl, classifyLink } from "@/lib/categorize/classify-chain";
import type { CategorizationResult } from "@/lib/categorize/pipeline";

const base: CategorizationResult = { byRules: 0, byMemory: 0, byModel: 0, modelSeen: 0, modelPending: 0, remaining: 0 };
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

async function link(result: Partial<CategorizationResult>, depth = 0) {
  const triggered: number[] = [];
  let deadlineGiven = 0;
  const out = await classifyLink(depth, 300, {
    now: () => 1_000_000,
    run: async (deadline) => ((deadlineGiven = deadline), { ...base, ...result }),
    trigger: async (next) => void triggered.push(next),
  });
  return { out, triggered, deadlineGiven };
}

describe("classifyLink", () => {
  it("works until just before the function's own deadline", async () => {
    const { deadlineGiven } = await link({});
    expect(deadlineGiven).toBe(1_000_000 + 275_000);
  });

  it("stops when the model has nothing left", async () => {
    const { out, triggered } = await link({ modelSeen: 30, modelPending: 0 });
    expect(triggered).toEqual([]);
    expect(out.continued).toBe(false);
  });

  it("hands on when time ran out with work left", async () => {
    const { triggered } = await link({ modelSeen: 60, modelPending: 40 }, 2);
    expect(triggered).toEqual([3]);
  });

  it("hands on when the model was still booting — the next link finds it warm", async () => {
    const { triggered } = await link({ modelPending: 50, modelError: "The model is still starting up; try again in a minute" });
    expect(triggered).toEqual([1]);
  });

  it("doesn't hand on for errors that won't fix themselves", async () => {
    const { triggered } = await link({ modelPending: 50, modelError: "Model request failed: API key rejected (401)" });
    expect(triggered).toEqual([]);
  });

  it("never goes past the depth cap", async () => {
    const { triggered } = await link({ modelPending: 50 }, MAX_CHAIN_DEPTH);
    expect(triggered).toEqual([]);
  });
});

describe("chainUrl", () => {
  it("prefers the canonical origin over a deployment URL", () => {
    process.env.WEBAUTHN_ORIGIN = "https://ledger.example.test";
    expect(chainUrl("https://ledger-abc123.vercel.app/api/cron/sync")).toBe("https://ledger.example.test/api/cron/classify");
    delete process.env.WEBAUTHN_ORIGIN;
    expect(chainUrl("http://localhost:3100/api/cron/sync")).toBe("http://localhost:3100/api/cron/classify");
  });
});
