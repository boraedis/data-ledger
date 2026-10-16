import { expect, it } from "vitest";
import { settingsHref, settingsTab } from "./tabs";

it("reads the tab from the URL, defaulting to the first", () => {
  expect(settingsTab("model")).toBe("model");
  expect(settingsTab(["security", "model"])).toBe("security");
  expect(settingsTab(undefined)).toBe("connections");
  expect(settingsTab("nonsense")).toBe("connections");
  expect(settingsHref("apple-pay")).toBe("/settings?tab=apple-pay");
  expect(settingsHref("connections")).toBe("/settings");
});
