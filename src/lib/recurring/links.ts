// Where a recurring bill lives on the Subscriptions page: an anchor on its
// row, so an alert about one bill (a renewal coming up, #84) can open it
// in place, with its Cancelled… and Stop tracking buttons right there.

export function billAnchor(merchant: string, accountId: string): string {
  const slug = merchant
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `bill-${accountId.slice(0, 8)}-${slug}`;
}

export const billHref = (merchant: string, accountId: string) => `/subscriptions#${billAnchor(merchant, accountId)}`;
