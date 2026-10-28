import Link from "next/link";
import { headers } from "next/headers";
import { listPasskeys } from "@/lib/auth/webauthn";
import { autoApplyThreshold } from "@/lib/categorize/pipeline";
import { getDb } from "@/lib/db";
import { latestEval, recommendedThreshold } from "@/lib/model/evaluate";
import { getModelStatus } from "@/lib/model/status";
import { listDevices, pushConfig } from "@/lib/push/send";
import { listTokens, listUnmappedCards } from "@/lib/shortcuts/tokens";
import { getConnectionHealth } from "@/lib/sync/health";
import { listAccounts } from "@/operations/accounts";
import { read } from "@/operations/runtime";
import { AddPasskey } from "./add-passkey";
import { ApplePay } from "./apple-pay";
import { Connections } from "./connections";
import { ModelStatusPanel } from "./model-status";
import { Notifications } from "./notifications";
import { SETTINGS_TABS, settingsHref, settingsTab, type SettingsTab } from "./tabs";

// Settings (#69): one page, one tab per area, the tab in the URL. Each tab
// loads only its own data. What each setting does is unchanged; only where
// it lives moved.

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

// Test model and the evaluation may wait out a GPU cold start (~3.5 min).
export const maxDuration = 300;

async function ConnectionsTab() {
  const health = await getConnectionHealth(getDb());
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Synced automatically every morning. SimpleFIN allows about 24 requests a day, so &quot;Sync now&quot; is capped at 20 per connection per day.
      </p>
      <Connections health={health} />
    </>
  );
}

async function NotificationsTab() {
  const devices = await listDevices(getDb());
  return (
    <>
      <p className="text-sm text-muted-foreground">New alerts arrive on your devices as notifications, showing a merchant and an amount, never balances.</p>
      <Notifications
        publicKey={pushConfig()?.publicKey ?? null}
        devices={devices.map((d) => ({
          id: d.id,
          label: d.label,
          added: dateFormat.format(d.createdAt),
          lastSent: d.lastSentAt ? dateFormat.format(d.lastSentAt) : null,
          lastError: d.lastError,
        }))}
      />
    </>
  );
}

async function ApplePayTab() {
  const db = getDb();
  const [tokens, unmapped, accts] = await Promise.all([listTokens(db), listUnmappedCards(db), read(db, listAccounts, {})]);
  // The URL the Shortcut posts to: this deployment's own origin.
  const h = await headers();
  const origin = process.env.WEBAUTHN_ORIGIN ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const mappedNames = new Set(accts.map((a) => a.walletCardName?.toLowerCase()).filter(Boolean));
  return (
    <ApplePay
      endpoint={`${origin}/api/shortcuts/purchase`}
      tokens={tokens.map((t) => ({
        id: t.id,
        label: t.label,
        created: dateFormat.format(t.createdAt),
        lastUsed: t.lastUsedAt ? dateFormat.format(t.lastUsedAt) : null,
      }))}
      // Manual accounts hold a value, never transactions.
      accounts={accts.filter((a) => !a.manual).map((a) => ({ id: a.id, name: a.name, walletCardName: a.walletCardName }))}
      unmapped={unmapped.filter((u) => !mappedNames.has(u.name.toLowerCase())).map((u) => ({ name: u.name, lastSeen: dateFormat.format(u.lastSeenAt) }))}
    />
  );
}

async function ModelTab() {
  const db = getDb();
  const [model, lastEval] = await Promise.all([getModelStatus(db), latestEval(db)]);
  const evaluation = lastEval ? { summary: lastEval, recommended: recommendedThreshold(lastEval.thresholds) } : null;
  return <ModelStatusPanel status={model} evaluation={evaluation} threshold={autoApplyThreshold()} />;
}

async function SecurityTab() {
  const passkeys = await listPasskeys();
  return (
    <>
      <h2 className="font-medium">Passkeys</h2>
      {/* Register a second device early: with one passkey, losing that
          device means recovering through the database (see README). */}
      <ul className="divide-y rounded-lg border">
        {passkeys.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span>{p.label}</span>
            <span className="text-right text-muted-foreground">
              {p.lastUsedAt ? `Last used ${dateFormat.format(p.lastUsedAt)}` : `Added ${dateFormat.format(p.createdAt)}`}
            </span>
          </li>
        ))}
      </ul>
      <AddPasskey />
      <p className="pt-2 text-sm text-muted-foreground">
        The Apple Pay Shortcut signs in with its own tokens; see and revoke them under{" "}
        <Link className="underline" href={settingsHref("apple-pay")}>
          Apple Pay
        </Link>
        .
      </p>
    </>
  );
}

const CONTENT: Record<SettingsTab, () => Promise<React.ReactNode>> = {
  connections: ConnectionsTab,
  notifications: NotificationsTab,
  "apple-pay": ApplePayTab,
  model: ModelTab,
  security: SecurityTab,
};

export default async function SettingsPage(props: PageProps<"/settings">) {
  const tab = settingsTab((await props.searchParams).tab);
  const Content = CONTENT[tab];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <nav aria-label="Settings" className="flex flex-wrap gap-x-4 gap-y-1 border-b text-sm">
        {SETTINGS_TABS.map((t) => (
          <Link
            key={t.id}
            href={settingsHref(t.id)}
            aria-current={t.id === tab ? "page" : undefined}
            className={`-mb-px border-b-2 py-1.5 ${t.id === tab ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <section className="space-y-3">
        <Content />
      </section>
    </div>
  );
}
