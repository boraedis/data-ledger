import { expect, it } from "vitest";
import { formatCents } from "@/lib/money";

it("formats cents as dollars, and never prints a negative zero", () => {
  expect(formatCents(123456)).toBe("$1,234.56");
  expect(formatCents(-1299)).toBe("-$12.99");
  expect(formatCents(-0)).toBe("$0.00");
});
