import Link from "next/link";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { requireOwner } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getConnectionHealth, healthProblems } from "@/lib/sync/health";

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
  const problems = healthProblems(await getConnectionHealth(getDb()));
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/" className="font-semibold">
            Data Ledger
          </Link>
          <Link href="/accounts" className="text-muted-foreground hover:text-foreground">
            Accounts
          </Link>
          <Link href="/activity" className="text-muted-foreground hover:text-foreground">
            Activity
          </Link>
          <Link href="/settings" className="text-muted-foreground hover:text-foreground">
            Settings
          </Link>
        </nav>
        <SignOutButton />
      </header>
      {problems.length ? (
        <Link
          href="/settings"
          className="block border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-800 dark:text-amber-200"
        >
          {problems.length === 1 ? problems[0] : `${problems[0]} (and ${problems.length - 1} more)`} — see Settings
        </Link>
      ) : null}
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
