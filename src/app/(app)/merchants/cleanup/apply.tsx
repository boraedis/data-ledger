"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { rederiveMerchants } from "../actions";

// The one button that applies the preview (#288): a single command, undone
// from Activity like any other.

export function ApplyCleanup({ transactions }: { transactions: number }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ error: string } | { changed: number } | null>(null);
  const router = useRouter();
  if (result && "changed" in result)
    return (
      <p role="status" className="text-sm">
        Updated {result.changed} transaction{result.changed === 1 ? "" : "s"}. It&apos;s one change in{" "}
        <Link href="/activity" className="underline">
          Activity
        </Link>{" "}
        and can be undone there.
      </p>
    );
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await rederiveMerchants();
            setResult("error" in r ? r : { changed: r.changed });
            if (!("error" in r)) router.refresh();
          })
        }
      >
        {pending ? "Applying…" : `Apply to ${transactions} transaction${transactions === 1 ? "" : "s"}`}
      </Button>
      {result && "error" in result ? <span className="text-sm text-destructive">{result.error}</span> : null}
    </div>
  );
}
