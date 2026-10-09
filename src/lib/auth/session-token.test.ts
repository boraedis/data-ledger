import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_TTL_SECONDS, issueSessionToken, readSessionToken } from "@/lib/auth/session-token";

beforeEach(() => {
  process.env.SESSION_SECRET = "test-secret-that-is-at-least-32-characters";
});

describe("session tokens", () => {
  it("round-trips a freshly issued token", () => {
    const { token, id } = issueSessionToken();
    expect(readSessionToken(token)).toBe(id);
  });

  it("rejects an expired token", () => {
    const issuedAt = Date.now();
    const { token } = issueSessionToken(issuedAt);
    expect(readSessionToken(token, issuedAt + SESSION_TTL_SECONDS * 1000 + 1)).toBeNull();
  });

  it("rejects a token whose expiry was pushed out", () => {
    const { token } = issueSessionToken();
    const [id, , sig] = token.split(".");
    expect(readSessionToken(`${id}.${Date.now() + 10 ** 10}.${sig}`)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const { token } = issueSessionToken();
    process.env.SESSION_SECRET = "a-different-secret-also-32-characters-long";
    expect(readSessionToken(token)).toBeNull();
  });

  it("rejects malformed input", () => {
    for (const bad of [undefined, null, "", "abc", "a.b", "a.b.c.d"]) {
      expect(readSessionToken(bad)).toBeNull();
    }
  });

  it("refuses to run with a short secret", () => {
    process.env.SESSION_SECRET = "too-short";
    expect(() => issueSessionToken()).toThrow(/SESSION_SECRET/);
  });
});
