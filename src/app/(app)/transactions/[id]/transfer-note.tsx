"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { notATransfer } from "./actions";

// Shown on one side of a matched transfer (#24): where the money went or
// came from, and a way out if the match is wrong.
export function TransferNote({
  transactionId,
  otherId,
  otherAccountName,
  incoming,
}: {
  transactionId: string;
  otherId: string;
  otherAccountName: string;
  incoming: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3 text-sm">
      <p>
        <span className="font-medium">Transfer</span> {incoming ? "from" : "to"}{" "}
        <Link href={`/transactions/${otherId}`} className="underline">
          {otherAccountName}
        </Link>
        . Money moved between your own accounts, so it isn&apos;t spending or income and needs no category.
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await notATransfer(transactionId);
            setError("error" in result ? result.error : null);
          })
        }
      >
        Not a transfer
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
