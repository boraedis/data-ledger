import { getDb, withTransactionalDb } from "@/lib/db";
import { sendPush } from "@/lib/push/send";
import { checkPurchase, flaggedNotification, purchaseBody, purchaseNotification, recordPurchase, unmappedNotification, type PurchaseFlag } from "@/lib/shortcuts/purchase";
import { verifyBearer } from "@/lib/shortcuts/tokens";
import { execute } from "@/operations/runtime";

// POST /api/shortcuts/purchase: an Apple Pay purchase from the iOS
// Shortcuts "Transaction" automation (#32; setup in
// docs/apple-pay-shortcut.md). Authenticated by a per-device token from
// Settings, as a bearer header; the Shortcut has no session.
//
// Answers fast and in plain words: the Shortcut can show the reply, and a
// slow one holds up the phone's automation.

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  const db = getDb();
  const device = await verifyBearer(db, request.headers.get("authorization"));
  if (!device) return json({ error: "Unauthorized" }, 401);

  const parsed = purchaseBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Expected { merchant, amount, card }" }, 400);

  const outcome = await withTransactionalDb((tx) => recordPurchase(tx, parsed.data));
  if (outcome.status === "invalid") return json({ error: outcome.error }, 400);

  // After the purchase is saved, never inside its transaction: a slow push
  // service mustn't hold the database. A push failure doesn't fail the
  // request; the purchase is recorded either way.
  if (outcome.status === "unmapped") {
    await sendPush(db, unmappedNotification(outcome.card)).catch((error) => console.error("Push failed", error));
    return json({ status: "unmapped", message: `No account uses the Wallet card name "${outcome.card}" yet. Map it in Settings.` }, 202);
  }
  if (outcome.status === "created") {
    // Checked in its own transaction, after the purchase is saved: a failed
    // check must never lose the purchase, and tonight's pass checks it again.
    let flag: PurchaseFlag | null = null;
    try {
      flag = await withTransactionalDb((tx) => checkPurchase(tx, outcome.transactionId));
    } catch (error) {
      console.error("Suspicious-charge check failed", error);
    }
    const notification = flag ? flaggedNotification(outcome, flag) : purchaseNotification(parsed.data, outcome);
    const sent = await sendPush(db, notification).catch((error) => {
      console.error("Push failed", error);
      return null;
    });
    // Marked so the nightly push doesn't send the same flag again.
    if (flag && sent?.sent) {
      await withTransactionalDb((tx) =>
        execute(tx, { operation: "alerts.markNotified", actor: "matcher", reason: "Sent a suspicious-charge alert with its purchase", input: { alertIds: [flag.alertId] } }),
      ).catch((error) => console.error("Marking the alert sent failed", error));
    }
  }
  return json({ status: outcome.status, transactionId: outcome.transactionId });
}
