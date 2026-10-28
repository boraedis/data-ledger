import Link from "next/link";
import { TopBar } from "@/components/nav/top-bar";
import { requireOwner } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { modelIsConfigured } from "@/lib/model/client";
import { getConnectionHealth, healthProblems } from "@/lib/sync/health";
import { inboxCount } from "@/operations/transactions";
import { TallyBubble } from "./tally/bubble";

// Everything here is per-request, owner-only data; never prerender it. Without
// this, `next build` starts rendering a page before the session check marks
// it dynamic — and on Vercel, where DATABASE_URL is set at build time, that
// means querying the production database during a build.
export const dynamic = "force-dynamic";

// Every page under (app) is owner-only. The proxy already turned away
// requests without a signed cookie; this is the authoritative check against
// the sessions table, so a signed-out or revoked session stops here.
export default async function AppLayout({ children }: LayoutProps<"/">) {
  await requireOwner();
  // On every page, not just Settings: a broken bank connection silently
  // stops the ledger being current, which is exactly what goes unnoticed.
  const db = getDb();
  const [problems, inbox] = await Promise.all([getConnectionHealth(db).then(healthProblems), inboxCount(db)]);
  return (
    <div className="flex min-h-svh flex-col">
      <TopBar inbox={inbox} />
      {problems.length ? (
        <Link
          href="/settings"
          className="block border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning"
        >
          {problems.length === 1 ? problems[0] : `${problems[0]} (and ${problems.length - 1} more)`} — see Settings
        </Link>
      ) : null}
      {/* Bottom padding clears the Tally button, so it never sits over the
          last control on a page. */}
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 pt-6 pb-24">{children}</main>
      <TallyBubble configured={modelIsConfigured()} />
    </div>
  );
}
