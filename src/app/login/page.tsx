import Link from "next/link";

import { loginUser, verifyAdminMfa } from "@/app/actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; challenge?: string; message?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const error = params.error ?? "";

  return (
    <main className="formFrame">
      <section className="formPanel">
        <h1>Login to Appointly</h1>
        <p>Access your bookings, provider dashboard, and admin tools.</p>

        {error ? <p style={{ color: "#b91c1c", marginBottom: "16px" }}>{error}</p> : null}
        {params.message ? <p role="status">{params.message}</p> : null}

        {params.challenge ? (
          <form action={verifyAdminMfa}>
            <input type="hidden" name="challengeId" value={params.challenge} />
            <label className="fullWidth">Six-digit email code<input name="code" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} autoComplete="one-time-code" required /></label>
            <div className="formActions"><button type="submit">Verify and sign in</button></div>
          </form>
        ) : (
          <form action={loginUser}>
            <div className="formGrid">
              <label className="fullWidth">Email<input name="email" type="email" required /></label>
              <label className="fullWidth">Password<input name="password" type="password" maxLength={72} autoComplete="current-password" required /></label>
            </div>
            <div className="formActions">
              <button type="submit">Sign in</button>
              <Link className="inlineLink" href="/register">Create an account</Link>
              <Link className="inlineLink" href="/forgot-password">Forgot password?</Link>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
