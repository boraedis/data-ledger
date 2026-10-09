"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { categoryOptions, type CategoryRow } from "@/lib/categorize/labels";
import * as actions from "./actions";

type Result = Awaited<ReturnType<typeof actions.runRulesNow>>;

export type RuleRow = {
  id: string;
  matchField: string;
  matchType: string;
  pattern: string;
  categoryId: string;
  categoryName: string;
  enabled: boolean;
  hasLimits: boolean;
};

function useAction() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const run = (fn: () => Promise<Result>) => startTransition(async () => setResult(await fn()));
  const feedback = !result ? null : "error" in result ? (
    <p className="text-sm text-destructive">{result.error}</p>
  ) : result.message ? (
    <p className="text-sm text-muted-foreground">{result.message}</p>
  ) : null;
  return { pending, run, feedback };
}

const select = "h-9 rounded-md border bg-background px-2 text-sm";

function CategoryItem({ category, parents }: { category: CategoryRow & { label: string }; parents: CategoryRow[] }) {
  const { pending, run, feedback } = useAction();
  const [name, setName] = useState(category.name);
  return (
    <li className="space-y-1 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Category name"
          value={name}
          disabled={pending}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== category.name && run(() => actions.renameCategory(category.id, name.trim()))}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className={`h-8 max-w-[14rem] ${category.parentId ? "ml-6" : "font-medium"}`}
        />
        <span className="text-xs text-muted-foreground">{category.kind}</span>
        <select
          aria-label="Parent"
          className={select + " h-8"}
          disabled={pending}
          value={category.parentId ?? ""}
          onChange={(e) => run(() => actions.moveCategory(category.id, e.target.value || null))}
        >
          <option value="">Top level</option>
          {parents
            .filter((p) => p.id !== category.id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                Under {p.name}
              </option>
            ))}
        </select>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => actions.deleteCategory(category.id))}>
          Delete
        </Button>
      </div>
      {feedback}
    </li>
  );
}

export function ManageCategories({ categories, rules }: { categories: CategoryRow[]; rules: RuleRow[] }) {
  const parents = categories.filter((c) => !c.parentId).sort((a, b) => a.name.localeCompare(b.name));
  const ordered = categoryOptions(categories).map((o) => ({ ...categories.find((c) => c.id === o.id)!, label: o.label }));
  const create = useAction();
  const rulesAction = useAction();
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState("");
  const [newKind, setNewKind] = useState("expense");
  const [rulePattern, setRulePattern] = useState("");
  const [ruleCategory, setRuleCategory] = useState("");
  const [ruleMatch, setRuleMatch] = useState("merchant:equals");

  function submitCategory(event: FormEvent) {
    event.preventDefault();
    if (!newName.trim()) return;
    create.run(() => actions.createCategory(newName.trim(), newParent || null, newKind));
    setNewName("");
  }

  function submitRule(event: FormEvent) {
    event.preventDefault();
    const [matchField, matchType] = ruleMatch.split(":");
    if (!rulePattern.trim() || !ruleCategory) return;
    rulesAction.run(() => actions.createRule({ matchField, matchType, pattern: rulePattern.trim(), categoryId: ruleCategory }));
    setRulePattern("");
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Categories</h2>
        <ul className="divide-y rounded-lg border">
          {ordered.map((c) => (
            <CategoryItem key={c.id} category={c} parents={parents} />
          ))}
        </ul>
        <form onSubmit={submitCategory} className="flex flex-wrap items-center gap-2">
          <Input placeholder="New category" value={newName} onChange={(e) => setNewName(e.target.value)} className="max-w-[14rem]" />
          <select aria-label="Parent" className={select} value={newParent} onChange={(e) => setNewParent(e.target.value)}>
            <option value="">Top level</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                Under {p.name}
              </option>
            ))}
          </select>
          {newParent ? null : (
            <select aria-label="Kind" className={select} value={newKind} onChange={(e) => setNewKind(e.target.value)}>
              <option value="expense">Expense</option>
              <option value="income">Income</option>
              <option value="transfer">Transfer</option>
            </select>
          )}
          <Button type="submit" variant="outline" disabled={create.pending || !newName.trim()}>
            Add
          </Button>
        </form>
        {create.feedback}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-medium">Rules</h2>
          <Button size="sm" variant="outline" disabled={rulesAction.pending} onClick={() => rulesAction.run(actions.runRulesNow)}>
            Run rules now
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Rules run in this order before merchant memory, and only ever fill in uncategorized transactions.
        </p>
        {rules.length ? (
          <ul className="divide-y rounded-lg border">
            {rules.map((r) => (
              <li key={r.id} className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm ${r.enabled ? "" : "opacity-60"}`}>
                <span>
                  {r.matchField} {r.matchType.replace("_", " ")} <span className="font-medium">&quot;{r.pattern}&quot;</span> →{" "}
                  {r.categoryName}
                  {r.hasLimits ? <span className="text-xs text-muted-foreground"> (with limits)</span> : null}
                </span>
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" disabled={rulesAction.pending} onClick={() => rulesAction.run(() => actions.setRuleEnabled(r.id, !r.enabled))}>
                    {r.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={rulesAction.pending} onClick={() => rulesAction.run(() => actions.deleteRule(r.id))}>
                    Delete
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No rules yet. Create them here or with Shift+Enter in the inbox.</p>
        )}
        <form onSubmit={submitRule} className="flex flex-wrap items-center gap-2">
          <select aria-label="Match" className={select} value={ruleMatch} onChange={(e) => setRuleMatch(e.target.value)}>
            <option value="merchant:equals">Merchant is</option>
            <option value="merchant:contains">Merchant contains</option>
            <option value="description:contains">Description contains</option>
            <option value="description:starts_with">Description starts with</option>
          </select>
          <Input placeholder="Text to match" value={rulePattern} onChange={(e) => setRulePattern(e.target.value)} className="max-w-[14rem]" />
          <select aria-label="Category" className={select} value={ruleCategory} onChange={(e) => setRuleCategory(e.target.value)}>
            <option value="">Category…</option>
            {categoryOptions(categories).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <Button type="submit" variant="outline" disabled={rulesAction.pending || !rulePattern.trim() || !ruleCategory}>
            Add rule
          </Button>
        </form>
        {rulesAction.feedback}
      </section>
    </div>
  );
}
