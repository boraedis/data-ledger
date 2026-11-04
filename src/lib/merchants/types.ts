import { z } from "zod";
import type { ChatMessage } from "@/lib/model/client";

// Suggesting a type for each merchant (#293). Two sources, both proposals
// the owner approves; neither ever sets a type itself:
//
// 1. From the merchant's usual category, when it's filed there consistently
//    and the category's name says what kind of place it is ("Dining" →
//    Restaurant). Deterministic, no model, tried first.
// 2. From the merchant's name alone, by the app's model: names only, never
//    amounts, dates, balances or account numbers. Below MIN_CONFIDENCE it
//    proposes nothing.
//
// Pure: prompt building, parsing and the category mapping. Asking the model
// and proposing is lib/merchants/suggest-types.ts.

export const MIN_CONFIDENCE = 0.7;
// "Consistently": at least this many categorized transactions, nearly all
// in one category.
export const MIN_CATEGORIZED = 3;
export const CONSISTENT_SHARE = 0.9;

// Words in a category's name that say what kind of merchant it is, mapped to
// a built-in type's name (drizzle/0038); a type the owner removed or renamed
// simply isn't found. Matched as whole words, case-
// insensitively; the first that matches wins, so specific before general.
const CATEGORY_WORDS: [RegExp, string][] = [
  [/\b(coffee|cafes?|caf[eé]s?)\b/i, "Cafe"],
  [/\b(groceries|grocery|supermarkets?)\b/i, "Grocery"],
  [/\b(gas|fuel|petrol)\b/i, "Gas station"],
  [/\b(dining|restaurants?|eating out|takeout|take-out)\b/i, "Restaurant"],
  [/\b(bars?|nightlife|alcohol)\b/i, "Bar"],
  [/\b(pharmacy|pharmacies|drugstore|prescriptions?)\b/i, "Pharmacy"],
  [/\b(streaming|subscriptions?)\b/i, "Subscription"],
  [/\b(utilities|utility|electric|electricity|water|internet)\b/i, "Utility"],
  [/\b(travel|hotels?|lodging|flights?|airfare|airlines?)\b/i, "Travel"],
  [/\b(rideshare|taxis?|transit|transport|transportation|parking)\b/i, "Transport"],
  [/\b(medical|doctors?|health ?care|healthcare|dental|dentist)\b/i, "Health"],
  [/\b(insurance)\b/i, "Insurance"],
  [/\b(entertainment|movies?|cinema|concerts?)\b/i, "Entertainment"],
  [/\b(taxes|tax)\b/i, "Government"],
];

/**
 * The type a category's name implies, among the types that exist, or null.
 * Only when the name clearly says what kind of place it is: "Shopping" or
 * "Gifts" say nothing about the store.
 */
export function typeFromCategory(categoryName: string, typeIds: Map<string, string>): string | null {
  const byName = new Map([...typeIds].map(([name, id]) => [name.toLowerCase(), id]));
  for (const [pattern, type] of CATEGORY_WORDS) if (pattern.test(categoryName)) return byName.get(type.toLowerCase()) ?? null;
  return null;
}

/** The merchant's one consistent category, from how its transactions are filed, or null. */
export function consistentCategory(counts: { categoryId: string; n: number }[]): string | null {
  const total = counts.reduce((s, c) => s + c.n, 0);
  if (total < MIN_CATEGORIZED) return null;
  const [top] = [...counts].sort((a, b) => b.n - a.n);
  return top.n / total >= CONSISTENT_SHARE ? top.categoryId : null;
}

export type TypeOption = { id: string; name: string };
export type TypeAnswer = { typeId: string | null; confidence: number };

const NONE = "none";
const codes = (types: TypeOption[]) => types.map((t, i) => ({ code: `t${i + 1}`, ...t }));

/** The model request for a batch of merchant names: names in, a type code (or none) and confidence out. */
export function typeRequest(types: TypeOption[], names: string[]) {
  const coded = codes(types);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You say what kind of business a merchant is, from its name alone, for one person's spending records.",
        "For each name, pick the single best type code from the list, or \"none\" if you can't tell from the name.",
        "Confidence is your probability (0 to 1) that the type is right. Be calibrated: a name that could be several kinds of business is below 0.6, or \"none\".",
      ].join(" "),
    },
    {
      role: "user",
      content: ["Types:", ...coded.map((t) => `${t.code}: ${t.name}`), "", "Merchants:", JSON.stringify(names.map((name, i) => ({ i, name })))].join("\n"),
    },
  ];
  const jsonSchema = {
    name: "merchant_types",
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
            required: ["i", "type", "confidence"],
            properties: {
              i: { type: "integer", minimum: 0, maximum: Math.max(names.length - 1, 0) },
              type: { type: "string", enum: [...coded.map((t) => t.code), NONE] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
          },
        },
      },
    },
  };
  return { messages, jsonSchema };
}

const Reply = z.object({ results: z.array(z.object({ i: z.number().int(), type: z.string(), confidence: z.number().min(0).max(1) })) });

/** One answer per name; anything missing, repeated or malformed is "no answer", never a wrong type. */
export function parseTypeReply(content: string | null, types: TypeOption[], count: number): TypeAnswer[] {
  const out: TypeAnswer[] = Array.from({ length: count }, () => ({ typeId: null, confidence: 0 }));
  let parsed: z.infer<typeof Reply>;
  try {
    parsed = Reply.parse(JSON.parse(content ?? ""));
  } catch {
    return out;
  }
  const byCode = new Map(codes(types).map((t) => [t.code, t.id]));
  const seen = new Set<number>();
  for (const r of parsed.results) {
    if (r.i < 0 || r.i >= count || seen.has(r.i)) continue;
    seen.add(r.i);
    const typeId = r.type === NONE ? null : (byCode.get(r.type) ?? null);
    out[r.i] = { typeId, confidence: typeId ? r.confidence : 0 };
  }
  return out;
}
