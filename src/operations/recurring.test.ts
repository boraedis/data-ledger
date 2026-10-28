import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accounts, alerts, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import { applySeed } from "@/lib/seed/apply";
import { testDb } from "@/lib/test-utils/db";
import { execute } from "@/operations/runtime";

// On the synthetic seed, which carries one of each alert's shape: the
// Streamflix price rise, a doubled gym charge, a $1 Videopal trial turning
// into a plan, and Tunebox billed to both the card and checking.

let db: Db;
let cardId: string;
const ON = "2026-06-30";

type Recurring = { merchant: string; accountId: string; status: string; cadence: string; typicalCents: number; annualizedCents: number; variable: boolean; nextExpectedOn: string };
type Alert = { id: string; kind: string; title: string; merchant: string };

const run = (operation: string, input: Record<string, unknown>, actor: "user" | "matcher" | "tally" = "user") =>
  execute(db, { operation, input, actor, reason: "test" }) as Promise<{ status: string; output: unknown }>;
const out = async <T,>(operation: string, input: Record<string, unknown> = {}, actor: "user" | "matcher" = "user") => (await run(operation, input, actor)).output as T;

beforeEach(async () => {
  db = await testDb();
  await applySeed(db, { endDate: new Date(ON) });
  [{ id: cardId }] = await db.select().from(accounts).where(eq(accounts.type, "credit"));
});

