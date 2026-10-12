import { describe, expect, it } from "vitest";
import {
  CHUNK_DAYS,
  SetupTokenError,
  chunkWindow,
  claimSetupToken,
  createSimpleFinConnector,
  epochToDate,
  normalizeAccountSet,
  normalizeHoldings,
  parseAmountCents,
} from "@/lib/connectors/simplefin";
import { normalizeDecimal } from "@/lib/money";
import { ConnectorAuthError } from "@/lib/connectors/types";

// All data here is invented, shaped like SimpleFIN v2 responses.

const ACCESS = "https://demo-user:demo-pass@beta-bridge.simplefin.org/simplefin";
const tokenFor = (url: string) => Buffer.from(url).toString("base64");

describe("parseAmountCents", () => {
  it.each([
    ["-12.34", -1234],
    ["12.34", 1234],
    ["+5", 500],
    ["0.5", 50],
    ["-0.05", -5],
    ["1000000.00", 100000000],
    ["0.00", 0],
    ["-0.00", 0],
    ["10.005", 1001],
    ["-10.004", -1000],
  ])("%s → %d", (input, cents) => {
    expect(parseAmountCents(input)).toBe(cents);
  });

  it("rejects anything that isn't a plain decimal", () => {
    for (const bad of ["", "abc", "1,000.00", "1e3", "$5"]) expect(() => parseAmountCents(bad)).toThrow();
  });
});

describe("normalizeAccountSet", () => {
  const now = new Date("2026-06-30T12:00:00Z");
  const snapshot = normalizeAccountSet(
    {
      connections: [{ conn_id: "CON-1", name: "Example Credit Union", org_id: "ecu" }],
      errlist: [{ code: "con.auth", msg: "Example Credit Union needs you to <sign in> again", conn_id: "CON-1" }],
      errors: ["You are approaching your daily request quota"],
      accounts: [
        {
          id: "ACT-1",
          name: "Everyday Checking",
          conn_id: "CON-1",
          currency: "USD",
          balance: "1520.10",
          "available-balance": "1500.00",
          "balance-date": 1782820800,
          transactions: [
            { id: "T1", posted: 1782734400, amount: "-42.50", description: "CORNER BEAN CAFE", payee: "Corner Bean" },
            { id: "T2", posted: 0, transacted_at: 1782777600, amount: "-9.99", description: "STREAMFLIX", pending: true },
          ],
        },
      ],
    },
    now,
  );

  it("maps accounts with institution and exact balances", () => {
    expect(snapshot.accounts[0]).toMatchObject({
      externalId: "ACT-1",
      institution: "Example Credit Union",
      institutionId: "CON-1",
      balanceCents: 152010,
      availableBalanceCents: 150000,
    });
  });

  it("dates pending transactions with posted=0 from transacted_at", () => {
    expect(snapshot.transactions[1]).toMatchObject({ pending: true, postedOn: epochToDate(1782777600), amountCents: -999 });
    expect(snapshot.transactions[0]).toMatchObject({ pending: false, payee: "Corner Bean", memo: null });
  });

  it("keeps both structured and legacy messages, sanitized", () => {
    expect(snapshot.messages).toEqual([
      { code: "con.auth", message: "Example Credit Union needs you to sign in again", institutionId: "CON-1" },
      { code: "gen", message: "You are approaching your daily request quota" },
    ]);
  });
});

describe("normalizeDecimal", () => {
  it.each([
    ["550.0", "550"],
    ["+12.50", "12.5"],
    ["0.004321", "0.004321"],
    ["007.10", "7.1"],
    [".5", "0.5"],
    ["-0.000", "0"],
    ["-3.25", "-3.25"],
    ["12345678901234567890.123456789", "12345678901234567890.123456789"],
  ])("%s → %s", (input, out) => {
    expect(normalizeDecimal(input)).toBe(out);
  });

  it("rejects anything that isn't a plain decimal", () => {
    for (const bad of ["", ".", "1e3", "1,000", "abc", "1.2.3"]) expect(() => normalizeDecimal(bad)).toThrow();
  });
});

describe("holdings", () => {
  // Shaped like Bridge's demo position; values invented.
  const position = {
    id: "POS-1",
    created: 345427200,
    symbol: "EXTM",
    description: "Example Total Market Fund",
    shares: "550.0",
    market_value: "105884.8",
    cost_basis: "55.00",
    purchase_price: "0.10",
    currency: "USD",
  };

  it("maps a position with exact shares and cent values", () => {
    expect(normalizeHoldings([position], "USD")).toEqual([
      {
        externalId: "POS-1",
        symbol: "EXTM",
        description: "Example Total Market Fund",
        shares: "550",
        marketValueCents: 10_588_480,
        costBasisCents: 5_500,
        currency: "USD",
      },
    ]);
  });

  it("reads a zero or missing cost basis as unknown, and falls back to the symbol for an id", () => {
    const [zero, missing] = normalizeHoldings(
      [
        { ...position, cost_basis: "0.00" },
        { ...position, id: undefined, cost_basis: undefined, currency: undefined },
      ],
      "CAD",
    );
    expect(zero.costBasisCents).toBeNull();
    expect(missing).toMatchObject({ externalId: "EXTM", costBasisCents: null, currency: "CAD" });
  });

  it("skips positions it can't read exactly rather than guessing", () => {
    expect(
      normalizeHoldings(
        [
          { ...position, shares: "1e3" },
          { ...position, market_value: undefined },
          { ...position, id: undefined, symbol: undefined },
          { ...position, id: "POS-2", shares: "2.5" },
        ],
        "USD",
      ).map((h) => h.externalId),
    ).toEqual(["POS-2"]);
  });

  it("tells 'no holdings reported' apart from 'none held'", () => {
    const base = { name: "x", currency: "USD", balance: "1.00", "balance-date": 1 };
    const { accounts } = normalizeAccountSet(
      { accounts: [{ ...base, id: "A" }, { ...base, id: "B", holdings: [] }, { ...base, id: "C", holdings: [position] }] },
      new Date(),
    );
    expect(accounts.map((a) => a.holdings?.length)).toEqual([undefined, 0, 1]);
  });
});

