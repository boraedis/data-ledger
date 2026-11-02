"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addOtherHalf } from "./actions";

const select = "h-9 rounded-md border bg-background px-2 text-sm";
const field = "flex flex-col gap-1 text-xs text-muted-foreground";

// On an unpaired transfer (#24): the date, the opposite amount and the
// category are already known, so the owner only picks the account it went to
// or came from. The description is pre-filled and can be changed.
export function AddOtherHalf({
  transactionId,
  accounts,
  description,
}: {
  transactionId: string;
  accounts: { id: string; name: string }[];
  description: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3 rounded-lg border border-dashed p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(async () => {
          const result = await addOtherHalf(transactionId, String(data.get("accountId")), String(data.get("description") ?? ""));
          if (result && "error" in result) setError(result.error);
        });
      }}
    >
      <p>
        Add the other side here. It gets this one&apos;s date and the opposite amount, and both are paired as one transfer. Pick the account
        it went to or came from.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={field}>
          Account
          <select name="accountId" className={select} required defaultValue={accounts[0]?.id}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className={field}>
          Description
          <Input name="description" defaultValue={description} maxLength={200} required />
        </label>
      </div>
      <Button size="sm" type="submit" disabled={pending}>
        Add and pair
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
