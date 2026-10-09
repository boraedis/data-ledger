const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Integer cents → "$1,234.56". Formatting is the only place cents become a decimal. */
export function formatCents(cents: number, currency = "USD"): string {
  const formatter =
    currency === "USD" ? usd : new Intl.NumberFormat("en-US", { style: "currency", currency });
  return formatter.format(cents / 100);
}
