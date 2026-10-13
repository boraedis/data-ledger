import { bridgeAuthorized, bridgeJson, unauthorized } from "@/lib/bridge/auth";
import { dailySpend, dailySpendQuery, VERSION } from "@/lib/bridge/v1";
import { getDb } from "@/lib/db";

// GET /api/bridge/v1/spend/daily?from=YYYY-MM-DD&to=YYYY-MM-DD — net spend
// per day per expense category, for Data Diary (#12, docs/bridge-v1.md).
// Read-only: there is no other method on any bridge route.
export async function GET(request: Request) {
  if (!bridgeAuthorized(request)) return unauthorized();
  const params = new URL(request.url).searchParams;
  const query = dailySpendQuery.safeParse({ from: params.get("from"), to: params.get("to") });
  if (!query.success) return bridgeJson({ error: query.error.issues.map((i) => i.message).join("; ") }, 400);
  const days = await dailySpend(getDb(), query.data);
  return bridgeJson({ version: VERSION, from: query.data.from, to: query.data.to, days });
}
