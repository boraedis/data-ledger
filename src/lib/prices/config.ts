// How often prices refresh and when one counts as stale (#229). Set in
// config, not by how often pages load: a refresh happens at most once per
// REFRESH_MINUTES however many pages are opened. Hourly by the owner's
// choice; the free plan's cron runs once a day, so the refresh is asked for
// by the pages that show values, and the nightly sync, instead.

const minutes = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const REFRESH_MINUTES = minutes("PRICE_REFRESH_MINUTES", 60);

// Older than this, a price is shown as stale with its time, never as current:
// a few missed refreshes, or the provider being down.
export const STALE_MINUTES = minutes("PRICE_STALE_MINUTES", 180);
