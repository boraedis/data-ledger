import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

function production() {
  process.env.VERCEL_ENV = "production";
  process.env.WEBAUTHN_ORIGIN = "https://ledger.example.test";
}

describe("proxy", () => {
  it("sends production deployment URLs to the canonical domain, keeping path and query", () => {
    production();
    const response = proxy(new NextRequest("https://ledger-abc123-someone.vercel.app/activity?x=1"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://ledger.example.test/activity?x=1");
  });

  it("never redirects cron routes, which may arrive on a deployment URL", () => {
    production();
    const response = proxy(new NextRequest("https://ledger-abc123-someone.vercel.app/api/cron/sync"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("never redirects the bridge, whose server caller may not follow one", () => {
    production();
    const response = proxy(new NextRequest("https://ledger-abc123-someone.vercel.app/api/bridge/v1/recurring"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("leaves the canonical domain alone", () => {
    production();
    const response = proxy(new NextRequest("https://ledger.example.test/login"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("never redirects previews", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.WEBAUTHN_ORIGIN = "https://ledger.example.test";
    const response = proxy(new NextRequest("https://ledger-git-branch-someone.vercel.app/login"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("lets the cron route through to its own secret check, as an exact path", () => {
    expect(proxy(new NextRequest("http://localhost/api/cron/sync")).status).toBe(200);
    expect(proxy(new NextRequest("http://localhost/api/cron/classify")).status).toBe(200);
    expect(proxy(new NextRequest("http://localhost/api/cron/other")).status).toBe(401);
  });

  it("lets the bridge routes through to their own token check, as exact paths", () => {
    expect(proxy(new NextRequest("http://localhost/api/bridge/v1/spend/daily?from=2026-01-01&to=2026-01-31")).status).toBe(200);
    expect(proxy(new NextRequest("http://localhost/api/bridge/v1/recurring")).status).toBe(200);
    expect(proxy(new NextRequest("http://localhost/api/bridge/v1/transactions")).status).toBe(401);
  });

  it("serves the installable app's static pieces without a session, and nothing else under them", () => {
    for (const path of ["/manifest.webmanifest", "/sw.js", "/icons/apple-touch-icon.png", "/icons/icon-192.png"]) {
      expect(proxy(new NextRequest(`http://localhost${path}`)).status).toBe(200);
    }
    expect(proxy(new NextRequest("http://localhost/icons/other.png")).headers.get("location")).toBe("http://localhost/login");
  });

  it("lets the sign-in routes through without a session", () => {
    expect(proxy(new NextRequest("http://localhost/login")).status).toBe(200);
    expect(proxy(new NextRequest("http://localhost/api/auth/login/options")).status).toBe(200);
  });

  it("gates pages and other API routes without a session", () => {
    expect(proxy(new NextRequest("http://localhost/activity")).headers.get("location")).toBe("http://localhost/login");
    expect(proxy(new NextRequest("http://localhost/api/anything")).status).toBe(401);
  });
});
