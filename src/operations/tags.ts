import { count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { tags, transactionTags } from "@/db/schema";
import { defineRead, defineWrite } from "@/operations/define";
import type { WriteContext } from "@/operations/tracked";

// Tags: free-form labels alongside categories. A transaction has at most
// one category (or a split) but any number of tags — "vacation-2026",
// "tax-deductible", "gift". Matched ignoring case, kept as first typed.

const tagName = z.string().trim().min(1).max(40);

async function findTag(ctx: WriteContext, name: string) {
  const [row] = await ctx.db.select().from(tags).where(sql`lower(${tags.name}) = lower(${name})`);
  return row;
}

export const listTags = defineRead({
  name: "tags.list",
  description: "List tags with how many transactions carry each.",
  input: z.object({}),
  run: (db) =>
    db
      .select({ id: tags.id, name: tags.name, transactions: count(transactionTags.id) })
      .from(tags)
      .leftJoin(transactionTags, eq(transactionTags.tagId, tags.id))
      .groupBy(tags.id)
      .orderBy(tags.name),
});

export const setTransactionTags = defineWrite({
  name: "transactions.setTags",
  description:
    "Set the complete list of tags on a transaction, by name. Tags that don't exist yet are created; " +
    "tags left out are removed from this transaction (the tag itself stays).",
  input: z.object({ transactionId: z.uuid(), tags: z.array(tagName).max(20) }),
  apply: async (ctx, { transactionId, tags: names }) => {
    const wanted = new Map<string, string>(); // lower → id
    for (const name of names) {
      if (wanted.has(name.toLowerCase())) continue;
      const tag = (await findTag(ctx, name)) ?? (await ctx.insert(tags, { name }));
      wanted.set(name.toLowerCase(), tag.id);
    }
    const current = await ctx.db
      .select({ id: transactionTags.id, tagId: transactionTags.tagId })
      .from(transactionTags)
      .where(eq(transactionTags.transactionId, transactionId));
    const wantedIds = new Set(wanted.values());
    for (const link of current) if (!wantedIds.has(link.tagId)) await ctx.remove(transactionTags, link.id);
    const have = new Set(current.map((l) => l.tagId));
    for (const tagId of wantedIds) if (!have.has(tagId)) await ctx.insert(transactionTags, { transactionId, tagId });
    return { tags: [...wanted.keys()].length };
  },
});

export const renameTag = defineWrite({
  name: "tags.rename",
  description: "Rename a tag everywhere it's used.",
  input: z.object({ tagId: z.uuid(), name: tagName }),
  apply: async (ctx, { tagId, name }) => {
    const clash = await findTag(ctx, name);
    if (clash && clash.id !== tagId) throw new Error(`A tag named "${clash.name}" already exists`);
    return ctx.update(tags, tagId, { name });
  },
});

export const deleteTag = defineWrite({
  name: "tags.delete",
  description: "Delete a tag and remove it from every transaction. Transactions are otherwise unchanged.",
  input: z.object({ tagId: z.uuid() }),
  apply: async (ctx, { tagId }) => {
    // Unlinked through tracked writes first, rather than leaning on the
    // FK cascade, so undo restores every transaction's tag too.
    const links = await ctx.db.select({ id: transactionTags.id }).from(transactionTags).where(eq(transactionTags.tagId, tagId));
    for (const link of links) await ctx.remove(transactionTags, link.id);
    await ctx.remove(tags, tagId);
    return { untagged: links.length };
  },
});
