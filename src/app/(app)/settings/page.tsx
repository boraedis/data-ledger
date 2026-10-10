import { listPasskeys } from "@/lib/auth/webauthn";
import { getDb } from "@/lib/db";
import { autoApplyThreshold } from "@/lib/categorize/pipeline";
import { latestEval, recommendedThreshold } from "@/lib/model/evaluate";
import { getModelStatus } from "@/lib/model/status";
import { getConnectionHealth } from "@/lib/sync/health";
import { Connections } from "./connections";
import { ModelStatusPanel } from "./model-status";
import { AddPasskey } from "./add-passkey";

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

// Test model and the evaluation may wait out a GPU cold start (~3.5 min).
export const maxDuration = 300;

export default async function SettingsPage() {
  const db = getDb();
  const [passkeys, health, model, lastEval] = await Promise.all([
    listPasskeys(),
    getConnectionHealth(db),
    getModelStatus(db),
    latestEval(db),
  ]);
  const evaluation = lastEval ? { summary: lastEval, recommended: recommendedThreshold(lastEval.thresholds) } : null;
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
        <h2 className="text-lg font-medium">Model</h2>
        <ModelStatusPanel status={model} evaluation={evaluation} threshold={autoApplyThreshold()} />
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
