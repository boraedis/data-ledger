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
  // Payment-processor prefixes: Square, Toast, Shopify, PayPal, etc.
  /^(sq|tst|sp|pp|dd|in|py|pos|ck)\s?\*\s*/i,
  /^paypal\s?\*\s*/i,
];

const NOISE = [
  /\b(x{2,}|\*{2,})\d{2,4}\b/gi, // masked card numbers: XXXX1234, **1234
  /\bcard\s+\d{4}\b/gi,
  /#\s?\d+/g, // store numbers
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, // dates
  /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, // phone numbers
  /\b(?=[a-z]*\d)[a-z\d]{8,}\b/gi, // long reference codes (contain a digit)
  /\b\d{4,}\b/g, // long bare numbers
  /\b(autopay|auto pay|online pmt|web pmt|ppd|ccd|web id:?)\b/gi,
];

const SMALL_WORDS = new Set(["and", "of", "the", "at", "on", "in", "for", "to", "a", "&"]);

function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(" ")
    .map((word, i) => (i > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

export function normalizeMerchant(description: string, payee?: string | null): string {
  // A payee from the provider is usually already a clean name.
  const source = payee && payee.trim().length >= 2 ? payee : description;

  let text = source.replace(/\s+/g, " ").trim();
  for (const pattern of LEADING_NOISE) text = text.replace(pattern, "");
  for (const pattern of NOISE) text = text.replace(pattern, " ");
  text = text
    .replace(/\.(com|net|org)\b/gi, "") // "STREAMFLIX.COM" → "STREAMFLIX"
    .replace(/[*]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–:,.]+|[\s\-–:,.]+$/g, "")
    .trim();

  // If stripping ate everything (a description that was all codes), fall
  // back to the original rather than an empty merchant.
  if (text.length < 2) text = source.trim();
  return titleCase(text);
}
