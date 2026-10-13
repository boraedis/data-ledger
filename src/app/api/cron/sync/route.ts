import { timingSafeEqual } from "crypto";
import { withTransactionalDb } from "@/lib/db";
import { chainUrl, triggerClassify } from "@/lib/categorize/classify-chain";
import { modelIsConfigured } from "@/lib/model/client";
import { syncAllConnections } from "@/lib/sync/run";
import { execute } from "@/operations/runtime";

// The nightly sync, triggered by Vercel Cron (vercel.json). Vercel sends
// `Authorization: Bearer $CRON_SECRET`; without a match nothing runs, so the
// public URL can't be used to burn through SimpleFIN's daily quota.

// Syncing several institutions with a 90-day first backfill can take a
// while; well under Vercel's limit, well over the default.
export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const results = await withTransactionalDb((db) => syncAllConnections(db, "cron"));
  // Alerts for the digest (#9), from what just synced. A failure here mustn't
  // fail the sync: the data is in, and tomorrow's run raises anything missed.
  let alertsRaised: number | null = null;
  try {
    const result = await withTransactionalDb((db) =>
      execute(db, { operation: "alerts.refresh", input: {}, actor: "matcher", reason: "Nightly check for subscription alerts" }),
    );
    if (result.status === "applied") alertsRaised = (result.output as { raised: number }).raised;
  } catch (error) {
    console.error("Alert refresh failed", error);
  }
  // Then hand whatever rules and memory left to the model, as its own job
  // (a cold start alone can take most of a function's 5 minutes).
  if (modelIsConfigured()) await triggerClassify(chainUrl(request.url), 0);
  // Statuses and counts only; errors stay in sync_runs, not in Vercel's
  // request logs.
  return Response.json({
    results: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, r.status])),
    alertsRaised,
  });
}
