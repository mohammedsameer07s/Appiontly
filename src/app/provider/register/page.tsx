export const dynamic = "force-dynamic";

import Link from "next/link";

import { registerProvider } from "@/app/actions";
import { db } from "@/lib/db";

export default async function ProviderRegisterPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const error = (await searchParams)?.error ?? "";
  const categories = await db.category.findMany({ where: { active: true }, orderBy: { name: "asc" } });

  return (
    <main className="formFrame">
      <section className="formPanel">
        <h1>Register your business</h1>
        <p>Your listing stays private until an administrator approves it. Set your business time zone and regular opening hours.</p>
        {error ? <p role="alert" style={{ color: "#b91c1c", marginBottom: "16px" }}>{error}</p> : null}

        {categories.length ? (
          <form action={registerProvider}>
            <div className="formGrid">
              <label>Owner name<input name="name" maxLength={80} autoComplete="name" required /></label>
              <label>Phone<input name="phone" maxLength={20} autoComplete="tel" required /></label>
              <label className="checkboxLabel"><input name="smsNotificationsEnabled" type="checkbox" /> Receive booking and verification updates by SMS</label>
              <label className="fullWidth">Email<input name="email" type="email" maxLength={254} autoComplete="email" required /></label>
              <label className="fullWidth">Password (12–72 bytes)<input name="password" type="password" minLength={12} maxLength={72} autoComplete="new-password" required /></label>
              <label className="fullWidth">Business name<input name="businessName" maxLength={120} required /></label>
              <label>Category<select name="categoryId" required>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
              <label>City<input name="city" maxLength={80} required /></label>
              <label>Business latitude<input name="latitude" type="number" min="-90" max="90" step="any" placeholder="Optional" /></label>
              <label>Business longitude<input name="longitude" type="number" min="-180" max="180" step="any" placeholder="Optional" /></label>
              <label>Time zone<input name="timezone" defaultValue="Asia/Kolkata" maxLength={80} required /></label>
              <label className="fullWidth">Address<input name="address" maxLength={180} required /></label>
              <label className="fullWidth">Business description<textarea name="description" maxLength={1000} rows={4} required /></label>
              <label>First service<input name="serviceName" maxLength={100} required /></label>
              <label>Price (decimal amount)<input name="price" type="number" min="0" max="9999999" step="0.01" required /></label>
              <label>Duration (minutes)<input name="durationMinutes" type="number" min="5" max="480" step="5" defaultValue="30" required /></label>
              <label>Service details<input name="serviceDescription" maxLength={500} /></label>
            </div>
            <div className="formActions">
              <button type="submit">Submit for review</button>
              <Link className="inlineLink" href="/login">Already registered?</Link>
            </div>
          </form>
        ) : <p role="status">No active categories are available. An administrator must add a category before providers can register.</p>}
      </section>
    </main>
  );
}
