import { verifyPhoneNumber } from "@/app/actions";

export default async function VerifyPhonePage({
  searchParams,
}: {
  searchParams?: Promise<{ challenge?: string; error?: string }>;
}) {
  const params = (await searchParams) ?? {};
  return (
    <main className="formFrame">
      <section className="formPanel">
        <h1>Verify your phone number</h1>
        {params.error ? <p role="alert">{params.error}</p> : null}
        {params.challenge ? (
          <form action={verifyPhoneNumber}>
            <input type="hidden" name="challengeId" value={params.challenge} />
            <label>Six-digit code<input name="code" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required /></label>
            <button type="submit">Verify phone</button>
          </form>
        ) : <p>This verification link is missing its challenge. Request a new code from your account page.</p>}
      </section>
    </main>
  );
}
