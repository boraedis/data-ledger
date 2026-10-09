import { describe, expect, it } from "vitest";
import { normalizeMerchant } from "@/lib/categorize/merchant";

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
