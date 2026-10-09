import { z } from "zod";
import { accounts } from "@/db/schema";
import { defineRead } from "@/operations/define";

export const listAccounts = defineRead({
  name: "accounts.list",
  description: "List all bank, card and payment-app accounts with their institution and type.",
  input: z.object({}),
  run: (db) =>
    db
      .select({ id: accounts.id, name: accounts.name, institution: accounts.institution, type: accounts.type })
      .from(accounts)
      .orderBy(accounts.name),
});
