import { getDb } from "@/lib/db";
import { listCategories } from "@/operations/categories";
import { listRules } from "@/operations/rules";
import { read } from "@/operations/runtime";
import { ManageCategories } from "./manage";

export default async function CategoriesPage() {
  const db = getDb();
  const [categories, rules] = await Promise.all([read(db, listCategories, {}), read(db, listRules, {})]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Categories &amp; rules</h1>
      <ManageCategories
        categories={categories}
        rules={rules.map((r) => ({
          id: r.id,
          matchField: r.matchField,
          matchType: r.matchType,
          pattern: r.pattern,
          categoryId: r.categoryId,
          categoryName: r.categoryName,
          enabled: r.enabled,
          hasLimits: r.accountId !== null || r.minAmountCents !== null || r.maxAmountCents !== null,
        }))}
      />
    </div>
  );
}
