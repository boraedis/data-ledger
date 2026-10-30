"use client";

import { useState, useTransition } from "react";
import { ChangePreview, type Change } from "@/components/change-preview";
import { Button } from "@/components/ui/button";
import { deleteUnusedCategory, moveTransactions } from "./actions";

// The move's preview (#116), and afterwards the categories it left empty,
// each with a one-tap delete (categories.delete still checks it's unused).
export function MovePreview({
  categoryId,
  categoryName,
  changes,
  names,
}: {
  categoryId: string;
  categoryName: string;
  changes: Change[];
  names: Record<string, string>;
}) {
  const [unused, setUnused] = useState<string[]>([]);
  return (
    <div className="space-y-4">
      <ChangePreview
        // A fresh set of ticks once the moved rows drop out after refresh.
        key={changes.map((c) => c.transactionId).join()}
        changes={changes}
        onApply={async (ids) => {
          const result = await moveTransactions(categoryId, categoryName, ids);
          if (!("error" in result)) setUnused(result.unusedCategoryIds ?? []);
          return result;
        }}
      />
      {unused.length ? (
        <ul className="space-y-1 text-sm">
          {unused.map((id) => (
            <UnusedCategory key={id} id={id} name={names[id] ?? "A category"} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function UnusedCategory({ id, name }: { id: string; name: string }) {
  const [state, setState] = useState<"open" | "deleted" | { error: string }>("open");
  const [pending, startTransition] = useTransition();
  if (state === "deleted") return <li className="text-muted-foreground">Deleted {name}.</li>;
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span>{name} has nothing left in it.</span>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await deleteUnusedCategory(id, name);
            setState("error" in result ? result : "deleted");
          })
        }
      >
        Delete {name}
      </Button>
      {typeof state === "object" ? <span className="text-destructive">{state.error}</span> : null}
    </li>
  );
}
