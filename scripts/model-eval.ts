import "./load-env";
import { classifierRequest, parseClassifierReply, type ClassifierCategory } from "../src/lib/categorize/classify";
import { normalizeMerchant } from "../src/lib/categorize/merchant";
import { chat, ModelNotConfiguredError, type ToolSpec } from "../src/lib/model/client";
import { SEED_CATEGORIES, generateSeed } from "../src/lib/seed/generate";
import { describeOperations } from "../src/operations/registry";

// Scores the configured model (MODEL_BASE_URL) on the two jobs that decide
// which open-weight model to host (#39): categorizing transactions, and
// calling the app's operations as tools (what Tally does, #11).
//
// Synthetic data only — the seed's invented merchants — so the score can be
// committed and compared across models. Evals on the owner's own
// categorization history live in the database (#6 phase 3), never here.
//
//   npm run model:eval

const EXPECTED: [RegExp, string][] = [
  [/corner bean/i, "Coffee"],
  [/quillfield/i, "Groceries"],
  [/lucky noodle|patio grill|saffron|trattoria|harborside|smoke & ember/i, "Dining"],
  [/zipride/i, "Transport"],
  [/streamflix|tunebox|cloudlocker/i, "Subscriptions"],
  [/ironworks/i, "Fitness"],
  [/maplewood/i, "Rent"],
  [/power & light/i, "Utilities"],
  [/payroll/i, "Paycheck"],
  [/interest/i, "Interest"],
  [/transfer|card co payment|payment thank you|paypeer payment/i, "Transfers"],
  [/motor vehicles/i, "Car"],
];

function cases() {
  const { transactions } = generateSeed({ endDate: new Date("2026-06-30") });
  const byMerchant = new Map<string, (typeof transactions)[number]>();
  for (const t of transactions) byMerchant.set(normalizeMerchant(t.description), t);
  return [...byMerchant.values()].flatMap((t) => {
    const expected = EXPECTED.find(([pattern]) => pattern.test(t.description))?.[1];
    return expected ? [{ ...t, expected }] : [];
  });
}

const TOOL_CASES = [
  {
    ask: "How much did I spend at Corner Bean Cafe in June 2026?",
    check: (name: string, args: Record<string, unknown>) =>
      name === "transactions_list" && /corner bean/i.test(String(args.search ?? "")) && String(args.from ?? "").startsWith("2026-06"),
  },
  { ask: "What categories do I have?", check: (name: string) => name === "categories_list" },
  {
    ask: "Show my uncategorized transactions.",
    check: (name: string, args: Record<string, unknown>) =>
      (name === "transactions_inbox") || (name === "transactions_list" && args.uncategorized === true),
  },
];

async function evalCategorization() {
  const categories: ClassifierCategory[] = SEED_CATEGORIES.map((c, i) => ({ id: `cat-${i}`, label: c.name, kind: c.kind }));
  const items = cases();
  const { messages, jsonSchema } = classifierRequest(categories, items);
  const reply = await chat({ feature: "eval", messages, jsonSchema, maxTokens: 2048 });
  const results = parseClassifierReply(reply.content, categories, items.length);

  let correct = 0;
  const confidences = { right: [] as number[], wrong: [] as number[] };
  items.forEach((item, i) => {
    const got = categories.find((c) => c.id === results[i].categoryId)?.label ?? "none";
    const ok = got === item.expected;
    if (ok) correct++;
    (ok ? confidences.right : confidences.wrong).push(results[i].confidence);
    if (!ok) console.log(`  ✗ ${item.description} → ${got} (expected ${item.expected}, confidence ${results[i].confidence})`);
  });
  const mean = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "—");
  console.log(`Categorization: ${correct}/${items.length} correct`);
  console.log(`  mean confidence when right ${mean(confidences.right)}, when wrong ${mean(confidences.wrong)} (want: high vs. low)`);
  console.log(`  ${reply.latencyMs} ms, ${reply.coldStartRetries} cold-start retries, tokens ${reply.usage.promptTokens}→${reply.usage.completionTokens}`);
}

async function evalTools() {
  const tools: ToolSpec[] = describeOperations()
    .filter((op) => op.kind === "read")
    .map((op) => ({ name: op.name.replace(/\./g, "_"), description: op.description, parameters: op.inputSchema as Record<string, unknown> }));
  let passed = 0;
  for (const c of TOOL_CASES) {
    const reply = await chat({
      feature: "eval",
      messages: [
        { role: "system", content: "You help the owner of a personal finance app by calling its tools. Today is 2026-07-15." },
        { role: "user", content: c.ask },
      ],
      tools,
    });
    const call = reply.toolCalls[0];
    let args: Record<string, unknown> = {};
    try {
      args = call ? JSON.parse(call.function.arguments) : {};
    } catch {
      /* malformed arguments fail the check below */
    }
    const ok = Boolean(call) && c.check(call.function.name, args);
    if (ok) passed++;
    console.log(`  ${ok ? "✓" : "✗"} "${c.ask}" → ${call ? `${call.function.name}(${call.function.arguments})` : `no tool call: ${reply.content?.slice(0, 80)}`}`);
  }
  console.log(`Tool calling: ${passed}/${TOOL_CASES.length}`);
}

async function main() {
  try {
    await evalCategorization();
    await evalTools();
  } catch (error) {
    if (error instanceof ModelNotConfiguredError) {
      console.error("Set MODEL_BASE_URL and MODEL_API_KEY (in .env.local or the shell) to the model to evaluate.");
      process.exit(1);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
