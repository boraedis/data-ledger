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

  it("lets /api/mcp through to its own token check, but only that exact path", () => {
    expect(proxy(new NextRequest("http://localhost/api/mcp")).status).toBe(200);
    expect(proxy(new NextRequest("http://localhost/api/mcp-other")).status).toBe(401);
  });

  it("gates pages and other API routes without a session", () => {
    expect(proxy(new NextRequest("http://localhost/activity")).headers.get("location")).toBe("http://localhost/login");
    expect(proxy(new NextRequest("http://localhost/api/anything")).status).toBe(401);
  });
});
