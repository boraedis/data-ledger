import { describe, expect, it } from "vitest";
import { keysFor } from "@/lib/spending/analyze";
import { consistentCategory, parseTypeReply, typeFromCategory, typeRequest } from "@/lib/merchants/types";

// Merchant type suggestions (#293): the pure parts.

const types = new Map([
  ["Restaurant", "t-rest"],
  ["Cafe", "t-cafe"],
  ["Grocery", "t-groc"],
  ["Gas station", "t-gas"],
]);

describe("typeFromCategory", () => {
  it("reads a type from a category name that says what kind of place it is, and nothing from one that doesn't", () => {
    expect(typeFromCategory("Dining", types)).toBe("t-rest");
    expect(typeFromCategory("Coffee shops", types)).toBe("t-cafe");
    expect(typeFromCategory("Food: Groceries", types)).toBe("t-groc");
    expect(typeFromCategory("Gifts", types)).toBeNull();
    expect(typeFromCategory("Shopping", types)).toBeNull();
    // A type the owner removed isn't suggested.
    expect(typeFromCategory("Pharmacy", types)).toBeNull();
  });
});

describe("consistentCategory", () => {
  it("needs a few categorized transactions, nearly all in one category", () => {
    expect(consistentCategory([{ categoryId: "a", n: 2 }])).toBeNull();
    expect(consistentCategory([{ categoryId: "a", n: 9 }, { categoryId: "b", n: 1 }])).toBe("a");
    expect(consistentCategory([{ categoryId: "a", n: 4 }, { categoryId: "b", n: 2 }])).toBeNull();
  });
});

describe("the model request and reply", () => {
  const options = [
    { id: "t-rest", name: "Restaurant" },
    { id: "t-cafe", name: "Cafe" },
  ];
  it("sends names only", () => {
    const { messages } = typeRequest(options, ["Corner Bean Cafe"]);
    const user = messages[1].content as string;
    expect(user).toContain('"name":"Corner Bean Cafe"');
    expect(user).not.toMatch(/amount|\$|\d{4}-\d{2}-\d{2}/i);
  });

  it("maps codes back to types, and turns anything malformed into no answer", () => {
    const reply = JSON.stringify({ results: [{ i: 1, type: "t2", confidence: 0.9 }, { i: 0, type: "none", confidence: 0.8 }, { i: 1, type: "t1", confidence: 0.99 }] });
    expect(parseTypeReply(reply, options, 2)).toEqual([
      { typeId: null, confidence: 0 },
      { typeId: "t-cafe", confidence: 0.9 },
    ]);
    expect(parseTypeReply("not json", options, 1)).toEqual([{ typeId: null, confidence: 0 }]);
  });
});

describe("Spending by type", () => {
  it("groups by the merchant's type, each opening into its merchants", () => {
    const line = { transactionId: "x", date: "2026-06-01", amountCents: -500, categoryId: "c", accountId: "a", merchant: "Corner Bean", merchantType: "Cafe" };
    const lookup = { categories: new Map(), accountNames: new Map() };
    expect(keysFor(line, "type", lookup)).toEqual({ key: "type:Cafe", label: "Cafe", child: { key: "type:Cafe|Corner Bean", label: "Corner Bean" } });
    expect(keysFor({ ...line, merchantType: null }, "type", lookup).label).toBe("No type yet");
  });
});
