import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";

import { logoutUser } from "@/app/actions";
import { isDatabaseConfigured } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Appointly | Book local services",
  description: "Discover local businesses, compare listed services, and request appointments.",
  referrer: "no-referrer",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const databaseConfigured = isDatabaseConfigured();
  const user = databaseConfigured ? await getSessionUser() : null;
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <header style={{ width: "min(1200px, calc(100% - 32px))", margin: "0 auto", padding: "18px 0 8px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
            <Link href="/" style={{ display: "flex", alignItems: "center", gap: "12px", fontWeight: 800, fontSize: "1.15rem" }}>
              <span style={{ width: "40px", height: "40px", borderRadius: "12px", background: "linear-gradient(135deg, #2563eb, #7c3aed)", display: "grid", placeItems: "center", color: "white" }}>A</span>
              Appointly
            </Link>

            <nav style={{ display: "flex", gap: "18px", color: "#334155", fontWeight: 600, flexWrap: "wrap" }}>
              <Link href="/">Home</Link>
              <Link href="/#businesses">Businesses</Link>
              {user?.role === "CUSTOMER" ? <Link href="/my-bookings">My bookings</Link> : null}
              {user?.role === "PROVIDER" ? <Link href="/provider/dashboard">Provider dashboard</Link> : null}
              {user?.role === "ADMIN" ? <Link href="/admin">Admin</Link> : null}
            </nav>

            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              {user ? (
                <>
                  <span>{user.name}</span>
                  <form action={logoutUser}><button type="submit" className="navButton">Sign out</button></form>
                </>
              ) : (
                <>
                  <Link href="/login">Login</Link>
                  <Link href="/register" style={{ background: "linear-gradient(135deg, #2563eb, #7c3aed)", color: "white", borderRadius: "999px", padding: "0.8rem 1.2rem", fontWeight: 700 }}>
                    Join now
                  </Link>
                </>
              )}
            </div>
          </div>
        </header>
        {databaseConfigured ? children : (
          <main className="pageBox" role="alert">
            <section className="summaryCard">
              <h1>Database setup required</h1>
              <p>Appointly needs PostgreSQL and a DATABASE_URL before it can load or save application data.</p>
              <ol>
                <li>Copy <code>.env.example</code> to <code>.env</code> in the project root.</li>
                <li>Start the local database with <code>docker compose up -d</code>.</li>
                <li>Run <code>npm run db:migrate</code> and <code>npm run db:seed</code>, then restart the app.</li>
              </ol>
              <p>See the README&apos;s Local setup section. No demo data or fallback database is used.</p>
            </section>
          </main>
        )}
      </body>
    </html>
  );
}
