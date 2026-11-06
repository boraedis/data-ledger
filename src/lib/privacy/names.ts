import { privacyOn, privacySalt } from "@/lib/privacy/state";

// Names as neutral labels in privacy mode (#365, epic #358): "Merchant
// KQVB", "Account TRDM", "Person HLNS". Anything that names a real thing
// goes through privateName before it's shown; categories and merchant
// types don't, since they're the owner's own vocabulary, not identifying.
//
// A label is made from the name itself, so the same merchant reads the same
// on every page, in a list or on its own page, with no id needed where it
// shows. It's salted with a random value set each time the mode is turned on
// (lib/privacy/mode.ts), so a label can't be matched against a guessed name,
// and one sharing session's labels don't line up with the next one's. Four
// letters always, consonants only, so it gives away nothing of the name's
// length or letters, and never spells a word.
//
// When the mode applies is the amount rules' (lib/privacy/state.ts): exact
// in the browser and in a Server Component render, plain everywhere else.

export type NameKind = "merchant" | "description" | "account" | "institution" | "person" | "employer" | "goal" | "note" | "tag";

const NOUN: Record<NameKind, string> = {
  merchant: "Merchant",
  description: "Transaction",
  account: "Account",
  institution: "Bank",
  person: "Person",
  employer: "Employer",
  goal: "Goal",
  note: "Note",
  tag: "Tag",
};

const LETTERS = "BCDFGHJKLMNPQRSTVWXZ";

/** The label for a name under a salt: the same name and kind always get the same one. */
export function labelFor(kind: NameKind, name: string, salt: string): string {
  // FNV-1a, 32-bit, over the salt, the kind and the name as people would
  // read it (case and spacing don't make a different merchant).
  const text = `${salt}|${kind}|${name.trim().replace(/\s+/g, " ").toLowerCase()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += LETTERS[h % LETTERS.length];
    h = Math.floor(h / LETTERS.length);
  }
  return `${NOUN[kind]} ${code}`;
}

/**
 * Free text written earlier (an Activity reason, an alert's detail), as it
 * shows now. It can name a merchant, a person or an account anywhere in it,
 * and there's no telling which words they are, so while privacy mode is on
 * it isn't shown at all.
 */
export function privateText<T extends string | null | undefined>(text: T): T | string {
  if (!text || !privacyOn()) return text;
  return "Details hidden in privacy mode";
}

/** A name as it shows now: itself, or its label while privacy mode is on. Empty stays empty. */
export function privateName<T extends string | null | undefined>(kind: NameKind, name: T): T | string {
  if (!name || !privacyOn()) return name;
  return labelFor(kind, name, privacySalt());
}