describe("claimSetupToken", () => {
  it("POSTs to the claim URL and returns the access URL", async () => {
    let called: { url: string; method?: string } | null = null;
    const access = await claimSetupToken(
      tokenFor("https://beta-bridge.simplefin.org/simplefin/claim/DEMO-123"),
      (async (url: URL, init?: RequestInit) => {
        called = { url: String(url), method: init?.method };
        return new Response(ACCESS);
      }) as typeof fetch,
    );
    expect(access).toBe(ACCESS);
    expect(called).toEqual({ url: "https://beta-bridge.simplefin.org/simplefin/claim/DEMO-123", method: "POST" });
  });

  it("never contacts a host outside the allowlist, or plain http", async () => {
    const never = (() => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;
    await expect(claimSetupToken(tokenFor("https://evil.example/simplefin/claim/X"), never)).rejects.toThrow(/allowed/);
    await expect(claimSetupToken(tokenFor("http://beta-bridge.simplefin.org/simplefin/claim/X"), never)).rejects.toThrow(/https/);
    await expect(claimSetupToken("not base64 at all!!", never)).rejects.toThrow(SetupTokenError);
  });

  it("explains an already-claimed token as a possible compromise", async () => {
    await expect(
      claimSetupToken(
        tokenFor("https://beta-bridge.simplefin.org/simplefin/claim/X"),
        (async () => new Response("", { status: 403 })) as typeof fetch,
      ),
    ).rejects.toThrow(/already been claimed.*compromised/);
  });
});

describe("SimpleFIN connector", () => {
  const now = new Date("2026-06-30T00:00:00Z");

  function connectorWith(respond: (url: string, init?: RequestInit) => Response) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const connector = createSimpleFinConnector(ACCESS, {
      now: () => now,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return respond(url, init);
      }) as typeof fetch,
    });
    return { connector, calls };
  }

  it("sends credentials as Basic auth, not in the URL, with an explicit window and pending", async () => {
    const { connector, calls } = connectorWith(() => Response.json({ accounts: [], connections: [], errlist: [] }));
    await connector.fetch(new Date("2026-06-20T00:00:00Z"));
    expect(calls[0].url).toBe(
      `https://beta-bridge.simplefin.org/simplefin/accounts?version=2&pending=1&start-date=${Date.UTC(2026, 5, 20) / 1000}&end-date=${now.getTime() / 1000}`,
    );
    expect(calls[0].url).not.toContain("demo-pass");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("demo-user:demo-pass").toString("base64")}`,
    );
  });

  it("never asks for more than 90 days in total or 45 per request", async () => {
    const { connector, calls } = connectorWith(() => Response.json({ accounts: [] }));
    expect(connector.requestsFor(new Date("2025-01-01T00:00:00Z"))).toBe(2);
    const snapshot = await connector.fetch(new Date("2025-01-01T00:00:00Z"));
    expect(snapshot.requests).toBe(2);
    const ranges = calls.map((c) => {
      const p = new URL(c.url).searchParams;
      return [Number(p.get("start-date")), Number(p.get("end-date"))];
    });
    expect(now.getTime() / 1000 - ranges[0][0]).toBe(90 * 86400);
    expect(ranges[0][1]).toBe(ranges[1][0]); // contiguous, no gap or overlap
    expect(ranges[1][1]).toBe(now.getTime() / 1000);
    for (const [s, e] of ranges) expect(e - s).toBeLessThanOrEqual(CHUNK_DAYS * 86400);
  });

  it("merges chunks: newest balances, each transaction once, messages once", async () => {
    let call = 0;
    const { connector } = connectorWith(() => {
      call++;
      return Response.json({
        errlist: [{ code: "gen.api", msg: "Same warning" }],
        accounts: [
          {
            id: "A",
            name: "Checking",
            currency: "USD",
            balance: call === 1 ? "1.00" : "2.00",
            "balance-date": 1,
            // T-edge appears in both chunks (a transaction on the boundary).
            transactions: [{ id: call === 1 ? "T-old" : "T-new", posted: 1, amount: "-1", description: "x" }, { id: "T-edge", posted: 1, amount: "-2", description: "y" }],
          },
        ],
      });
    });
    const snapshot = await connector.fetch(new Date("2025-01-01T00:00:00Z"));
    expect(snapshot.accounts[0].balanceCents).toBe(200);
    expect(snapshot.transactions.map((t) => t.externalId).sort()).toEqual(["T-edge", "T-new", "T-old"]);
    expect(snapshot.messages).toHaveLength(1);
  });

  it("uses one request for a routine nightly window", () => {
    expect(chunkWindow(new Date(now.getTime() - 6 * 86_400_000), now)).toHaveLength(1);
  });

  it("treats 403 and 402 as a broken credential", async () => {
    for (const status of [403, 402]) {
      const { connector } = connectorWith(() => new Response("", { status }));
      await expect(connector.fetch(now)).rejects.toBeInstanceOf(ConnectorAuthError);
    }
  });

  it("treats other failures as ordinary errors", async () => {
    const { connector } = connectorWith(() => new Response("", { status: 500 }));
    const error = await connector.fetch(now).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConnectorAuthError);
  });
});
