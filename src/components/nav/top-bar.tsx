"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { ACCOUNT_PAGES, SECTIONS, pageFor, sectionFor, type NavSection } from "@/lib/nav";

// The top bar (#68): the six sections, the current one marked, and an
// account menu. The current section's own pages are tabs underneath. On a
// phone the sections collapse into one Menu, and the bar names where you
// are instead of listing everywhere you could go.

function Badge({ count }: { count: number }) {
  return count ? <span className="ml-1 rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">{count}</span> : null;
}

export function TopBar({ inbox }: { inbox: number }) {
  const pathname = usePathname();
  const section = sectionFor(pathname);
  const page = pageFor(pathname);
  const [menu, setMenu] = useState(false);
  const [account, setAccount] = useState(false);
  const close = () => {
    setMenu(false);
    setAccount(false);
  };
  const isCurrent = (s: NavSection) => s.id === section?.id;

  return (
    <header className="border-b" onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="flex h-12 items-center gap-3 px-4">
        <Link href="/" className="shrink-0 font-semibold" onClick={close}>
          Data Ledger
        </Link>

        {/* Desktop: every section, the current one marked. */}
        <nav aria-label="Sections" className="hidden items-center gap-1 text-sm md:flex">
          {SECTIONS.filter((s) => s.id !== "home").map((s) => (
            <Link
              key={s.id}
              href={s.pages[0].href}
              aria-current={isCurrent(s) ? "page" : undefined}
              className={`rounded-md px-2.5 py-1 ${isCurrent(s) ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {s.label}
              {s.id === "inbox" ? <Badge count={inbox} /> : null}
            </Link>
          ))}
        </nav>

        {/* Phone: where you are. */}
        <span className="min-w-0 truncate text-sm text-muted-foreground md:hidden">
          {section && section.id !== "home" ? section.label : page && !section ? page.label : null}
        </span>

        <div className="relative ml-auto flex shrink-0 items-center gap-1">
          {/* Phone: the inbox stays one tap away; it's the page with work waiting. */}
          {inbox && section?.id !== "inbox" ? (
            <Link href="/inbox" className="rounded-md px-2 py-1 text-sm text-muted-foreground md:hidden" aria-label={`Inbox, ${inbox} to categorize`}>
              Inbox
              <Badge count={inbox} />
            </Link>
          ) : null}
          <button
            type="button"
            className="rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground md:hidden"
            aria-expanded={menu}
            aria-controls="nav-menu"
            onClick={() => setMenu(!menu)}
          >
            {menu ? "Close" : "Menu"}
          </button>
          <button
            type="button"
            className={`hidden rounded-md px-2.5 py-1 text-sm md:block ${account || !section ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            aria-expanded={account}
            aria-haspopup="menu"
            onClick={() => setAccount(!account)}
          >
            Account ▾
          </button>
          {account ? (
            <>
              {/* Clicking anywhere else closes it. */}
              <button type="button" aria-label="Close menu" className="fixed inset-0 z-10 hidden cursor-default md:block" onClick={close} />
              <div role="menu" className="absolute right-0 top-9 z-20 hidden w-44 rounded-lg border bg-background p-1 text-sm shadow-md md:block">
                {ACCOUNT_PAGES.map((p) => (
                  <Link
                    key={p.href}
                    role="menuitem"
                    href={p.href}
                    onClick={close}
                    className={`block rounded-md px-2.5 py-1.5 hover:bg-secondary ${page?.href === p.href ? "font-medium" : ""}`}
                  >
                    {p.label}
                  </Link>
                ))}
                <div className="border-t pt-1">
                  <SignOutButton />
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* The current section's pages, on every screen size. */}
      {section && section.pages.length > 1 ? (
        <nav aria-label={section.label} className="flex flex-wrap gap-x-4 px-4 text-sm">
          {section.pages.map((p) => (
            <Link
              key={p.href}
              href={p.href}
              aria-current={page?.href === p.href ? "page" : undefined}
              className={`-mb-px border-b-2 py-1.5 ${page?.href === p.href ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              {p.label}
            </Link>
          ))}
        </nav>
      ) : null}

      {/* Phone menu: every section with its pages, then the account. */}
      {menu ? (
        <nav id="nav-menu" aria-label="Menu" className="space-y-3 border-t px-4 py-3 text-sm md:hidden">
          {SECTIONS.map((s) => (
            <div key={s.id}>
              {s.pages.length === 1 ? (
                <Link href={s.pages[0].href} onClick={close} className={`block py-1.5 ${isCurrent(s) ? "font-medium" : ""}`}>
                  {s.label}
                  {s.id === "inbox" ? <Badge count={inbox} /> : null}
                </Link>
              ) : (
                <>
                  <p className="py-1 text-xs uppercase tracking-wide text-muted-foreground">{s.label}</p>
                  <div className="grid grid-cols-2 gap-x-4">
                    {s.pages.map((p) => (
                      <Link key={p.href} href={p.href} onClick={close} className={`block py-1.5 ${page?.href === p.href ? "font-medium" : ""}`}>
                        {p.label}
                      </Link>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
          <div className="flex items-center gap-4 border-t pt-3">
            {ACCOUNT_PAGES.map((p) => (
              <Link key={p.href} href={p.href} onClick={close} className={page?.href === p.href ? "font-medium" : "text-muted-foreground"}>
                {p.label}
              </Link>
            ))}
            <span className="ml-auto">
              <SignOutButton />
            </span>
          </div>
        </nav>
      ) : null}
    </header>
  );
}
