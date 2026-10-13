import { bridgeAuthorized, bridgeJson, unauthorized } from "@/lib/bridge/auth";
import { recurringCharges, VERSION } from "@/lib/bridge/v1";
import { getDb } from "@/lib/db";

// GET /api/bridge/v1/recurring — recurring charges as of today, for Data
// Diary (#12, docs/bridge-v1.md). Takes no parameters.
export async function GET(request: Request) {
  if (!bridgeAuthorized(request)) return unauthorized();
  const on = new Date().toISOString().slice(0, 10);
  return bridgeJson({ version: VERSION, on, charges: await recurringCharges(getDb(), on) });
}
