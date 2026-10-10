import { desc } from "drizzle-orm";
import { modelCalls } from "@/db/schema";
import type { Db } from "@/db/types";
import { modelConfig } from "@/lib/model/config";

// What Settings shows about the model: whether one is configured, and how
// recent calls went. Read from the content-free call log only.

export type ModelStatus = {
  configured: boolean;
  // The host only (never the key), so the owner can see which deployment.
  host: string | null;
  recent: { calls: number; failures: number; medianLatencyMs: number | null; coldStarts: number; lastAt: Date | null };
};

export async function getModelStatus(db: Db): Promise<ModelStatus> {
  let host: string | null = null;
  let configured = false;
  try {
    const config = modelConfig();
    configured = config !== null;
    host = config ? new URL(config.baseUrl).host : null;
  } catch {
    // A malformed MODEL_BASE_URL reads as "not configured" here; the error
    // itself surfaces when a feature tries to call the model.
  }
  const rows = await db.select().from(modelCalls).orderBy(desc(modelCalls.startedAt)).limit(50);
  const ok = rows.filter((r) => r.status === "ok").map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    configured,
    host,
    recent: {
      calls: rows.length,
      failures: rows.filter((r) => r.status !== "ok").length,
      medianLatencyMs: ok.length ? ok[Math.floor(ok.length / 2)] : null,
      coldStarts: rows.filter((r) => r.coldStartRetries > 0).length,
      lastAt: rows[0]?.startedAt ?? null,
    },
  };
}
