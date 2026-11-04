import { investmentActivity, type InvestmentActivity } from "@/lib/investments/activity";

// What the brokerages actually return (#316), as a survey the owner runs on
// their own machine (scripts/trades-survey.ts). It answers the questions the
// Trades epic (#315) needs before inference is built: which institutions send
// cash rows and how far back, which kinds of activity the existing patterns
// (#24) recognize, whether cost basis is filled in, how cash is held, and how
// often positions change between syncs.
//
// It's run by the owner, not by an agent, on purpose: reading the ledger to
// produce this would send ledger data to a hosted AI (AGENTS.md). Its output
// is built to be shareable: counts, shares and day spans per institution,
// with no account names, symbols, quantities, values or dates. Descriptions
// appear only as shapes, where every word outside a fixed brokerage
// vocabulary is masked, so fund names, merchants and people don't survive.
// The owner still reads it before sharing it.
//
// Pure: the script loads the rows and prints what this returns.

export type SurveyAccount = { id: string; institution: string; type: string };
export type SurveyTransaction = { accountId: string; postedOn: string; description: string; payee: string | null; memo: string | null };
export type SurveySnapshot = {
  accountId: string;
  on: string;
  externalId: string;
  symbol: string | null;
  description: string;
  shares: string;
  marketValueCents: number;
  costBasisCents: number | null;
};

export type InstitutionSurvey = {
  institution: string;
  accounts: number;
  // Cash rows
  transactions: number;
  daysBack: number | null;
  activity: Partial<Record<InvestmentActivity, number>>;
  withSymbolLikeToken: number;
  withQuantityLikeNumber: number;
  // Positions
  snapshotDays: number;
  medianDaysBetweenSnapshots: number | null;
  positions: number;
  withoutSymbol: number;
  costBasisFilled: number;
  cashLike: { count: number; signals: string[] };
  // Changes between consecutive snapshots, cash-like positions left out
  intervals: number;
  intervalsWithChange: number;
  mostPositionsChangedAtOnce: number;
  costBasisPrice: { checked: number; agrees: number };
  shapes: Partial<Record<InvestmentActivity, { shape: string; n: number }[]>>;
};

// How uninvested cash usually shows up in positions: a sweep or money-market
// fund, or a plain cash line. A position priced at exactly $1.00 is the other tell.
const CASH_WORDS = /money ?market|\bcash\b|sweep|core position|settlement fund|liquidity|deposit program|\bfdic\b|\bmmf\b/i;

/** Why a position looks like cash rather than a holding, or null. Exported for #320 to start from. */
export function cashSignal(p: Pick<SurveySnapshot, "symbol" | "description" | "shares" | "marketValueCents">): string | null {
  if (CASH_WORDS.test(p.description) || (p.symbol && CASH_WORDS.test(p.symbol))) return "named as cash";
  const shares = Number(p.shares);
  if (shares > 0 && Math.abs(p.marketValueCents / 100 / shares - 1) < 0.0005) return "priced at $1.00";
  return null;
}

// Words that say what a brokerage row is, kept in shapes. Anything else is masked.
const VOCAB = new Set(
  (
    "buy bought sell sold sale purchase redemption redeemed reinvest reinvestment reinvested drip dividend div dividends " +
    "interest int fee fees commission advisory management charge transfer transferred deposit withdrawal withdraw " +
    "contribution distribution rollover journal journaled wire ach in out from to of on at for by the and you your shares share " +
    "sh units unit qty quantity price @ cash sweep money market fund funds core position settlement capital gain gains " +
    "ltcg stcg long short term received paid payment credit debit adjustment adj tax withholding foreign margin " +
    "split stock reverse spin-off spinoff merger exchange conversion return principal bond coupon matured maturity " +
    "employer employee match pretax roth ira 401k 403b hsa brokerage account acct trade trades order executed limit market"
  ).split(" "),
);

/** A description as a pattern: numbers as #, money as $#, brokerage words kept, everything else masked. */
export function descriptionShape(text: string): string {
  const tokens = text
    .replace(/\$\s?\d[\d,]*(\.\d+)?/g, " $# ")
    .replace(/\d[\d,]*(\.\d+)?/g, " # ")
    .split(/[\s/:;,()]+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const t of tokens) {
    const word = t === "#" || t === "$#" ? t : VOCAB.has(t.toLowerCase()) ? t.toUpperCase() : "…";
    if (word === "…" && out[out.length - 1] === "…") continue;
    out.push(word);
  }
  return out.join(" ");
}

