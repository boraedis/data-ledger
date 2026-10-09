import { getDb, withTransactionalDb } from "@/lib/db";
import { createLedgerMcpHandler } from "@/mcp/server";

// Public at the proxy (see src/proxy.ts) because MCP clients carry a bearer
// token, not the owner's session cookie. The handler itself rejects any
// request without a valid, unrevoked API token.
const handler = createLedgerMcpHandler({ readDb: getDb, withWriteDb: withTransactionalDb });

export { handler as GET, handler as POST, handler as DELETE };
