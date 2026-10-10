import { describe, expect, it } from "vitest";
import { classifierRequest, parseClassifierReply } from "@/lib/categorize/classify";
import { modelTransaction, redactForModel, toolResult } from "@/lib/model/redact";

describe("modelTransaction", () => {
  it("carries description, amount and date only, even from a full row", () => {
    const fullRow = {
      id: "t1",
      accountId: "a1",
      externalId: "SF-123",
      description: "CORNER BEAN CAFE #12",
      amountCents: -425,
      postedOn: "2026-06-28",
      experiencedOn: null,
      payee: "Corner Bean",
      memo: "card 4321",
    };
    expect(modelTransaction(fullRow)).toEqual({ description: "CORNER BEAN CAFE #12", amount: "-$4.25", date: "2026-06-28" });
  });

  it("dates by experience date when set", () => {
    expect(modelTransaction({ description: "x", amountCents: -100, postedOn: "2026-03-01", experiencedOn: "2026-07-04" }).date).toBe("2026-07-04");
  });
});

describe("redactForModel", () => {
  it("strips sensitive keys at any depth and keeps the rest", () => {
    const value = {
      name: "Everyday Checking",
      balanceCents: 152010,
      availableBalance: 1,
      accountNumber: "000123",
      nested: [{ externalId: "x", encryptedSecret: "v1:…", institutionId: "CON-1", merchant: "Corner Bean Cafe" }],
      connection_id: "c1",
      apiKey: "k",
    };
    expect(redactForModel(value)).toEqual({ name: "Everyday Checking", nested: [{ merchant: "Corner Bean Cafe" }] });
  });

  it("serializes tool results redacted", () => {
    expect(JSON.parse(toolResult([{ id: "1", balanceCents: 5 }]))).toEqual([{ id: "1" }]);
  });
});

describe("classifier prompt and reply", () => {
  const categories = [
    { id: "uuid-coffee", label: "Coffee", kind: "expense" },
    { id: "uuid-groceries", label: "Food › Groceries", kind: "expense" },
  ];
  const txns = [
    { description: "SQ *CORNER BEAN CAFE", amountCents: -425, postedOn: "2026-06-28" },
    { description: "QUILLFIELD MARKET #0412", amountCents: -9104, postedOn: "2026-06-27" },
    { description: "MYSTERY", amountCents: -100, postedOn: "2026-06-26" },
  ];

  it("sends short codes, never category uuids, and constrains the reply to them", () => {
    const { messages, jsonSchema } = classifierRequest(categories, txns);
    const text = messages.map((m) => m.content).join("\n");
    expect(text).toContain("c1: Coffee (expense)");
    expect(text).not.toContain("uuid-");
    const item = (jsonSchema.schema.properties.results as { items: { properties: { category: { enum: string[] } } } }).items;
    expect(item.properties.category.enum).toEqual(["c1", "c2", "none"]);
  });

  it("maps codes back to ids, and turns 'none' into no answer", () => {
    const content = JSON.stringify({
      results: [
        { i: 0, category: "c1", confidence: 0.95 },
        { i: 1, category: "c2", confidence: 0.8 },
        { i: 2, category: "none", confidence: 0.3 },
      ],
    });
    expect(parseClassifierReply(content, categories, 3)).toEqual([
      { categoryId: "uuid-coffee", confidence: 0.95 },
      { categoryId: "uuid-groceries", confidence: 0.8 },
      { categoryId: null, confidence: 0 },
    ]);
  });

  it("treats a malformed, partial or duplicated reply as no answer, never a wrong one", () => {
    expect(parseClassifierReply("not json", categories, 2)).toEqual([
      { categoryId: null, confidence: 0 },
      { categoryId: null, confidence: 0 },
    ]);
    const dup = JSON.stringify({
      results: [
        { i: 0, category: "c1", confidence: 0.9 },
        { i: 0, category: "c2", confidence: 0.9 },
        { i: 7, category: "c2", confidence: 0.9 },
        { i: 1, category: "c99", confidence: 0.9 },
      ],
    });
    expect(parseClassifierReply(dup, categories, 2)).toEqual([
      { categoryId: "uuid-coffee", confidence: 0.9 },
      { categoryId: null, confidence: 0 },
    ]);
  });
});
