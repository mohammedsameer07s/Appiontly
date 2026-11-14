import "server-only";

import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";

export const SESSION_COOKIE = "appointly-session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function getSessionUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || token.length > 200) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          active: true,
          emailVerifiedAt: true,
          phoneVerifiedAt: true,
          smsNotificationsEnabled: true,
        },
      },
      expiresAt: true,
    },
  });

  if (!session || session.expiresAt <= new Date() || !session.user.active) return null;
  return session.user;
}

export async function requireUser(roles?: Array<"CUSTOMER" | "PROVIDER" | "ADMIN">) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (roles && !roles.includes(user.role)) redirect("/");
  return user;
}
