import { listApiTokens } from "@/lib/auth/api-tokens";
import { listPasskeys } from "@/lib/auth/webauthn";
import { getDb } from "@/lib/db";
import { AddPasskey } from "./add-passkey";
import { ApiTokens } from "./api-tokens";

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export default async function SettingsPage() {
  const [passkeys, tokens] = await Promise.all([listPasskeys(), listApiTokens(getDb())]);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Passkeys</h2>
        {/* Register a second device early: with one passkey, losing that
            device means recovering through the database (see README). */}
        <ul className="divide-y rounded-lg border">
          {passkeys.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span>{p.label}</span>
              <span className="text-muted-foreground">
                {p.lastUsedAt ? `Last used ${dateFormat.format(p.lastUsedAt)}` : `Added ${dateFormat.format(p.createdAt)}`}
              </span>
            </li>
          ))}
        </ul>
        <AddPasskey />
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">API tokens</h2>
        <p className="text-sm text-muted-foreground">
          For MCP clients such as Claude Code. A token can read everything in the ledger and propose changes, which
          wait for your approval in Activity. Create one per client so each can be revoked on its own.
        </p>
        <ApiTokens tokens={tokens} />
      </section>
    </div>
  );
}
