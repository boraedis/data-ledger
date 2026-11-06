import { cache, cacheSignal } from "react";

// Whether amounts are masked right now (#364, epic #358), wherever a figure
// is being formatted, without every one of the app's formatCents calls
// being told. Three places a figure can be formatted, three answers:
//
// - In the browser: what the privacy provider last rendered with. One tab
//   is one mode, so a module value is exact here.
// - In a Server Component render: what this request's cookie says, kept
//   per request with React's cache and set by privacyMode() (the layout,
//   and every page before it renders). A render that hasn't read it yet
//   masks: forgetting it shows `$•••` with privacy off, which is seen at
//   once, never an amount with it on.
// - Anywhere else on the server (a route handler, a server action, a job,
//   a test, or the server rendering of client components): plain. Nothing
//   there reaches a shared screen as rendered: text a server action returns
//   is shown by a client component, which masks it, and while the mode is
//   on the provider doesn't render client components on the server at all
//   (components/privacy/privacy-provider.tsx), so they're only ever
//   rendered in the browser, by the first rule. That's also why no module
//   value is shared between two requests on the server.

let browserOn = false;

/** The provider's mode, for figures formatted in the browser. */
export function setBrowserPrivacy(on: boolean) {
  browserOn = on;
}

const request = cache((): { on: boolean | null } => ({ on: null }));

/** This request's mode, for figures formatted in its Server Components. */
export function setRequestPrivacy(on: boolean) {
  if (cacheSignal()) request().on = on;
}

export function privacyOn(): boolean {
  if (typeof window !== "undefined") return browserOn;
  // Not in a Server Component render: see above.
  if (!cacheSignal()) return false;
  return request().on ?? true;
}
