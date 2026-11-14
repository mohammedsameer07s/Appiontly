import Link from "next/link";

import { requestPasswordReset } from "@/app/actions";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; message?: string }>;
}) {
  const params = (await searchParams) ?? {};
  return (
    <main className="formFrame">
      <section className="formPanel">
        <h1>Reset your password</h1>
        <p>Enter your account email. If it is registered, we will send a secure reset link.</p>
        {params.error ? <p role="alert">{params.error}</p> : null}
        {params.message ? <p role="status">{params.message}</p> : null}
        <form action={requestPasswordReset}>
          <label>Email<input name="email" type="email" autoComplete="email" required /></label>
          <div className="formActions">
            <button type="submit">Send reset link</button>
            <Link className="inlineLink" href="/login">Back to sign in</Link>
          </div>
        </form>
      </section>
    </main>
  );
}
