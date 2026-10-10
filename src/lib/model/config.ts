// Where the app's one model lives. Unset means "no model": every feature
// still works, it just skips the model step (categorization leaves things
// in the inbox, and so on).

export type ModelConfig = { baseUrl: string; apiKey: string; model: string };

export function modelConfig(): ModelConfig | null {
  const baseUrl = process.env.MODEL_BASE_URL?.trim();
  const apiKey = process.env.MODEL_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  const url = new URL(baseUrl);
  // The key and the financial data travel in this request, so plain http
  // is only acceptable to a model on this machine (local development).
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("MODEL_BASE_URL must use https");
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model: process.env.MODEL_NAME?.trim() || "ledger" };
}
