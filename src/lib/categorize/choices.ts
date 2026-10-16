// The likely categories for one transaction, best first (#34): what the
// quick-file screen shows as big buttons, so most purchases take one tap.
// Pure; transactions.categoryChoices gathers the inputs.
//
// The order is the same trust order the pipeline uses (#6): a rule the
// owner wrote, then the owner's own history with this merchant, then the
// model's guess. Recently used categories fill the rest, since a new
// merchant is still usually one of a handful of everyday categories.

export type ChoiceSource = "rule" | "memory" | "model" | "recent";
export type Choice = { categoryId: string; source: ChoiceSource };

export const MAX_CHOICES = 4;

export function rankChoices(
  input: {
    rule: string | null;
    // This merchant's categories, newest first.
    memory: string[];
    model: string | null;
    // Categories used lately on anything, newest first.
    recent: string[];
  },
  // Categories that make sense for this transaction (money out isn't
  // income); anything else is dropped.
  allowed: (categoryId: string) => boolean,
  limit = MAX_CHOICES,
): Choice[] {
  const choices: Choice[] = [];
  const add = (categoryId: string | null, source: ChoiceSource) => {
    if (!categoryId || !allowed(categoryId) || choices.some((c) => c.categoryId === categoryId)) return;
    choices.push({ categoryId, source });
  };

  add(input.rule, "rule");
  // Most often first; a tie goes to the more recent.
  const counts = new Map<string, number>();
  for (const id of input.memory) counts.set(id, (counts.get(id) ?? 0) + 1);
  const byUse = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || input.memory.indexOf(a) - input.memory.indexOf(b));
  for (const id of byUse) add(id, "memory");
  add(input.model, "model");
  for (const id of input.recent) add(id, "recent");
  return choices.slice(0, limit);
}
