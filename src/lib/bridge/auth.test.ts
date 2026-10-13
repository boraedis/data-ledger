import { afterEach, describe, expect, it } from "vitest";
import { GET as recurring } from "@/app/api/bridge/v1/recurring/route";
import { GET as dailySpend } from "@/app/api/bridge/v1/spend/daily/route";
import { bridgeAuthorized } from "@/lib/bridge/auth";

const original = process.env.BRIDGE_TOKEN;
afterEach(() => {
  process.env.BRIDGE_TOKEN = original;
});

const token = "a-bridge-token-that-is-long-enough-to-use";
const request = (path: string, authorization?: string) =>
  new Request(`http://localhost${path}`, { headers: authorization ? { authorization } : {} });

// Only rejections reach the routes here; answers are covered against a
// seeded database in v1.test.ts.
describe("bridge auth", () => {
  it("accepts only the exact bearer token", () => {
    process.env.BRIDGE_TOKEN = token;
    expect(bridgeAuthorized(request("/", `Bearer ${token}`))).toBe(true);
    expect(bridgeAuthorized(request("/"))).toBe(false);
    expect(bridgeAuthorized(request("/", token))).toBe(false);
    expect(bridgeAuthorized(request("/", `Bearer ${token}x`))).toBe(false);
  });

  it("refuses everything when BRIDGE_TOKEN is unset or too short", () => {
    delete process.env.BRIDGE_TOKEN;
    expect(bridgeAuthorized(request("/", "Bearer "))).toBe(false);
    process.env.BRIDGE_TOKEN = "short";
    expect(bridgeAuthorized(request("/", "Bearer short"))).toBe(false);
  });

  it("is checked by every route before anything else, and never cached", async () => {
    process.env.BRIDGE_TOKEN = token;
    for (const response of [
      await dailySpend(request("/api/bridge/v1/spend/daily?from=2026-06-01&to=2026-06-30")),
      await recurring(request("/api/bridge/v1/recurring", "Bearer wrong")),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("rejects a bad range once authorized, before touching the database", async () => {
    process.env.BRIDGE_TOKEN = token;
    const response = await dailySpend(request("/api/bridge/v1/spend/daily?from=2026-06-30&to=2026-06-01", `Bearer ${token}`));
    expect(response.status).toBe(400);
  });
});
