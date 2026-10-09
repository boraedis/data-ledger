import "server-only";
import { hasValidSession } from "@/lib/auth/session";
import { ownerHasPasskey, setupTokenMatches } from "@/lib/auth/webauthn";

export type RegistrationAccess = "session" | "bootstrap" | null;

/**
 * Who may register a passkey: the signed-in owner (adding a device), or —
 * only while no passkey exists yet — someone holding OWNER_SETUP_TOKEN.
 * Checked on both the options and the verify step, so the window can't be
 * raced open between them.
 */
export async function registrationAccess(setupToken: unknown): Promise<RegistrationAccess> {
  if (await hasValidSession()) return "session";
  if (!(await ownerHasPasskey()) && setupTokenMatches(setupToken)) return "bootstrap";
  return null;
}
