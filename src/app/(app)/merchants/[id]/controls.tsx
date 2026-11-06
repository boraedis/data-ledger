"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { addMerchantType, mergeMerchants, renameMerchant, setMerchantType, splitAlias } from "../actions";
import { privateName } from "@/lib/privacy/names";

// The changes a merchant page offers (#286), each one operation, undoable
// in Activity: rename, set or clear its type (or add a type to the list),
// merge another merchant into this one, and split a name back out. Merging
// asks first, since it moves every transaction of the other one.

type Result = { error: string } | { ok: true; id?: string };

function useAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const go = (action: () => Promise<Result>, then?: (r: { ok: true; id?: string }) => void) =>
    start(async () => {
      const r = await action();
      if ("error" in r) return setError(r.error);
      setError(null);
      then?.(r);
      router.refresh();
    });
  return { pending, error, go };
}

const field = "h-9 min-w-0 rounded border bg-background px-2 text-sm";

export function MerchantControls({
  merchant,
  types,
  others,
}: {
  merchant: { id: string; name: string; typeId: string | null };
  types: { id: string; name: string }[];
  others: { id: string; name: string }[];
}) {
  const { pending, error, go } = useAction();
  const [name, setName] = useState(merchant.name);
  const [newType, setNewType] = useState("");
  const [mergeId, setMergeId] = useState("");
  const [mergedName, setMergedName] = useState<string | null>(null);
  const other = others.find((o) => o.id === mergeId);
  const finalName = (mergedName ?? merchant.name).trim();

  return (
    <section aria-label="Change this merchant" className="space-y-3 rounded-lg border p-3 text-sm">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== merchant.name) go(() => renameMerchant(merchant.id, name.trim()));
        }}
      >
        <label className="flex min-w-0 flex-1 flex-col text-xs text-muted-foreground">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${field} text-foreground`} maxLength={80} />
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={pending || !name.trim() || name.trim() === merchant.name}>
          Rename
        </Button>
      </form>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs text-muted-foreground">
          Type
          <select
            value={merchant.typeId ?? ""}
            disabled={pending}
            onChange={(e) => go(() => setMerchantType(merchant.id, e.target.value || null))}
            className={`${field} text-foreground`}
          >
            <option value="">No type</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = newType.trim();
            if (!n) return;
            // A new type is added to the list and given to this merchant: two operations, each undoable.
            go(
              () => addMerchantType(n),
              (r) => {
                setNewType("");
                if (r.id) go(() => setMerchantType(merchant.id, r.id!));
              },
            );
          }}
        >
          <label className="flex flex-col text-xs text-muted-foreground">
            Or a new type
            <input value={newType} onChange={(e) => setNewType(e.target.value)} placeholder="e.g. Bike shop" className={`${field} w-36 text-foreground`} maxLength={40} />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={pending || !newType.trim()}>
            Add
          </Button>
        </form>
      </div>

      {others.length ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col text-xs text-muted-foreground">
            Merge another merchant into this one
            <select value={mergeId} onChange={(e) => setMergeId(e.target.value)} className={`${field} text-foreground`}>
              <option value="">Pick a merchant…</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {privateName("merchant", o.name)}
                </option>
              ))}
            </select>
          </label>
          {other ? (
            // The merged merchant's name (#304): this one's unless changed, and it can be the other's.
            <label className="flex min-w-0 flex-col text-xs text-muted-foreground">
              Merged name
              <input
                value={mergedName ?? merchant.name}
                onChange={(e) => setMergedName(e.target.value)}
                list="merge-name-options"
                className={`${field} text-foreground sm:w-56`}
                maxLength={80}
              />
              <datalist id="merge-name-options">
                <option value={merchant.name} />
                <option value={other.name} />
              </datalist>
            </label>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !other || !finalName}
            onClick={() => {
              if (!other || !finalName) return;
              if (!window.confirm(`Merge "${privateName("merchant", other.name)}" into "${privateName("merchant", merchant.name)}" as "${privateName("merchant", finalName)}"? Its names and transactions move here. You can undo it in Activity.`)) return;
              go(
                () => mergeMerchants(merchant.id, other.id, finalName === merchant.name ? undefined : finalName),
                () => {
                  setMergeId("");
                  setMergedName(null);
                },
              );
            }}
          >
            Merge
          </Button>
        </div>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

export function SplitButton({ aliasId, alias }: { aliasId: string; alias: string }) {
  const { pending, error, go } = useAction();
  const router = useRouter();
  // The new merchant opens, once split; refreshed by the action too.
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        className="text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50"
        onClick={() => go(() => splitAlias(aliasId), (r) => r.id && router.push(`/merchants/${r.id}`))}
        aria-label={`Split "${alias}" out into a merchant of its own`}
      >
        Split out
      </button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
