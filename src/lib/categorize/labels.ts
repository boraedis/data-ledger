// Client-safe: turns the flat category list into picker options labelled
// "Parent › Child", parents first, alphabetical within each group.

export type CategoryRow = { id: string; name: string; kind: string; parentId: string | null };
export type CategoryOption = { id: string; label: string; kind: string; isParent: boolean };

export function categoryOptions(rows: CategoryRow[]): CategoryOption[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parents = rows.filter((r) => !r.parentId).sort((a, b) => a.name.localeCompare(b.name));
  const options: CategoryOption[] = [];
  for (const parent of parents) {
    options.push({ id: parent.id, label: parent.name, kind: parent.kind, isParent: true });
    for (const child of rows.filter((r) => r.parentId === parent.id).sort((a, b) => a.name.localeCompare(b.name))) {
      options.push({ id: child.id, label: `${parent.name} › ${child.name}`, kind: child.kind, isParent: false });
    }
  }
  // Orphans can't exist (FK), but don't lose one if they somehow do.
  for (const r of rows) if (r.parentId && !byId.has(r.parentId)) options.push({ id: r.id, label: r.name, kind: r.kind, isParent: false });
  return options;
}

/** Case-insensitive match on any word start or substring, best (prefix) matches first. */
export function filterOptions(options: CategoryOption[], query: string): CategoryOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  const scored = options
    .map((o) => {
      const label = o.label.toLowerCase();
      const leaf = label.split(" › ").at(-1)!;
      const score = leaf.startsWith(q) ? 0 : label.split(/[\s›]+/).some((w) => w.startsWith(q)) ? 1 : label.includes(q) ? 2 : -1;
      return { o, score };
    })
    .filter((x) => x.score >= 0);
  return scored.sort((a, b) => a.score - b.score).map((x) => x.o);
}
