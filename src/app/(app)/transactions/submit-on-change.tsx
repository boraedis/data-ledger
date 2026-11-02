"use client";

import { useEffect, useRef } from "react";

// Submits the Transactions filter form when one of its dropdowns or
// checkboxes changes (#207, #211); typed fields wait for Filter or Enter,
// since each keystroke isn't a filter. The form itself stays a plain GET form, server-rendered: every
// filtered view is a URL, and with scripts off the Filter button still
// works. This only adds the submit a person would otherwise press.
//
// One listener on the form, not an onChange per field, so the fields stay
// in the server component and any added later is covered.
// requestSubmit, not submit, so it's the same submission as the button's.
export function SubmitOnChange() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = marker.current?.closest("form");
    if (!form) return;
    const onChange = (event: Event) => {
      const t = event.target;
      if (t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && t.type === "checkbox")) form.requestSubmit();
    };
    form.addEventListener("change", onChange);
    return () => form.removeEventListener("change", onChange);
  }, []);
  return <span ref={marker} hidden />;
}
