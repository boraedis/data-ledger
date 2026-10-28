// The settings tabs (#69). The active tab is in the URL (?tab=model), so
// a link can open one directly; anything else opens the first.
export const SETTINGS_TABS = [
  { id: "connections", label: "Connections" },
  { id: "notifications", label: "Notifications" },
  { id: "apple-pay", label: "Apple Pay" },
  { id: "model", label: "Model" },
  { id: "security", label: "Security" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

export function settingsTab(value: string | string[] | undefined): SettingsTab {
  const v = Array.isArray(value) ? value[0] : value;
  return SETTINGS_TABS.find((t) => t.id === v)?.id ?? "connections";
}

export const settingsHref = (tab: SettingsTab) => (tab === "connections" ? "/settings" : `/settings?tab=${tab}`);
