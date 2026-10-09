import Link from "next/link";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { requireOwner } from "@/lib/auth/session";

// Every page under (app) is owner-only. The proxy already turned away
// requests without a signed cookie; this is the authoritative check against
// the sessions table, so a signed-out or revoked session stops here.
export default async function AppLayout({ children }: LayoutProps<"/">) {
  await requireOwner();
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/" className="font-semibold">
            Data Ledger
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
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
