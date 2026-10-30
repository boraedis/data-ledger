import Link from "next/link";
import { getDb } from "@/lib/db";
import { listRules, reapplyPreview } from "@/operations/rules";
import { read } from "@/operations/runtime";
import { misfiledTransfers } from "@/operations/transactions";
import { MisfiledTransfers } from "../../cash-flow/misfiled-transfers";
import { ReapplyPreview } from "./preview";

// Fixing past transactions (#100): rules and transfer matching only ever
// fill in what's uncategorized, so a rule fixed later, or a payment filed
// as spending before its other half arrived, stays as it was. This page is
// where the owner reaches back, always from a preview: ?rule= shows one
// rule's changes; without it, every rule with something to change, and
// transfer pairs across all history.

type Rule = Awaited<ReturnType<typeof listRules.run>>[number];

function ruleLabel(r: Rule): string {
  return `${r.matchField} ${r.matchType.replace("_", " ")} "${r.pattern}" → ${r.categoryName}`;
}

export default async function ReapplyPage(props: PageProps<"/categories/reapply">) {
  const sp = await props.searchParams;
  const ruleId = typeof sp.rule === "string" ? sp.rule : undefined;
  const db = getDb();
  const rules = await read(db, listRules, {});
  const rule = ruleId ? rules.find((r) => r.id === ruleId) : undefined;

  if (rule) {
    const changes = rule.enabled ? await read(db, reapplyPreview, { ruleId: rule.id }) : [];
    return (
      <div className="space-y-4">
        <Link href="/categories/reapply" className="text-sm text-muted-foreground hover:text-foreground">
          ← Fix past transactions
        </Link>
        <h1 className="text-2xl font-semibold">Re-apply a rule</h1>
        <p className="text-sm">
          <span className="font-medium">{ruleLabel(rule)}</span>
        </p>
        <p className="text-sm text-muted-foreground">
          Transactions that already have a category, where this rule, run today, would file them differently. Higher-priority rules still win.
          What you set yourself, anything with no record of who set it, and transfers stay as they are unless you tick them.
        </p>
        {!rule.enabled ? (
          <p className="text-sm text-muted-foreground">This rule is turned off. Turn it on in Categories &amp; rules to re-apply it.</p>
        ) : changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to change: everything it matches is already filed the way it says.</p>
        ) : (
          <ReapplyPreview key={changes.map((c) => c.transactionId).join()} ruleId={rule.id} ruleLabel={ruleLabel(rule)} changes={changes} />
        )}
      </div>
    );
  }

  const [changes, pairs] = await Promise.all([read(db, reapplyPreview, {}), read(db, misfiledTransfers, {})]);
  const counts = new Map<string, number>();
  for (const c of changes) counts.set(c.ruleId, (counts.get(c.ruleId) ?? 0) + 1);
  const withChanges = rules.filter((r) => counts.has(r.id));

  return (
    <div className="space-y-6">
      <Link href="/categories" className="text-sm text-muted-foreground hover:text-foreground">
        ← Categories &amp; rules
      </Link>
      <h1 className="text-2xl font-semibold">Fix past transactions</h1>
      <p className="text-sm text-muted-foreground">
        Rules and transfer matching only fill in what&apos;s uncategorized, and nothing here runs on its own. Each fix shows what would change first,
        and is one entry in Activity you can undo.
      </p>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Rules</h2>
        {withChanges.length ? (
          <ul className="divide-y rounded-lg border text-sm">
            {withChanges.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0">{ruleLabel(r)}</span>
                <Link href={`/categories/reapply?rule=${r.id}`} className="underline">
                  Review {counts.get(r.id)} change{counts.get(r.id) === 1 ? "" : "s"}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Every rule agrees with what&apos;s already filed.</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Transfers across all your history</h2>
        {pairs.length ? (
          <MisfiledTransfers pairs={pairs} />
        ) : (
          <p className="text-sm text-muted-foreground">
            No transfers filed as spending or income. Transfers that are uncategorized or filed as transfers are paired automatically.
          </p>
        )}
      </section>
    </div>
  );
}
