"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { filterOptions, type CategoryOption } from "@/lib/categorize/labels";
import { formatCents } from "@/lib/money";
import { askModel, categorize, createMerchantRule } from "./actions";

export type InboxRow = {
  id: string;
  postedOn: string;
  amountCents: number;
  description: string;
  merchant: string | null;
  accountName: string;
  pending: boolean;
  suggestedCategoryId: string | null;
  suggestionSource: "memory" | "model" | null;
  suggestionConfidence: number | null;
};

const MAX_VISIBLE_OPTIONS = 8;

// Keyboard-first: the category filter keeps focus the whole time.
//   ↑ / ↓        previous / next transaction
//   type         filter categories
//   Tab          cycle through matches (Shift+Tab backwards)
//   Enter        assign the highlighted category
//   Shift+Enter  assign it AND create a rule for this merchant
//   Esc          clear the filter
function suggestionLabel(row: InboxRow, label: string | undefined) {
  if (!label) return null;
  if (row.suggestionSource === "model") return `Model suggests: ${label} (${Math.round((row.suggestionConfidence ?? 0) * 100)}%)`;
  return `From your history: ${label}`;
}

function AskModel() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Awaited<ReturnType<typeof askModel>> | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setResult(await askModel());
            router.refresh();
          })
        }
      >
        {pending ? "Asking the model… (can take a few minutes to wake)" : "Ask the model"}
      </Button>
      {result ? (
        "error" in result ? <span className="text-destructive">{result.error}</span> : <span className="text-muted-foreground">{result.message}</span>
      ) : null}
    </div>
  );
}

