import type { Db } from "@/db/types";
import { connections } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { claimSetupToken, createSimpleFinConnector } from "@/lib/connectors/simplefin";
import type { Connector } from "@/lib/connectors/types";

// The only place that maps a stored connection to a provider
// implementation. Adding Plaid later means a case here and a module beside
// simplefin.ts; nothing downstream changes.

export type Provider = "simplefin";

export function connectorFor(connection: { provider: string; encryptedSecret: string }): Connector {
  switch (connection.provider) {
    case "simplefin":
      return createSimpleFinConnector(decryptSecret(connection.encryptedSecret));
    default:
      throw new Error(`No connector for provider "${connection.provider}"`);
  }
}

/** Claims a SimpleFIN setup token and stores the resulting credential, encrypted. Returns the connection id. */
export async function addSimpleFinConnection(
  db: Db,
  { setupToken, label }: { setupToken: string; label: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const accessUrl = await claimSetupToken(setupToken, fetchImpl);
  const [row] = await db
    .insert(connections)
    .values({ provider: "simplefin", label, encryptedSecret: encryptSecret(accessUrl) })
    .returning({ id: connections.id });
  return row.id;
}
