import { describe, expect, it } from "vitest";
import { MORE_FILTERS, datePresets, dollars, parseView, viewHref } from "./view";

// The Transactions view as a URL (#211). Ids are made up.

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const query = (href: string) => Object.fromEntries(new URL(href, "http://x").searchParams);

describe("the Transactions view's URL (#211)", () => {
  it("writes every filter it reads, so a view survives paging and sharing", () => {
    const sp = {
      q: "lamps",
      category: OTHER,
      tag: OTHER,
      account: ACCOUNT,
      type: "flagged",
      from: "2026-06-01",
      to: "2026-06-30",
      min: "10",
      max: "42.50",
      signed: "1",
      xfer: OTHER,
      stub: "1",
      tags: "1",
      split: "1",
      pending: "1",
      source: "manual",
    };
    const view = parseView(sp);
    expect(query(viewHref(view))).toEqual(sp);
    expect(parseView(query(viewHref(view, { page: 3 })))).toEqual(view);
    // Every panel filter is set here, so none can be missed by the round trip.
    expect(MORE_FILTERS.every((key) => view.filters[key] !== undefined)).toBe(true);
  });

  it("reads amounts as cents, as their size unless signed", () => {
    expect(parseView({ min: "-50", max: "$1,200" }).filters).toMatchObject({ amountMinCents: 5000, amountMaxCents: 120_000 });
    expect(parseView({ min: "-50", max: "-10", signed: "1" }).filters).toMatchObject({ amountMinCents: -5000, amountMaxCents: -1000, amountSigned: true });
    expect(parseView({ min: "ten", max: "4.505" }).filters).toMatchObject({ amountMinCents: undefined, amountMaxCents: undefined });
    expect([dollars(1050), dollars(-1200), dollars(5), dollars(0)]).toEqual(["10.50", "-12", "0.05", "0"]);
  });

  it("drops what it doesn't recognise, rather than failing the page", () => {
    const { filters, type } = parseView({ from: "June", source: "fax", type: "everything", stub: "yes" });
    expect([filters.from, filters.source, filters.payStubLinked, type]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("still reads ?unmatched=1, and a change can drop a filter", () => {
    const view = parseView({ unmatched: "1", from: "2026-06-01", to: "2026-06-30" });
    expect(view.type).toBe("unmatched");
    expect(viewHref(view, { from: undefined, to: undefined })).toBe("/transactions?type=unmatched");
  });

  it("offers date presets as of today", () => {
    const presets = Object.fromEntries(datePresets("2026-01-15").map((p) => [p.label, [p.from, p.to]]));
    expect(presets["This month"]).toEqual(["2026-01-01", "2026-01-15"]);
    expect(presets["Last month"]).toEqual(["2025-12-01", "2025-12-31"]);
    expect(presets["Last 30 days"]).toEqual(["2025-12-17", "2026-01-15"]);
    expect(presets["This year"]).toEqual(["2026-01-01", "2026-01-15"]);
    expect(presets["Last year"]).toEqual(["2025-01-01", "2025-12-31"]);
  });
});