describe("recurring charges", () => {
  it("detects subscriptions and bills, not everyday spending", async () => {
    const list = await out<Recurring[]>("recurring.list", { on: ON });
    const merchants = list.map((r) => r.merchant);
    for (const m of ["Streamflix", "Tunebox Music Subscr", "Ironworks Gym Membership", "Videopal", "Maplewood Property Mgmt Rent", "City Power & Light"]) {
      expect(merchants).toContain(m);
    }
    expect(merchants).not.toContain("Corner Bean Cafe");
    expect(merchants).not.toContain("Quillfield Market");
    const streamflix = list.find((r) => r.merchant === "Streamflix")!;
    expect(streamflix).toMatchObject({ status: "suggested", cadence: "monthly", typicalCents: 1_799, annualizedCents: 1_799 * 12 });
    expect(list.find((r) => r.merchant === "City Power & Light")!.variable).toBe(true);
  });

  it("raises each seeded alert once, and dismissed alerts stay dismissed", async () => {
    expect(await out<{ raised: number }>("alerts.refresh", { on: ON }, "matcher")).toEqual({ raised: 4 });
    const open = await out<Alert[]>("alerts.list");
    expect(open.map((a) => a.kind).sort()).toEqual(["duplicate_charge", "overlapping_subscriptions", "price_increase", "trial_converted"]);
    expect(open.find((a) => a.kind === "price_increase")!.title).toBe("Streamflix went up to $17.99");

    expect(await out<{ raised: number }>("alerts.refresh", { on: ON }, "matcher")).toEqual({ raised: 0 });
    await run("alerts.dismiss", { alertId: open[0].id });
    expect(await out<{ raised: number }>("alerts.refresh", { on: ON }, "matcher")).toEqual({ raised: 0 });
    expect(await out<Alert[]>("alerts.list")).toHaveLength(3);
  });

  it("alerts on a missing charge only once a series is confirmed", async () => {
    const later = "2026-07-25"; // Tunebox on the card was due around Jul 7
    await out("alerts.refresh", { on: later }, "matcher");
    expect((await db.select().from(alerts)).some((a) => a.kind === "missing_charge")).toBe(false);

    await run("recurring.setStatus", { merchant: "Tunebox Music Subscr", accountId: cardId, status: "confirmed" });
    expect(await out<{ raised: number }>("alerts.refresh", { on: later }, "matcher")).toMatchObject({ raised: 1 });
    const missing = (await out<Alert[]>("alerts.list")).find((a) => a.kind === "missing_charge")!;
    expect(missing.title).toBe("Tunebox Music Subscr stopped charging");
    const list = await out<Recurring[]>("recurring.list", { on: later });
    expect(list.find((r) => r.merchant === "Tunebox Music Subscr" && r.accountId === cardId)!.status).toBe("confirmed");
  });

  it("raises nothing for a dismissed series, and the decision can be cleared", async () => {
    await run("recurring.setStatus", { merchant: "Streamflix", accountId: cardId, status: "dismissed" });
    await out("alerts.refresh", { on: ON }, "matcher");
    expect((await out<Alert[]>("alerts.list")).some((a) => a.merchant === "Streamflix")).toBe(false);
    await run("recurring.setStatus", { merchant: "Streamflix", accountId: cardId, status: null });
    expect((await out<Recurring[]>("recurring.list", { on: ON })).find((r) => r.merchant === "Streamflix")!.status).toBe("suggested");
  });

  it("cancels a subscription: out of tracked, counted as saved, and a later charge alerts once", async () => {
    // Streamflix bills the card on the 3rd. Cancelled on Apr 20, its usual
    // price then was still $15.49 (one charge at $17.99 so far).
    await run("recurring.setStatus", { merchant: "Streamflix", accountId: cardId, status: "confirmed" });
    expect(await out("recurring.cancel", { merchant: "Streamflix", accountId: cardId, cancelledOn: "2026-04-20" })).toEqual({
      status: "cancelled",
      cancelledOn: "2026-04-20",
      annualizedCents: 1_549 * 12,
    });
    const list = await out<Recurring[]>("recurring.list", { on: ON });
    expect(list.find((r) => r.merchant === "Streamflix" && r.accountId === cardId)!.status).toBe("cancelled");
    expect(await out("recurring.cancelled")).toEqual([
      { merchant: "Streamflix", accountId: cardId, accountName: expect.any(String), cancelledOn: "2026-04-20", annualizedCents: 1_549 * 12 },
    ]);

    // The seed kept charging on May 3 and Jun 3: one alert each, nothing else
    // for Streamflix (its price rise is no longer news once cancelled).
    await out("alerts.refresh", { on: ON }, "matcher");
    const streamflix = (await out<(Alert & { occurredOn: string })[]>("alerts.list")).filter((a) => a.merchant === "Streamflix");
    expect(streamflix.map((a) => [a.kind, a.occurredOn])).toEqual([
      ["charged_after_cancel", "2026-06-03"],
      ["charged_after_cancel", "2026-05-03"],
    ]);
    expect(streamflix[0].title).toBe("Streamflix charged after you cancelled");
    expect(await out<{ raised: number }>("alerts.refresh", { on: ON }, "matcher")).toEqual({ raised: 0 });

    // Tracking it again drops the cancellation.
    await run("recurring.setStatus", { merchant: "Streamflix", accountId: cardId, status: "confirmed" });
    expect(await out("recurring.cancelled")).toEqual([]);
  });

  it("shows a quiet tracked bill as ended until the owner answers it (#83)", async () => {
    const later = "2026-07-25"; // Tunebox on the card was due around Jul 7
    const tunebox = async () => (await out<(Recurring & { ended: boolean })[]>("recurring.list", { on: later })).find((r) => r.merchant === "Tunebox Music Subscr" && r.accountId === cardId)!;
    await run("recurring.setStatus", { merchant: "Tunebox Music Subscr", accountId: cardId, status: "confirmed" });
    expect((await tunebox()).ended).toBe(true);
    await out("alerts.refresh", { on: later }, "matcher");
    expect((await out<Alert[]>("alerts.list")).filter((a) => a.kind === "missing_charge")).toHaveLength(1);

    // Still active: back in Tracked, its alert settled, and no new one for this gap.
    expect(await out("recurring.stillActive", { merchant: "Tunebox Music Subscr", accountId: cardId, on: later })).toEqual({
      status: "confirmed",
      stillActiveAfter: "2026-06-07",
    });
    expect(await tunebox()).toMatchObject({ status: "confirmed", ended: false, overdue: true });
    expect((await out<Alert[]>("alerts.list")).some((a) => a.kind === "missing_charge")).toBe(false);
    expect(await out<{ raised: number }>("alerts.refresh", { on: "2026-08-25" }, "matcher")).toEqual({ raised: 0 });
  });

  it("settles the ended alert when the bill is marked cancelled", async () => {
    const later = "2026-07-25";
    await run("recurring.setStatus", { merchant: "Tunebox Music Subscr", accountId: cardId, status: "confirmed" });
    await out("alerts.refresh", { on: later }, "matcher");
    await run("recurring.cancel", { merchant: "Tunebox Music Subscr", accountId: cardId, cancelledOn: "2026-06-07" });
    expect((await out<Alert[]>("alerts.list")).some((a) => a.kind === "missing_charge")).toBe(false);
  });

  it("keeps an annual bill tracked through the year and flags its renewal once (#84)", async () => {
    // A yearly plan, charged in July two years running; next expected 2027-07-13.
    for (const [postedOn, externalId] of [["2025-07-14", "cloud-1"], ["2026-07-13", "cloud-2"]]) {
      await db.insert(transactions).values({ accountId: cardId, postedOn, amountCents: -11_900, description: "CLOUDBOX STORAGE ANNUAL", merchant: "Cloudbox Storage", externalId });
    }
    await run("recurring.setStatus", { merchant: "Cloudbox Storage", accountId: cardId, status: "confirmed" });
    const cloudbox = async (on: string) => (await out<Recurring[]>("recurring.list", { on })).find((r) => r.merchant === "Cloudbox Storage");
    // Eleven months on, still detected (with one year of history it wasn't).
    expect(await cloudbox("2027-06-13")).toMatchObject({ status: "confirmed", cadence: "annual", nextExpectedOn: "2027-07-13" });

    const renewals = async () => (await out<Alert[]>("alerts.list")).filter((a) => a.kind === "upcoming_renewal");
    await out("alerts.refresh", { on: "2027-06-13" }, "matcher"); // 30 days out
    expect(await renewals()).toEqual([]);
    await out("alerts.refresh", { on: "2027-06-29" }, "matcher"); // 14 days out
    await out("alerts.refresh", { on: "2027-07-05" }, "matcher");
    const [alert] = await renewals();
    expect((await renewals()).length).toBe(1);
    expect(alert.title).toBe("Cloudbox Storage renews around 2027-07-13");
    expect((alert as Alert & { detail: string }).detail).toMatch(/^\$119\.00 \(annual\) on .+\. Cancel before then if you don't want it\.$/);
  });

  it("won't cancel something that isn't recurring, and Tally's cancel is a proposal", async () => {
    await expect(run("recurring.cancel", { merchant: "Corner Bean Cafe", accountId: cardId, cancelledOn: ON })).rejects.toThrow(/No recurring charge/);
    expect((await run("recurring.cancel", { merchant: "Streamflix", accountId: cardId, cancelledOn: ON }, "tally")).status).toBe("proposed");
  });

  it("keeps the alert pipeline for the matcher and the owner; Tally only reads", async () => {
    await expect(run("alerts.refresh", { on: ON }, "tally")).rejects.toThrow(/may not run/);
    expect((await run("alerts.list", {}, "tally")).status).toBe("read");
  });
});
