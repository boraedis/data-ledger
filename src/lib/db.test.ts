import { describe, expect, it } from "vitest";
import { describeDatabaseUrlProblem } from "@/lib/db";

const good = "postgresql://user:secret@ep-example-123.us-east-2.aws.neon.tech/db?sslmode=require";

describe("describeDatabaseUrlProblem", () => {
  it("accepts a bare connection string", () => {
    expect(describeDatabaseUrlProblem(good)).toBeNull();
    expect(describeDatabaseUrlProblem(good.replace("postgresql", "postgres"))).toBeNull();
  });

  it.each([
    [undefined, /not set/],
    ["", /not set/],
    [`${good}\n`, /whitespace/],
    [`'${good}'`, /quotes/],
    [`psql '${good}'`, /psql/],
    ["mysql://x", /must start/],
  ])("flags %j", (value, message) => {
    expect(describeDatabaseUrlProblem(value)).toMatch(message);
  });

  it("never includes the value itself", () => {
    for (const value of [`'${good}'`, `psql '${good}'`, ` ${good}`]) {
      expect(describeDatabaseUrlProblem(value)).not.toContain("secret");
    }
  });
});
