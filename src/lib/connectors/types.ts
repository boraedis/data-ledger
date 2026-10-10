import type { SyncMessage } from "@/db/schema";

// The one interface every bank-data provider implements. Everything past
// this boundary — the import operation, budgets, categorization — sees only
// these shapes and never knows which aggregator was used (README, "Bank
// connection"). Normalization (cents, dates) happens inside the connector.

export type RawAccount = {
  externalId: string;
  name: string;
  institution: string;
  institutionId: string;
  currency: string;
  balanceCents: number;
  availableBalanceCents: number | null;
  balanceAt: Date;
  // Investment positions as of the sync (#23). Undefined means the provider
  // doesn't report holdings for this account, which is different from an
  // empty list (it does, and there are none).
  holdings?: RawHolding[];
};

export type RawHolding = {
  // The provider's ID for the position, or its symbol when it has none.
  externalId: string;
  symbol: string | null;
  description: string;
  // An exact decimal string ("12.5", "0.004321"), never a float.
  shares: string;
  marketValueCents: number;
  // Total cost of the position; null when the brokerage doesn't say.
  costBasisCents: number | null;
  currency: string;
};

export type RawTransaction = {
  accountExternalId: string;
  externalId: string;
  postedOn: string; // YYYY-MM-DD
  amountCents: number; // negative = money out
  description: string;
  payee: string | null;
  memo: string | null;
  pending: boolean;
};

export type ConnectorSnapshot = {
  accounts: RawAccount[];
  transactions: RawTransaction[];
  // Provider warnings and per-institution errors, as display-safe text.
  messages: SyncMessage[];
  // How many requests this fetch cost against the provider's quota.
  requests: number;
};

export interface Connector {
  /** Accounts with current balances, plus transactions on or after `since`. */
  fetch(since: Date): Promise<ConnectorSnapshot>;
  /** Requests a fetch from `since` would cost, so the caller can check its budget first. */
  requestsFor(since: Date): number;
}

/** The credential was rejected outright (revoked, wrong, unpaid). Retrying won't help; the owner must reconnect. */
export class ConnectorAuthError extends Error {}
