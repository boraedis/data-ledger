"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { defaultDeviceLabel, registerPasskey, signInWithPasskey } from "@/components/auth/passkey-client";

// Two modes on one page: normal passkey sign-in, or — on a fresh database
// with no passkey yet — first-run setup, which trades OWNER_SETUP_TOKEN for
// the owner's first passkey. The server enforces which mode is allowed;
// this only decides what to show.
export function LoginForm({ setup }: { setup: boolean }) {
  const router = useRouter();
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
      router.replace("/");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  }

  function handleSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(() => registerPasskey(defaultDeviceLabel(), setupToken));
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-2xl">Data Ledger</CardTitle>
        <CardDescription>
          {setup ? "First run: create the owner passkey." : "Sign in with your passkey."}
        </CardDescription>
      </CardHeader>
      {setup ? (
        <form onSubmit={handleSetup}>
          <CardContent className="space-y-2">
            <Label htmlFor="setup-token">Setup token</Label>
            <Input
              id="setup-token"
              type="password"
              autoComplete="off"
              autoFocus
              value={setupToken}
              onChange={(event) => setSetupToken(event.target.value)}
            />
            <p className="text-sm text-muted-foreground">The OWNER_SETUP_TOKEN value from this deployment&apos;s environment.</p>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </CardContent>
          <CardFooter className="mt-4">
            <Button type="submit" className="w-full" disabled={busy || !setupToken}>
              {busy ? "Waiting for passkey…" : "Create passkey"}
            </Button>
          </CardFooter>
        </form>
      ) : (
        <>
          {error ? (
            <CardContent>
              <p className="text-sm text-destructive">{error}</p>
            </CardContent>
          ) : null}
          <CardFooter>
            <Button className="w-full" disabled={busy} onClick={() => void run(signInWithPasskey)} autoFocus>
              {busy ? "Waiting for passkey…" : "Sign in with passkey"}
            </Button>
          </CardFooter>
        </>
      )}
    </Card>
  );
}
