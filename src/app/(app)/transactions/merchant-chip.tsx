"use client";

import { useRouter } from "next/navigation";

// A row's merchant, as the list tags it (#314, #333). The aim is for every
// merchant to have a type, so a missing one is a warning, like Uncategorized
// (#212), and opens the merchant's page, where the type is set. A row with
// no merchant gets a quiet chip: linking or making one is a different job
// (#291). A paired transfer between the owner's accounts gets neither.
//
// Each row is already one link to its transaction, and a link can't hold
// another, so the warning opens the merchant's page itself, without
// opening the transaction.

export function MerchantChip({ merchantId, merchantType, transfer }: { merchantId: string | null; merchantType: string | null; transfer: boolean }) {
  const router = useRouter();
  if (merchantType) return <span className="rounded bg-muted px-1.5 text-muted-foreground">{merchantType}</span>;
  if (merchantId) {
    const open = (e: React.SyntheticEvent) => {
      e.preventDefault();
      e.stopPropagation();
      router.push(`/merchants/${merchantId}`);
    };
    return (
      <span
        role="link"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && open(e)}
        title="Give this merchant a type"
        className="cursor-pointer rounded bg-warning/15 px-1.5 text-warning underline-offset-2 hover:underline"
      >
        No type
      </span>
    );
  }
  return transfer ? null : <span className="rounded bg-secondary px-1.5 text-muted-foreground">No merchant</span>;
}
