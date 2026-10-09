import { randomBytes } from "crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

beforeEach(() => {
  process.env.CONNECTION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("secret encryption", () => {
  it("round-trips, with a fresh IV each time", () => {
    const secret = "https://user:pass@bridge.example/simplefin";
    const a = encryptSecret(secret);
    expect(decryptSecret(a)).toBe(secret);
    expect(encryptSecret(secret)).not.toBe(a);
    expect(a).not.toContain("pass");
  });

  it("rejects tampering", () => {
    const parts = encryptSecret("hello").split(":");
    const ct = Buffer.from(parts[3], "base64url");
    ct[0] ^= 1;
    parts[3] = ct.toString("base64url");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("fails with the wrong key", () => {
    const stored = encryptSecret("hello");
    process.env.CONNECTION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptSecret(stored)).toThrow();
  });

  it("refuses a missing or short key", () => {
    process.env.CONNECTION_ENCRYPTION_KEY = "c2hvcnQ=";
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });
});