// A ticker-like token (1–5 capitals, maybe with a class suffix) that isn't a
// brokerage word; and a number that could be a quantity (has decimals, or
// sits next to "shares"/"@"). Both are rough on purpose: the question is
// only whether rows ever carry a symbol or quantity.
const looksLikeSymbol = (text: string) => text.split(/[\s/:;,()]+/).some((t) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(t) && !VOCAB.has(t.toLowerCase()));
const looksLikeQuantity = (text: string) => /\d+\.\d{3,}|\d[\d,.]*\s*(shares?|sh|units?)\b|@\s*\$?\d/i.test(text);

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const SHAPES_PER_KIND = 6;

export function surveyBrokerages(
  { accounts, transactions, snapshots }: { accounts: SurveyAccount[]; transactions: SurveyTransaction[]; snapshots: SurveySnapshot[] },
  asOf: string,
): InstitutionSurvey[] {
  const byInstitution = new Map<string, SurveyAccount[]>();
  for (const a of accounts) byInstitution.set(a.institution, [...(byInstitution.get(a.institution) ?? []), a]);

  return [...byInstitution.entries()]
    .map(([institution, accts]) => {
      const ids = new Set(accts.map((a) => a.id));
      const rows = transactions.filter((t) => ids.has(t.accountId));
      const activity: InstitutionSurvey["activity"] = {};
      const shapeCounts = new Map<InvestmentActivity, Map<string, number>>();
      let withSymbolLikeToken = 0;
      let withQuantityLikeNumber = 0;
      for (const r of rows) {
        const text = [r.description, r.payee, r.memo].filter(Boolean).join(" ");
        const kind = investmentActivity(text);
        activity[kind] = (activity[kind] ?? 0) + 1;
        const shapes = shapeCounts.get(kind) ?? new Map<string, number>();
        const shape = descriptionShape(text);
        shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
        shapeCounts.set(kind, shapes);
        if (looksLikeSymbol(text)) withSymbolLikeToken++;
        if (looksLikeQuantity(text)) withQuantityLikeNumber++;
      }
      const earliest = rows.reduce<string | null>((m, r) => (!m || r.postedOn < m ? r.postedOn : m), null);

      const snaps = snapshots.filter((s) => ids.has(s.accountId));
      const cashSignals = new Set<string>();
      const cashKeys = new Set<string>();
      for (const s of snaps) {
        const signal = cashSignal(s);
        if (signal) {
          cashSignals.add(signal);
          cashKeys.add(`${s.accountId}|${s.externalId}`);
        }
      }
      // Positions as of each account's latest snapshot.
      const latest = snaps.filter((s) => s.on === snaps.filter((x) => x.accountId === s.accountId).reduce((m, x) => (x.on > m ? x.on : m), ""));

      let intervals = 0;
      let intervalsWithChange = 0;
      let mostPositionsChangedAtOnce = 0;
      const gaps: number[] = [];
      const costBasisPrice = { checked: 0, agrees: 0 };
      for (const a of accts) {
        const days = [...new Set(snaps.filter((s) => s.accountId === a.id).map((s) => s.on))].sort();
        const on = (day: string) => new Map(snaps.filter((s) => s.accountId === a.id && s.on === day && !cashKeys.has(`${a.id}|${s.externalId}`)).map((s) => [s.externalId, s]));
        for (let i = 1; i < days.length; i++) {
          intervals++;
          gaps.push(daysBetween(days[i - 1], days[i]));
          const before = on(days[i - 1]);
          const after = on(days[i]);
          let changed = 0;
          for (const key of new Set([...before.keys(), ...after.keys()])) {
            const b = before.get(key);
            const n = after.get(key);
            const delta = Number(n?.shares ?? 0) - Number(b?.shares ?? 0);
            if (Math.abs(delta) < 1e-9) continue;
            changed++;
            // A buy where both days carry cost basis: does the change in cost
            // basis over the change in shares match the day's price?
            if (delta > 0 && n && n.costBasisCents !== null && (!b || b.costBasisCents !== null) && Number(n.shares) > 0) {
              costBasisPrice.checked++;
              const implied = (n.costBasisCents - (b?.costBasisCents ?? 0)) / delta;
              const price = n.marketValueCents / Number(n.shares);
              if (price > 0 && Math.abs(implied / price - 1) <= 0.05) costBasisPrice.agrees++;
            }
          }
          if (changed) intervalsWithChange++;
          mostPositionsChangedAtOnce = Math.max(mostPositionsChangedAtOnce, changed);
        }
      }

      const shapes: InstitutionSurvey["shapes"] = {};
      for (const [kind, counts] of shapeCounts)
        shapes[kind] = [...counts.entries()]
          .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
          .slice(0, SHAPES_PER_KIND)
          .map(([shape, n]) => ({ shape, n }));

      return {
        institution,
        accounts: accts.length,
        transactions: rows.length,
        daysBack: earliest ? daysBetween(earliest, asOf) : null,
        activity,
        withSymbolLikeToken,
        withQuantityLikeNumber,
        snapshotDays: new Set(snaps.map((s) => `${s.accountId}|${s.on}`)).size,
        medianDaysBetweenSnapshots: median(gaps),
        positions: latest.length,
        withoutSymbol: latest.filter((s) => !s.symbol).length,
        costBasisFilled: latest.filter((s) => s.costBasisCents !== null).length,
        cashLike: { count: new Set([...cashKeys].filter((k) => latest.some((s) => `${s.accountId}|${s.externalId}` === k))).size, signals: [...cashSignals].sort() },
        intervals,
        intervalsWithChange,
        mostPositionsChangedAtOnce,
        costBasisPrice,
        shapes,
      };
    })
    .sort((a, b) => a.institution.localeCompare(b.institution));
}

