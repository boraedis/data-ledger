import type { SyncMessage } from "@/db/schema";
import { parseAmountCents } from "@/lib/money";
import {
  ConnectorAuthError,
  type Connector,
  type ConnectorSnapshot,
  type RawAccount,
  type RawTransaction,
} from "@/lib/connectors/types";

// SimpleFIN (https://www.simplefin.org/protocol.html, v2) via SimpleFIN
// Bridge. Read-only, daily-refresh data; raw descriptions with no
// categories, which is fine — categorization is ours (#6).

type Fetch = typeof fetch;

// How far back we ever ask. Bridge documents 90 days of history per request.
export const MAX_WINDOW_DAYS = 90;

// The most one request may span. Bridge's docs say 90, but the live server
// (checked against the demo bridge, Oct 2026) warns past 45 days — "In the
// future, this may be capped" — and caps 90-day requests by sliding the end
// date, silently dropping the newest transactions. So longer windows (the
// first backfill, catching up after an outage) are fetched in 45-day chunks,
// each with an explicit end date. The rate limit (~24 requests/day) is
// enforced by the sync runner, which asks requestsFor() first.
export const CHUNK_DAYS = 45;

const DAY_MS = 86_400_000;

// Only these hosts receive a claim request or credentials. A setup token is
// just a base64 URL, and the server will POST to whatever it decodes to;
// an allowlist keeps a mistyped or malicious token from aiming that request
// anywhere else. Override with SIMPLEFIN_ALLOWED_HOSTS for another server.
function allowedHosts(): string[] {
  return (process.env.SIMPLEFIN_ALLOWED_HOSTS ?? "bridge.simplefin.org,beta-bridge.simplefin.org")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

function assertAllowed(url: URL) {
  if (url.protocol !== "https:") throw new Error("SimpleFIN URLs must use https");
  if (!allowedHosts().includes(url.hostname)) {
    throw new Error(`${url.hostname} isn't an allowed SimpleFIN server`);
  }
}

export class SetupTokenError extends Error {}

/**
 * Exchanges a one-time setup token for the long-lived access URL. The token
 * stops working after this, so a 403 means it was already claimed — by us
 * earlier, or by someone else, which the spec says to treat as a possible
 * compromise.
 */
export async function claimSetupToken(setupToken: string, fetchImpl: Fetch = fetch): Promise<string> {
  let claimUrl: URL;
  try {
    claimUrl = new URL(Buffer.from(setupToken.trim(), "base64").toString("utf8"));
  } catch {
    throw new SetupTokenError("That doesn't look like a SimpleFIN setup token.");
  }
  if (!claimUrl.pathname.includes("/claim/")) throw new SetupTokenError("That doesn't look like a SimpleFIN setup token.");
  assertAllowed(claimUrl);

  const response = await fetchImpl(claimUrl, { method: "POST", headers: { "Content-Length": "0" } });
  if (response.status === 403) {
    throw new SetupTokenError(
      "This setup token has already been claimed. If that wasn't you, disable it in SimpleFIN Bridge — it may be compromised.",
    );
  }
  if (!response.ok) throw new SetupTokenError(`SimpleFIN returned ${response.status} while claiming the token.`);

  const accessUrl = (await response.text()).trim();
  assertAllowed(new URL(accessUrl));
  return accessUrl;
}

/** fetch() rejects credentials inside a URL, so split them out into a Basic auth header. */
function splitAccessUrl(accessUrl: string): { base: string; authorization: string } {
  const url = new URL(accessUrl);
  assertAllowed(url);
  const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  url.username = "";
  url.password = "";
  return {
    base: url.toString().replace(/\/$/, ""),
    authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
  };
}

// Exact decimal → cents parsing lives in src/lib/money.ts (the client's
// split editor needs it too); re-exported here for the connector's callers.
export { parseAmountCents } from "@/lib/money";

/**
 * Epoch seconds → YYYY-MM-DD, in UTC. Banks rarely carry a meaningful time
 * of day, and UTC is at least stable; revisit if real data shows dates
 * landing a day early or late.
 */
export function epochToDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

// The spec asks clients to sanitize provider text before display: strip
// control characters and markup-ish brackets, and cap the length.
function displaySafe(text: unknown): string {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

type SfConnection = { conn_id: string; name?: string; org_name?: string; org_id?: string };
type SfTransaction = {
  id: string;
  posted: number;
  amount: string;
  description: string;
  transacted_at?: number;
  pending?: boolean;
  payee?: string;
  memo?: string;
};
type SfAccount = {
  id: string;
  name: string;
  conn_id?: string;
  org?: { name?: string; domain?: string; id?: string }; // v1
  currency: string;
  balance: string;
  "available-balance"?: string;
  "balance-date": number;
  transactions?: SfTransaction[];
};
type SfError = { code?: string; msg?: string; conn_id?: string; account_id?: string };
type SfAccountSet = {
  accounts: SfAccount[];
  connections?: SfConnection[];
  errlist?: SfError[];
  errors?: string[]; // v1, deprecated; Bridge still uses it for rate-limit warnings
};

export function normalizeAccountSet(data: SfAccountSet, now: Date): ConnectorSnapshot {
  const connections = new Map((data.connections ?? []).map((c) => [c.conn_id, c]));

  const accounts: RawAccount[] = data.accounts.map((a) => {
    const connection = a.conn_id ? connections.get(a.conn_id) : undefined;
    return {
      externalId: a.id,
      name: displaySafe(a.name),
      institution: displaySafe(connection?.name ?? connection?.org_name ?? a.org?.name ?? "Unknown institution"),
      institutionId: a.conn_id ?? a.org?.id ?? a.org?.domain ?? "unknown",
      // A custom-currency URL is possible per spec; we only budget in ISO codes.
      currency: /^[A-Z]{3}$/.test(a.currency) ? a.currency : "XXX",
      balanceCents: parseAmountCents(a.balance),
      availableBalanceCents: a["available-balance"] ? parseAmountCents(a["available-balance"]) : null,
      balanceAt: new Date(a["balance-date"] * 1000),
    };
  });

  const transactions: RawTransaction[] = data.accounts.flatMap((a) =>
    (a.transactions ?? []).map((t) => ({
      accountExternalId: a.id,
      externalId: t.id,
      // `posted` is 0 for some pending transactions; fall back to when it
      // happened, then to today.
      postedOn: epochToDate(t.posted || t.transacted_at || Math.floor(now.getTime() / 1000)),
      amountCents: parseAmountCents(t.amount),
      description: t.description,
      payee: t.payee ?? null,
      memo: t.memo ?? null,
      pending: t.pending === true,
    })),
  );

  const messages: SyncMessage[] = [
    ...(data.errlist ?? []).map((e) => ({
      code: displaySafe(e.code || "gen"),
      message: displaySafe(e.msg),
      ...(e.conn_id ? { institutionId: e.conn_id } : {}),
      ...(e.account_id ? { accountExternalId: e.account_id } : {}),
    })),
    ...(data.errors ?? []).map((e) => ({ code: "gen", message: displaySafe(e) })),
  ];

  return { accounts, transactions, messages, requests: 1 };
}

/** [start, end) epoch-second ranges covering since→now, none longer than CHUNK_DAYS, oldest first. */
export function chunkWindow(since: Date, now: Date): [number, number][] {
  const end = now.getTime();
  let start = Math.max(since.getTime(), end - MAX_WINDOW_DAYS * DAY_MS);
  const chunks: [number, number][] = [];
  do {
    const chunkEnd = Math.min(start + CHUNK_DAYS * DAY_MS, end);
    chunks.push([Math.floor(start / 1000), Math.floor(chunkEnd / 1000)]);
    start = chunkEnd;
  } while (start < end);
  return chunks;
}

/** Merges chunk responses: the newest chunk's balances, every transaction once, each message once. */
function mergeSnapshots(snapshots: ConnectorSnapshot[]): ConnectorSnapshot {
  const transactions = new Map<string, RawTransaction>();
  for (const s of snapshots) for (const t of s.transactions) transactions.set(`${t.accountExternalId}|${t.externalId}`, t);
  const messages = new Map<string, SyncMessage>();
  for (const s of snapshots) for (const m of s.messages) messages.set(JSON.stringify(m), m);
  return {
    accounts: snapshots.at(-1)?.accounts ?? [],
    transactions: [...transactions.values()],
    messages: [...messages.values()],
    requests: snapshots.length,
  };
}

export function createSimpleFinConnector(
  accessUrl: string,
  { fetchImpl = fetch, now = () => new Date() }: { fetchImpl?: Fetch; now?: () => Date } = {},
): Connector {
  return {
    requestsFor(since) {
      return chunkWindow(since, now()).length;
    },

    async fetch(since) {
      const { base, authorization } = splitAccessUrl(accessUrl);
      const current = now();
      const snapshots: ConnectorSnapshot[] = [];
      // Sequential, oldest first: two or three requests at most, and the
      // last one's balances are the current ones.
      for (const [start, end] of chunkWindow(since, current)) {
        const url = `${base}/accounts?version=2&pending=1&start-date=${start}&end-date=${end}`;
        const response = await fetchImpl(url, { headers: { Authorization: authorization } });
        // 403: access revoked or credentials wrong. 402: the Bridge
        // subscription lapsed. Either way only the owner can fix it.
        if (response.status === 403) throw new ConnectorAuthError("SimpleFIN rejected the access credentials (403). Reconnect with a new setup token.");
        if (response.status === 402) throw new ConnectorAuthError("SimpleFIN requires payment (402). Check the SimpleFIN Bridge subscription.");
        if (!response.ok) throw new Error(`SimpleFIN returned ${response.status}`);
        snapshots.push(normalizeAccountSet((await response.json()) as SfAccountSet, current));
      }
      return mergeSnapshots(snapshots);
    },
  };
}
