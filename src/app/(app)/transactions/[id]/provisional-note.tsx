"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { discardProvisional } from "./actions";

// On a provisional transaction (#30): where it came from, what happens
// when the bank reports it, and a way out if the charge never went through.
export function ProvisionalNote({ transactionId, source }: { transactionId: string; source: "email" | "apple_pay" }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3 text-sm">
      <p>
        <span className="font-medium">From {source === "email" ? "an email alert" : "Apple Pay"}</span>, not yet from the bank. When the bank
        reports it, this is replaced by the bank&apos;s version and anything you set here carries over.
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await discardProvisional(transactionId);
            if ("error" in result) setError(result.error);
            else router.push("/inbox#alerts");
          })
        }
      >
        Never charged — discard
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
