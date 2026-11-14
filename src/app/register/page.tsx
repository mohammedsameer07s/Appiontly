import Link from "next/link";

import { registerCustomer } from "@/app/actions";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const error = (await searchParams)?.error ?? "";

  return (
    <main className="formFrame">
      <section className="formPanel">
        <h1>Create customer account</h1>
        <p>Search businesses, book services, and manage your appointments.</p>

        {error ? <p style={{ color: "#b91c1c", marginBottom: "16px" }}>{error}</p> : null}

        <form action={registerCustomer}>
          <div className="formGrid">
            <label>
              Full name
              <input name="name" required />
            </label>
            <label>
              Mobile number
              <input name="phone" required />
            </label>
            <label className="checkboxLabel">
              <input name="smsNotificationsEnabled" type="checkbox" />
              Receive booking and verification updates by SMS
            </label>
            <label className="fullWidth">
              Email
              <input name="email" type="email" required />
            </label>
            <label className="fullWidth">
              Password
              <input name="password" type="password" minLength={12} maxLength={72} autoComplete="new-password" required />
            </label>
          </div>

          <div className="formActions">
            <button type="submit">Create account</button>
            <Link className="inlineLink" href="/login">Already registered?</Link>
          </div>
        </form>
      </section>
    </main>
  );
}
