import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/types";
import { createApiToken, listApiTokens, revokeApiToken, verifyApiToken } from "@/lib/auth/api-tokens";
import { testDb } from "@/lib/test-utils/db";

let db: Db;
beforeEach(async () => {
  db = await testDb();
});

describe("API tokens", () => {
  it("verifies a fresh token and records its use", async () => {
    const { id, token } = await createApiToken(db, "Laptop");
    expect(token).toMatch(/^dl_[\w-]{43}$/);
    expect(await verifyApiToken(db, token)).toBe(id);
    const [row] = await listApiTokens(db);
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("stores only a hash", async () => {
    const { token } = await createApiToken(db, "Laptop");
    const rows = await db.query.apiTokens.findMany();
    expect(JSON.stringify(rows)).not.toContain(token.slice(3));
  });

  it("rejects unknown, malformed and missing tokens", async () => {
    await createApiToken(db, "Laptop");
    for (const bad of [undefined, null, "", "dl_nope", "Bearer x", "not-even-prefixed"]) {
      expect(await verifyApiToken(db, bad)).toBeNull();
    }
  });

  it("stops accepting a revoked token", async () => {
    const { id, token } = await createApiToken(db, "Laptop");
    await revokeApiToken(db, id);
    expect(await verifyApiToken(db, token)).toBeNull();
  });
});
