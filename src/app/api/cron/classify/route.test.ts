import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

// Only the guard and the immediate reply are tested here; the chain's
// decisions are in src/lib/categorize/classify-chain.test.ts and the work
// in model-step.test.ts.
describe("cron classify route", () => {
  const call = (authorization?: string) =>
    GET(new Request("http://localhost/api/cron/classify", { headers: authorization ? { authorization } : {} }));

  it("rejects requests without the secret", async () => {
    process.env.CRON_SECRET = "a-long-enough-cron-secret";
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong-secret-of-some-length")).status).toBe(401);
  });

  it("skips cleanly when no model is configured", async () => {
    process.env.CRON_SECRET = "a-long-enough-cron-secret";
    delete process.env.MODEL_BASE_URL;
    const response = await call("Bearer a-long-enough-cron-secret");
    expect(await response.json()).toEqual({ skipped: "no model configured" });
  });
});
