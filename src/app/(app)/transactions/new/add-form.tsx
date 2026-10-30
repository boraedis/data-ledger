"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addTransaction } from "./actions";

const select = "h-9 rounded-md border bg-background px-2 text-sm";
const field = "flex flex-col gap-1 text-xs text-muted-foreground";

/** "12.5" → 1250. Exact cents only: a third decimal is a typo, not something to round. */
export function toCents(text: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.replace(/[$,\s]/g, ""));
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

export function AddForm({
  accounts,
  categories,
  today,
}: {
  accounts: { id: string; name: string }[];
  categories: { id: string; label: string }[];
  today: string;
}) {
  const router = useRouter();
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="max-w-lg space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const cents = toCents(String(data.get("amount") ?? ""));
        if (cents === null) return setError("Enter the amount in dollars and cents, like 42.50");
        startTransition(async () => {
          const result = await addTransaction({
            accountId: String(data.get("accountId")),
            postedOn: String(data.get("postedOn")),
            amountCents: direction === "out" ? -cents : cents,
            description: String(data.get("description") ?? ""),
            categoryId: String(data.get("categoryId") ?? "") || null,
          });
          if ("error" in result) setError(result.error);
          else router.push(`/transactions/${result.transactionId}`);
        });
      }}
    >
      <fieldset className="flex gap-4">
        <legend className="sr-only">Money out or in</legend>
        {(["out", "in"] as const).map((d) => (
          <label key={d} className="flex items-center gap-2">
            <input type="radio" name="direction" checked={direction === d} onChange={() => setDirection(d)} />
            {d === "out" ? "Money out" : "Money in"}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={field}>
          Amount
          <Input name="amount" inputMode="decimal" placeholder="42.50" required autoFocus />
        </label>
        <label className={field}>
          Date
          <Input name="postedOn" type="date" required max={today} defaultValue={today} />
        </label>
      </div>
      <label className={field}>
        Description
        <Input name="description" required maxLength={200} placeholder="Dinner with Alex" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={field}>
          Account the money moved through
          <select name="accountId" className={select} defaultValue={accounts[0]?.id}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className={field}>
          Category
          <select name="categoryId" className={select} defaultValue="">
            <option value="">Later (rules, then the inbox)</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? <p className="text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        Add transaction
      </Button>
    </form>
  );
}
