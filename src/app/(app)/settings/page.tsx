import { listPasskeys } from "@/lib/auth/webauthn";
import { getDb } from "@/lib/db";
import { getConnectionHealth } from "@/lib/sync/health";
import { Connections } from "./connections";
import { AddPasskey } from "./add-passkey";

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export default async function SettingsPage() {
  const [passkeys, health] = await Promise.all([listPasskeys(), getConnectionHealth(getDb())]);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Bank connections</h2>
        <p className="text-sm text-muted-foreground">
          Synced automatically every morning. SimpleFIN allows about 24 requests a day, so &quot;Sync now&quot; is
          capped at 20 per connection per day.
        </p>
        <Connections health={health} />
      </section>
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
    </div>
  );
}
