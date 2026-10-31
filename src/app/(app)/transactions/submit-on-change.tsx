"use client";

import { useEffect, useRef } from "react";

// Submits the Transactions filter form when one of its dropdowns changes
// (#207). The form itself stays a plain GET form, server-rendered: every
// filtered view is a URL, and with scripts off the Filter button still
// works. This only adds the submit a person would otherwise press.
//
// One listener on the form, not an onChange per select, so the selects
// stay in the server component and any added later is covered.
// requestSubmit, not submit, so it's the same submission as the button's.
export function SubmitOnChange() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = marker.current?.closest("form");
    if (!form) return;
    const onChange = (event: Event) => {
      if (event.target instanceof HTMLSelectElement) form.requestSubmit();
    };
    form.addEventListener("change", onChange);
    return () => form.removeEventListener("change", onChange);
  }, []);
  return <span ref={marker} hidden />;
}
