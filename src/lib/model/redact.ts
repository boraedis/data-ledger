import { formatCents } from "@/lib/money";

// The minimal-data rule (AGENTS.md), enforced here rather than trusted to
// each feature: the model sees what a transaction *is* — description,
// amount, date — and never balances, account numbers, provider ids or
// credentials.

export type ModelTransaction = { description: string; amount: string; date: string };

/**
 * The one sanctioned way to show a transaction to the model. Takes the
 * fields it needs by name, so adding a column to transactions can never
 * leak it here by accident.
 */
export function modelTransaction(t: { description: string; amountCents: number; postedOn: string; experiencedOn?: string | null }): ModelTransaction {
  return { description: t.description, amount: formatCents(t.amountCents), date: t.experiencedOn ?? t.postedOn };
}

// Keys that never reach the model, whatever object they're in. A backstop
// for tool results (#11), where operation outputs are passed through: those
// shapes are already minimal, and this catches the day one isn't.
const SENSITIVE_KEY = /balance|account.?number|routing|iban|external.?id|secret|token|password|api.?key|access.?url|credential|connection.?id|institution.?id/i;

export function redactForModel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForModel);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_KEY.test(key))
        .map(([key, v]) => [key, redactForModel(v)]),
    );
  }
  return value;
}

/** A tool result as the model will see it: redacted, then serialized. */
export function toolResult(value: unknown): string {
  return JSON.stringify(redactForModel(value));
}
