import { describe, expect, it } from "vitest";
import { explainMerchant, normalizeMerchant } from "@/lib/categorize/merchant";

// Every descriptor here is invented, written to look like bank output.
describe("normalizeMerchant", () => {
  it.each([
    ["CORNER BEAN CAFE #12", "Corner Bean Cafe"],
    ["POS PURCHASE CORNER BEAN CAFE #12", "Corner Bean Cafe"],
    ["SQ *CORNER BEAN CAFE", "Corner Bean Cafe"],
    ["DEBIT CARD PURCHASE SQ *CORNER BEAN CAFE 06/28 XXXX1234", "Corner Bean Cafe"],
    ["PURCHASE AUTHORIZED ON 06/27 QUILLFIELD MARKET #0412 S3851234567 CARD 4321", "Quillfield Market"],
    ["TST* LUCKY NOODLE HOUSE", "Lucky Noodle House"],
    ["STREAMFLIX.COM 800-555-0100", "Streamflix"],
    ["CITY POWER & LIGHT AUTOPAY", "City Power & Light"],
    ["MAPLEWOOD PROPERTY MGMT ONLINE PMT RENT", "Maplewood Property Mgmt Rent"],
    ["ZIPRIDE *TRIP 4821", "Zipride Trip"],
    ["PAYPAL *TUNEBOX", "Tunebox"],
    ["APLPAY THE PATIO GRILL", "The Patio Grill"],
    ["PAYPEER PAYMENT FROM ALEX RIVERA", "Paypeer Payment From Alex Rivera"],
  ])("%s → %s", (description, merchant) => {
    expect(normalizeMerchant(description)).toBe(merchant);
  });

  // #288: the same business in another town, and more processors.
  it.each([
    ["CORNER BEAN CAFE      SPRINGFIELD   IL", "Corner Bean Cafe"],
    ["SQ *CORNER BEAN CAFE    RIVERTON WA", "Corner Bean Cafe"],
    ["CORNER BEAN CAFE, SPRINGFIELD, IL", "Corner Bean Cafe"],
    ["CORNER BEAN CAFE, NEW HAVEN CT", "Corner Bean Cafe"],
    ["LUMEN BISTRO TX", "Lumen Bistro"],
    ["FS *PIXELFORGE APP", "Pixelforge App"],
    ["SQSP* INKWELL STUDIO", "Inkwell Studio"],
    ["BT*HOLLOWAY BOOKS", "Holloway Books"],
  ])("%s → %s", (description, merchant) => {
    expect(normalizeMerchant(description)).toBe(merchant);
  });

  it("keeps a code that could be a word, unless a location is clearly marked", () => {
    expect(normalizeMerchant("STARLIGHT DRIVE IN")).toBe("Starlight Drive in");
    expect(normalizeMerchant("HOLLOWAY & CO")).toBe("Holloway & Co");
    expect(normalizeMerchant("STARLIGHT DRIVE IN    MAPLETON  OR")).toBe("Starlight Drive in");
    // One word left isn't enough to tell a name from a town.
    expect(normalizeMerchant("ZIPRIDE TX")).toBe("Zipride Tx");
  });

  it("prefers a provider payee when there is one", () => {
    expect(normalizeMerchant("POS 4821 XXXX1234", "Corner Bean Cafe")).toBe("Corner Bean Cafe");
    expect(normalizeMerchant("CORNER BEAN CAFE #12", " ")).toBe("Corner Bean Cafe");
  });

  it("falls back to the original text rather than returning nothing", () => {
    expect(normalizeMerchant("1234567890")).toBe("1234567890");
  });

  it("is stable: the same merchant written differently normalizes the same", () => {
    const variants = ["CORNER BEAN CAFE #12", "SQ *CORNER BEAN CAFE 06/12", "POS PURCHASE CORNER BEAN CAFE #7"];
    expect(new Set(variants.map((v) => normalizeMerchant(v))).size).toBe(1);
  });
});

describe("explainMerchant (#290)", () => {
  it("says where the name came from and what was taken out, each with what it was", () => {
    const e = explainMerchant("SQ *CORNER BEAN CAFE #0412 04/12   SPRINGFIELD  IL");
    expect(e).toMatchObject({ source: "description", fellBack: false, name: "Corner Bean Cafe" });
    expect(e.removed).toEqual([
      { what: "location", text: "SPRINGFIELD IL" },
      { what: "prefix", text: "SQ *" },
      { what: "store number", text: "#0412" },
      { what: "date", text: "04/12" },
    ]);
  });

  it("prefers the provider's payee, and falls back to the text when cleaning leaves nothing", () => {
    expect(explainMerchant("POS PURCHASE 88231 FERNWOOD", "Fernwood Bakery")).toMatchObject({ source: "payee", input: "Fernwood Bakery", removed: [] });
    expect(explainMerchant("#1234")).toMatchObject({ fellBack: true, removed: [], name: "#1234" });
  });

  it("gives the same name as normalizeMerchant", () => {
    for (const d of ["APL PAY JUNIPER HARDWARE", "STREAMFLIX.COM 800-555-0100", "Corner Bean Cafe, Springfield, IL"])
      expect(explainMerchant(d).name).toBe(normalizeMerchant(d));
  });
});
