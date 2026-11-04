// Turns a raw bank description into a stable merchant name, so that rules
// and merchant memory can key on "Corner Bean Cafe" instead of the dozen
// ways a bank writes it ("POS PURCHASE CORNER BEAN CAFE #12", "SQ *CORNER
// BEAN CAFE 04/12"…). Pure and deterministic; the raw description is never
// modified, and this can be re-run over history whenever it improves.
//
// Deliberately conservative: it strips noise that is never part of a name
// (processor prefixes, store numbers, dates, card masks, reference numbers)
// and leaves anything ambiguous, like a trailing city, alone. A name that's
// slightly too long only means a rule or memory entry is slightly more
// specific; a name that's wrongly merged would categorize the wrong things.

// Card-network and bank boilerplate that precedes the merchant.
const LEADING_NOISE = [
  /^(pos|debit card|check ?card|visa|mc|dda|ach)\s+(purchase|debit|pur|dbt|withdrawal|pmt)?\s*/i,
  /^(recurring\s+)?(purchase|payment)\s+authorized\s+on\s+\d{1,2}\/\d{1,2}\s*/i,
  /^(debit|credit)\s+card\s+/i,
  /^(online|electronic)\s+(pmt|payment|transfer)\s+/i,
  /^ach\s+(debit|credit)\s+/i,
  /^apl\s?pay\s+/i,
  // Payment-processor prefixes: Square, Toast, Shopify, PayPal, FastSpring,
  // Braintree, WePay, Checkout.com, Squarespace, Eventbrite, SumUp, Clover…
  /^(sq|tst|sp|pp|dd|in|py|pos|ck|fs|bt|wpy|cko|sqsp|eb|sumup|clv)\s?\*\s*/i,
  /^paypal\s?\*\s*/i,
];

// Each with what it is, for explaining a name (#290).
const NOISE: [RegExp, string][] = [
  [/\b(x{2,}|\*{2,})\d{2,4}\b/gi, "card number"], // masked card numbers: XXXX1234, **1234
  [/\bcard\s+\d{4}\b/gi, "card number"],
  [/#\s?\d+/g, "store number"],
  [/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, "date"],
  [/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, "phone number"],
  [/\b(?=[a-z]*\d)[a-z\d]{8,}\b/gi, "reference code"], // long reference codes (contain a digit)
  [/\b\d{4,}\b/g, "number"], // long bare numbers
  [/\b(autopay|auto pay|online pmt|web pmt|ppd|ccd|web id:?)\b/gi, "bank wording"],
];

// US state and territory codes, for a location the bank put after the name
// (#288): "CORNER BEAN CAFE    SPRINGFIELD  IL", "CORNER BEAN CAFE,
// SPRINGFIELD, IL". The same business in two towns is one merchant.
const STATES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR".split(" "),
);
// Codes that are also words at the end of a name ("DRIVE IN", "& CO"): only
// taken as a state with a clear sign of a location before them.
const AMBIGUOUS_STATES = new Set(["AL", "CO", "DE", "HI", "ID", "IN", "LA", "MA", "ME", "OH", "OK", "OR", "PA"]);

/**
 * The text without a trailing location, when there's a clear sign of one: a
 * column gap (two or more spaces) or a comma before a town and a state code.
 * Without either, a state code alone at the end goes only when it can't be
 * a word and the name keeps two words; the town before it stays, since
 * nothing tells it from the name.
 */
function withoutLocation(text: string): string {
  const column = text.match(/^(.*?\S)\s{2,}[A-Za-z][A-Za-z .'-]*?\s+([A-Za-z]{2})\s*$/);
  if (column && STATES.has(column[2].toUpperCase())) return column[1];
  const comma = text.match(/^(.*?\S)\s*,\s*[A-Za-z][A-Za-z .'-]*?,?\s+([A-Za-z]{2})\s*$/);
  if (comma && STATES.has(comma[2].toUpperCase())) return comma[1];
  const bare = text.match(/^(\S+\s+\S+.*?)\s+([A-Za-z]{2})\s*$/);
  if (bare && STATES.has(bare[2].toUpperCase()) && !AMBIGUOUS_STATES.has(bare[2].toUpperCase())) return bare[1];
  return text;
}

const SMALL_WORDS = new Set(["and", "of", "the", "at", "on", "in", "for", "to", "a", "&"]);

function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(" ")
    .map((word, i) => (i > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

export type MerchantExplanation = {
  /** Where the name came from: the provider's payee, or the bank's description. */
  source: "payee" | "description";
  /** The text it was cleaned from. */
  input: string;
  /** What was taken out, in order, each with what it was. */
  removed: { what: string; text: string }[];
  /** True when cleaning left nothing and the text was used as it was. */
  fellBack: boolean;
  name: string;
};

/**
 * How a transaction's merchant name is made (#290), step by step, for
 * showing on the transaction. normalizeMerchant is this without the
 * working, so the explanation can't drift from what actually happens.
 */
export function explainMerchant(description: string, payee?: string | null): MerchantExplanation {
  // A payee from the provider is usually already a clean name.
  const fromPayee = !!payee && payee.trim().length >= 2;
  const source = fromPayee ? payee! : description;
  const removed: { what: string; text: string }[] = [];

  // The location first, while a column gap can still be seen.
  const trimmed = source.trim();
  const located = withoutLocation(trimmed);
  if (located !== trimmed) removed.push({ what: "location", text: trimmed.slice(located.length).replace(/^[\s,]+/, "").replace(/\s+/g, " ") });
  let text = located.replace(/\s+/g, " ").trim();
  for (const pattern of LEADING_NOISE) {
    const m = text.match(pattern);
    if (m && m[0]) {
      removed.push({ what: "prefix", text: m[0].trim() });
      text = text.slice(m[0].length);
    }
  }
  for (const [pattern, what] of NOISE) {
    for (const m of text.matchAll(pattern)) if (m[0].trim()) removed.push({ what, text: m[0].trim() });
    text = text.replace(pattern, " ");
  }
  for (const m of text.matchAll(/\.(com|net|org)\b/gi)) removed.push({ what: "web address", text: m[0] });
  text = text
    .replace(/\.(com|net|org)\b/gi, "") // "STREAMFLIX.COM" → "STREAMFLIX"
    .replace(/[*]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–:,.]+|[\s\-–:,.]+$/g, "")
    .trim();

  // If stripping ate everything (a description that was all codes), fall
  // back to the original rather than an empty merchant.
  const fellBack = text.length < 2;
  if (fellBack) text = trimmed;
  return { source: fromPayee ? "payee" : "description", input: trimmed, removed: fellBack ? [] : removed, fellBack, name: titleCase(text) };
}

export function normalizeMerchant(description: string, payee?: string | null): string {
  return explainMerchant(description, payee).name;
}