export function Inbox({ rows: serverRows, options, modelConfigured }: { rows: InboxRow[]; options: CategoryOption[]; modelConfigured: boolean }) {
  const router = useRouter();
  // Rows are the server's list minus ones categorized optimistically here.
  // Derived rather than copied into state, so a refresh (after memory
  // categorizes others) just flows through.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const rows = useMemo(() => serverRows.filter((r) => !hidden.has(r.id)), [serverRows, hidden]);
  // Selection is a transaction, not a list position: merchant memory can
  // remove rows above the cursor on any refresh, and a bare index would then
  // silently point at a different transaction. The index is only a fallback
  // for when the selected row itself disappears — the row that took its
  // place is the natural "next".
  const [anchor, setAnchor] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const found = anchor.id ? rows.findIndex((r) => r.id === anchor.id) : -1;
  const selected = found >= 0 ? found : Math.min(anchor.index, Math.max(rows.length - 1, 0));
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [alwaysRule, setAlwaysRule] = useState(false);
  const [notice, setNotice] = useState<{ text: string; offer?: { merchant: string; categoryId: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const current = rows[selected];
  const labelOf = useMemo(() => new Map(options.map((o) => [o.id, o.label])), [options]);

  const matches = useMemo(() => {
    const filtered = filterOptions(options, query);
    // With no filter, lead with the suggestion so Enter accepts it.
    if (!query && current?.suggestedCategoryId) {
      const suggestion = filtered.find((o) => o.id === current.suggestedCategoryId);
      if (suggestion) return [suggestion, ...filtered.filter((o) => o !== suggestion)];
    }
    return filtered;
  }, [options, query, current]);
  const visible = matches.slice(0, MAX_VISIBLE_OPTIONS);
  // Only highlight when Enter would actually do something: with no filter
  // and no suggestion, nothing is picked yet.
  const hasTarget = Boolean(query) || Boolean(current?.suggestedCategoryId);

  function select(index: number) {
    const clamped = Math.min(Math.max(index, 0), Math.max(rows.length - 1, 0));
    setAnchor({ id: rows[clamped]?.id ?? null, index: clamped });
    setQuery("");
    setHighlight(0);
  }

  function move(delta: number) {
    select(selected + delta);
  }

  function assign(option: CategoryOption | undefined, withRule: boolean) {
    // Clicking or tapping a category is always a deliberate choice; the
    // "type first" guard lives on the Enter key (hasTarget), where an empty
    // filter would otherwise pick the alphabetically first category.
    if (!current || !option) return;
    const row = current;
    setError(null);
    // Advance to the next row (or the previous, at the end of the list).
    const next = rows[selected + 1] ?? rows[selected - 1];
    setAnchor({ id: next?.id ?? null, index: selected });
    setHidden((h) => new Set(h).add(row.id));
    setQuery("");
    setHighlight(0);
    startTransition(async () => {
      const result = await categorize(row.id, option.id);
      if ("error" in result) {
        setHidden((h) => {
          const next = new Set(h);
          next.delete(row.id);
          return next;
        });
        setError(result.error);
        return;
      }
      let text = `${row.merchant ?? row.description} → ${option.label}`;
      let autoCount = result.autoCategorized;
      if (withRule && row.merchant) {
        const ruleResult = await createMerchantRule(row.merchant, option.id);
        if ("error" in ruleResult) setError(ruleResult.error);
        else {
          text += ` · rule created`;
          autoCount += ruleResult.autoCategorized;
        }
      }
      if (autoCount) text += ` · ${autoCount} more categorized automatically`;
      setNotice({ text, offer: !withRule && row.merchant ? { merchant: row.merchant, categoryId: option.id } : undefined });
      router.refresh();
    });
    inputRef.current?.focus();
  }

  function makeRule(offer: { merchant: string; categoryId: string }) {
    startTransition(async () => {
      const result = await createMerchantRule(offer.merchant, offer.categoryId);
      if ("error" in result) setError(result.error);
      else setNotice({ text: `Rule created: ${offer.merchant} → ${labelOf.get(offer.categoryId)}${result.autoCategorized ? ` · ${result.autoCategorized} more categorized` : ""}` });
      router.refresh();
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Tab") {
      event.preventDefault();
      if (visible.length) setHighlight((h) => (h + (event.shiftKey ? -1 : 1) + visible.length) % visible.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (hasTarget) assign(visible[highlight], event.shiftKey || alwaysRule);
      else setError("Type to pick a category first.");
    } else if (event.key === "Escape") {
      setQuery("");
      setHighlight(0);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="space-y-2">
        {notice ? <p className="text-sm text-muted-foreground">{notice.text}</p> : null}
        <p className="text-muted-foreground">Inbox zero — everything is categorized.</p>
      </div>
    );
  }

  // One picker, rendered in two places: a sticky side panel on desktop
  // (keyboard-driven, autofocused), and inline under the selected
  // transaction on phones — so categorizing never means scrolling past the
  // whole list, and the on-screen keyboard only opens when asked for.
  const picker = (variant: "panel" | "inline") => (
    <div className="space-y-2">
      <Input
        ref={variant === "panel" ? inputRef : undefined}
        autoFocus={variant === "panel"}
        placeholder="Type a category…"
        aria-label="Category"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
      />
      <ul className="space-y-1">
        {visible.map((option, i) => (
          <li key={option.id}>
            <button
              type="button"
              onClick={() => assign(option, alwaysRule)}
              className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${hasTarget && i === highlight ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
            >
              {option.label}
              {option.id === current?.suggestedCategoryId ? <span className="ml-1 text-xs opacity-75">(suggested)</span> : null}
            </button>
          </li>
        ))}
        {matches.length > visible.length ? (
          <li className="px-2 text-xs text-muted-foreground">{matches.length - visible.length} more — keep typing</li>
        ) : null}
      </ul>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={alwaysRule} onChange={(e) => setAlwaysRule(e.target.checked)} />
        Always for this merchant (creates a rule)
      </label>
      {current ? (
        <Link href={`/transactions/${current.id}`} className="block text-sm text-muted-foreground underline">
          Split, tag or date this transaction →
        </Link>
      ) : null}
      {variant === "panel" ? (
        <p className="text-xs text-muted-foreground">↑↓ move · Tab next match · Enter assign · Shift+Enter assign + rule</p>
      ) : null}
      {notice ? (
        <div className="space-y-1 rounded-md border p-2 text-sm">
          <p>{notice.text}</p>
          {notice.offer ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => makeRule(notice.offer!)}>
              Always categorize {notice.offer.merchant} this way
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );

  return (
    <div className="space-y-3">
      {modelConfigured ? <AskModel /> : null}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
        {/* min-w-0: long raw descriptions must truncate, not widen the page. */}
        <ul className="min-w-0 divide-y rounded-lg border" aria-label="Uncategorized transactions">
          {rows.map((row, i) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => {
                  select(i);
                  // Desktop: straight to typing. On phones the inline picker
                  // appears under the row instead; no keyboard pop-up.
                  if (window.matchMedia("(min-width: 768px)").matches) inputRef.current?.focus();
                }}
                className={`flex w-full min-w-0 items-start justify-between gap-3 px-3 py-2 text-left text-sm ${i === selected ? "bg-accent" : ""}`}
                aria-current={i === selected}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{row.merchant ?? row.description}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {row.postedOn} · {row.accountName}
                    {row.pending ? " · pending" : ""} · {row.description}
                  </span>
                  {row.suggestedCategoryId ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {suggestionLabel(row, labelOf.get(row.suggestedCategoryId))}
                    </span>
                  ) : null}
                </span>
                <span className={`shrink-0 tabular-nums ${row.amountCents > 0 ? "text-emerald-700 dark:text-emerald-400" : ""}`}>
                  {formatCents(row.amountCents)}
                </span>
              </button>
              {i === selected ? <div className="border-t bg-accent/40 p-3 md:hidden">{picker("inline")}</div> : null}
            </li>
          ))}
        </ul>

        <div className="hidden md:sticky md:top-4 md:block md:self-start">{picker("panel")}</div>
      </div>
    </div>
  );
}
