import { runCategorization, type CategorizationResult } from "@/lib/categorize/pipeline";
import { withTransactionalDb } from "@/lib/db";

// The nightly model step as a self-continuing job (#6).
//
// A model cold start takes ~2½–4½ minutes and one function gets 5, and on
// Vercel's Hobby plan a daily cron can fire anywhere within its hour — so
// neither "do it all in one call" nor "a second cron a few minutes later"
// is reliable. Instead the sync triggers /api/cron/classify when it's done;
// each invocation works until just before its own deadline (its first
// model call is what wakes the GPU), and if there's more to do — or the
// model was still booting — it triggers the next invocation, which finds
// the model warm. A depth limit makes runaway impossible.

export const MAX_CHAIN_DEPTH = 6;
// Seconds of the route's maxDuration kept back to record results and
// trigger the next link.
const RESERVE_SECONDS = 25;

export type ChainDeps = {
  run?: (deadline: number) => Promise<CategorizationResult>;
  trigger?: (depth: number) => Promise<void>;
  now?: () => number;
};

export function chainUrl(requestUrl: string): string {
  // The canonical origin when set: per-deployment URLs may sit behind
  // Vercel's deployment protection, which a server-to-server call can't pass.
  const origin = process.env.WEBAUTHN_ORIGIN || new URL(requestUrl).origin;
  return `${origin}/api/cron/classify`;
}

export async function triggerClassify(url: string, depth: number): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  // The callee answers 202 straight away and works after responding, so
  // this returns in well under a second.
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "X-Chain-Depth": String(depth) },
    signal: AbortSignal.timeout(15_000),
  }).catch((error) => console.error("Couldn't trigger the next classify run", error));
}

/** One link of the chain. Returns what it did and whether it handed on. */
export async function classifyLink(
  depth: number,
  maxDurationSeconds: number,
  { run, trigger, now = Date.now }: ChainDeps = {},
): Promise<CategorizationResult & { continued: boolean }> {
  const deadline = now() + (maxDurationSeconds - RESERVE_SECONDS) * 1000;
  const result = await (run ?? ((d) => withTransactionalDb((db) => runCategorization(db, { model: { deadline: d } }))))(deadline);

  // Hand on if the model still has work waiting — whether because time ran
  // out mid-way or because it was still booting. Not on any other error
  // (a bad key won't fix itself in the next call), and never past the cap.
  const booting = /still starting|deadline/i.test(result.modelError ?? "");
  const keepGoing = result.modelPending > 0 && (!result.modelError || booting) && depth < MAX_CHAIN_DEPTH;
  if (keepGoing && trigger) await trigger(depth + 1);
  return { ...result, continued: keepGoing && Boolean(trigger) };
}
