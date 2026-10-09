import { redirect } from "next/navigation";
import { hasValidSession } from "@/lib/auth/session";
import { ownerHasPasskey } from "@/lib/auth/webauthn";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  if (await hasValidSession()) redirect("/");
  return (
    <main className="flex min-h-svh items-center justify-center px-4">
      <LoginForm setup={!(await ownerHasPasskey())} />
    </main>
  );
}
