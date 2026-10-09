import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const original = process.env.CRON_SECRET;
afterEach(() => {
  process.env.CRON_SECRET = original;
});

// Only the rejections are tested here; a request that passes goes on to
// sync against the real database, which src/lib/sync/run.test.ts covers.
describe("cron sync route", () => {
  const call = (authorization?: string) =>
    GET(new Request("http://localhost/api/cron/sync", { headers: authorization ? { authorization } : {} }));

  it("rejects requests without the secret", async () => {
    process.env.CRON_SECRET = "a-long-enough-cron-secret";
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong-secret-of-some-length")).status).toBe(401);
  });

  it("rejects everything when CRON_SECRET is unset or too short", async () => {
    delete process.env.CRON_SECRET;
    expect((await call("Bearer ")).status).toBe(401);
    process.env.CRON_SECRET = "short";
    expect((await call("Bearer short")).status).toBe(401);
  });
});