const KINDS: InvestmentActivity[] = ["buy", "sell", "reinvestment", "dividend", "interest", "fee", "transfer", "other"];

/** The survey as Markdown, ready to read and, once checked, paste into #316. */
export function renderSurvey(survey: InstitutionSurvey[]): string {
  if (!survey.length) return "No brokerage or retirement accounts found.";
  const cell = (n: number, of: number) => (of ? `${n} of ${of}` : "–");
  const lines = [
    "## Per institution",
    "",
    "| Institution | Accounts | Cash rows | Days back | Symbol-like token | Quantity-like number | Positions | No symbol | Cost basis | Cash-like | Days between syncs | Syncs with a change | Most changed at once | Cost basis gives price |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...survey.map((s) =>
      [
        s.institution,
        s.accounts,
        s.transactions,
        s.daysBack ?? "–",
        cell(s.withSymbolLikeToken, s.transactions),
        cell(s.withQuantityLikeNumber, s.transactions),
        s.positions,
        cell(s.withoutSymbol, s.positions),
        cell(s.costBasisFilled, s.positions),
        s.cashLike.count ? `${s.cashLike.count} (${s.cashLike.signals.join(", ")})` : "0",
        s.medianDaysBetweenSnapshots ?? "–",
        cell(s.intervalsWithChange, s.intervals),
        s.mostPositionsChangedAtOnce,
        cell(s.costBasisPrice.agrees, s.costBasisPrice.checked),
      ].join(" | "),
    ).map((row) => `| ${row} |`),
    "",
    "## Activity the existing patterns recognize (#24)",
    "",
    `| Institution | ${KINDS.join(" | ")} |`,
    `|---|${KINDS.map(() => "---").join("|")}|`,
    ...survey.map((s) => `| ${s.institution} | ${KINDS.map((k) => s.activity[k] ?? 0).join(" | ")} |`),
    "",
    "## Description shapes (check before sharing)",
    "",
    "Numbers are #, money is $#, and any word outside a fixed list of brokerage words is …",
  ];
  for (const s of survey) {
    lines.push("", `### ${s.institution}`);
    for (const k of KINDS) {
      const shapes = s.shapes[k];
      if (!shapes?.length) continue;
      lines.push("", `${k}:`, ...shapes.map((x) => `- \`${x.shape}\` × ${x.n}`));
    }
  }
  return lines.join("\n");
}
