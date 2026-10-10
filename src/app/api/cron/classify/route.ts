import { timingSafeEqual } from "crypto";
import { after } from "next/server";
import { chainUrl, classifyLink, triggerClassify } from "@/lib/categorize/classify-chain";
import { modelIsConfigured } from "@/lib/model/client";

// The nightly model step (#6), as a self-continuing job — see
// src/lib/categorize/classify-chain.ts for why. Triggered by the sync cron
// when it finishes (POST, depth 0), then by itself while there's work.
// Answers 202 at once and does the work after responding, so each caller
// returns immediately. Same CRON_SECRET guard as the sync.

export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function handle(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!modelIsConfigured()) return Response.json({ skipped: "no model configured" });
  const depth = Math.max(0, Math.min(Number(request.headers.get("x-chain-depth")) || 0, 100));
  const url = chainUrl(request.url);
  after(async () => {
    const result = await classifyLink(depth, maxDuration, { trigger: (next) => triggerClassify(url, next) });
    // Counts only — never transaction details — in Vercel's logs.
    console.log(
      `classify link ${depth}: model applied ${result.byModel}, saw ${result.modelSeen}, pending ${result.modelPending}` +
        `${result.modelError ? `, error: ${result.modelError}` : ""}${result.continued ? ", continuing" : ""}`,
    );
  });
  return Response.json({ accepted: true, depth }, { status: 202 });
}

// GET too, so it can also be run as a cron or by hand with the secret.
export { handle as GET, handle as POST };
