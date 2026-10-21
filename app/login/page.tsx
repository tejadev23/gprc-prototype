"use client";

import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4 text-foreground">
      <form
        className="w-full max-w-sm space-y-3 rounded-lg border border-white/10 bg-[#101214] p-4"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          void fetch("/api/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, password }),
          })
            .then(async (response) => {
              if (!response.ok) {
                const body = (await response.json().catch(() => null)) as { error?: string } | null;
                setError(body?.error ?? "Could not sign in.");
                setBusy(false);
                return;
              }
              window.location.assign("/");
            })
            .catch(() => {
              setError("Could not sign in.");
              setBusy(false);
            });
        }}
      >
        <h1 className="text-lg font-medium">Sign in to GPRC</h1>
        <p className="text-[12px] text-muted">Accounts are created by an administrator. There is no public registration.</p>
        <label className="block text-[12px] text-muted">
          Email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1 text-foreground"
            required
          />
        </label>
        <label className="block text-[12px] text-muted">
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1 text-foreground"
            required
          />
        </label>
        {error && <p className="text-[12px] text-cut">{error}</p>}
        <button type="submit" disabled={busy} className="rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-black disabled:opacity-50">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
