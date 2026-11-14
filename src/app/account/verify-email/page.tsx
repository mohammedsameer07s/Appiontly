import Link from "next/link";

import { verifyEmailAddress } from "@/app/actions";

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams?: Promise<{ token?: string; error?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const token = params.token ?? "";
  return (
    <main className="formFrame">
      <section className="formPanel">
        <h1>Verify your email address</h1>
        {params.error ? <p role="alert">{params.error}</p> : null}
        {token ? (
          <form action={verifyEmailAddress}>
            <input type="hidden" name="token" value={token} />
            <p>Confirm this address to enable appointment bookings.</p>
            <button type="submit">Verify email</button>
          </form>
        ) : <p>This link is missing its verification token. Request another from your account page.</p>}
        <p><Link className="inlineLink" href="/login">Sign in</Link></p>
      </section>
    </main>
  );
}
