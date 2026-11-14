import Link from "next/link";

import { resetPassword } from "@/app/actions";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams?: Promise<{ token?: string; error?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const token = params.token ?? "";
  return (
    <main className="formFrame">
      <section className="formPanel">
        <h1>Choose a new password</h1>
        {params.error ? <p role="alert">{params.error}</p> : null}
        {token ? (
          <form action={resetPassword}>
            <input type="hidden" name="token" value={token} />
            <label>New password<input name="password" type="password" minLength={12} maxLength={72} autoComplete="new-password" required /></label>
            <button type="submit">Save new password</button>
          </form>
        ) : <p>This reset link is missing its token. Request a new one.</p>}
        <p><Link className="inlineLink" href="/forgot-password">Request another reset link</Link></p>
      </section>
    </main>
  );
}
