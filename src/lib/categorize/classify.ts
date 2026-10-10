import { z } from "zod";
import type { ChatMessage } from "@/lib/model/client";
import { modelTransaction, type ModelTransaction } from "@/lib/model/redact";

// The model's half of categorization: given the owner's categories and a
// batch of transactions, pick a category (or "none") with a confidence.
// Pure prompt building and parsing — calling the model and applying results
// is the pipeline's job (#6 phase 3), and the eval script uses this too.
//
// Categories go to the model as short codes ("c3"), not uuids: models copy
// short tokens reliably and mangle long ids. The reply is constrained by a
// JSON schema whose category field is an enum of exactly those codes, so
// the model can't invent a category — guided decoding makes anything else
// unrepresentable.

export type ClassifierCategory = { id: string; label: string; kind: string };
export type ClassifierInput = { description: string; amountCents: number; postedOn: string; experiencedOn?: string | null };
export type Classification = { categoryId: string | null; confidence: number };

const NONE = "none";

function codes(categories: ClassifierCategory[]) {
  return categories.map((c, i) => ({ code: `c${i + 1}`, ...c }));
}

export function classifierRequest(categories: ClassifierCategory[], txns: ClassifierInput[]) {
  const coded = codes(categories);
  const items: (ModelTransaction & { i: number })[] = txns.map((t, i) => ({ i, ...modelTransaction(t) }));

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You categorize personal bank transactions for one person's budget.",
        "For each transaction, pick the single best category code from the list, or \"none\" if none fits or you can't tell.",
        "Amounts are negative for money spent and positive for money received.",
        "Confidence is your probability (0 to 1) that the category is right. Be calibrated: use below 0.6 when a description is ambiguous, and \"none\" rather than a guess.",
        "Moving money between the person's own accounts, and paying off a credit card, are transfers, not spending.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        "Categories:",
        ...coded.map((c) => `${c.code}: ${c.label} (${c.kind})`),
        "",
        "Transactions:",
        JSON.stringify(items),
      ].join("\n"),
    },
  ];

  const jsonSchema = {
    name: "categorizations",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["results"],
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["i", "category", "confidence"],
            properties: {
              i: { type: "integer", minimum: 0, maximum: Math.max(txns.length - 1, 0) },
              category: { type: "string", enum: [...coded.map((c) => c.code), NONE] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
          },
        },
      },
    },
  };

  return { messages, jsonSchema, coded };
}

const Reply = z.object({
  results: z.array(z.object({ i: z.number().int(), category: z.string(), confidence: z.number().min(0).max(1) })),
});

/**
 * Maps the model's reply back to category ids, one entry per input
 * transaction. Anything missing, duplicated, out of range or unparseable
 * becomes "no answer" (null, 0) — a bad reply sends transactions to the
 * inbox, never to a wrong category.
 */
export function parseClassifierReply(content: string | null, categories: ClassifierCategory[], count: number): Classification[] {
  const results: Classification[] = Array.from({ length: count }, () => ({ categoryId: null, confidence: 0 }));
  let parsed: z.infer<typeof Reply>;
  try {
    parsed = Reply.parse(JSON.parse(content ?? ""));
  } catch {
    return results;
  }
  const byCode = new Map(codes(categories).map((c) => [c.code, c.id]));
  const seen = new Set<number>();
  for (const r of parsed.results) {
    if (r.i < 0 || r.i >= count || seen.has(r.i)) continue;
    seen.add(r.i);
    const categoryId = r.category === NONE ? null : (byCode.get(r.category) ?? null);
    results[r.i] = { categoryId, confidence: categoryId ? r.confidence : 0 };
  }
  return results;
}
