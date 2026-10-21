import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db/client";
import { sessions, users } from "@/lib/db/schema";

export const SESSION_COOKIE = "gprc_session";
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<{ token: string; expires: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + FOURTEEN_DAYS_MS);
  await getDb().insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt: expires });
  return { token, expires };
}

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  };
}

export async function readSession(): Promise<{ userId: string; tokenHash: string } | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const tokenHash = hashToken(token);
  const rows = await getDb()
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { userId: row.userId, tokenHash };
}

export async function revokeSession(tokenHash: string): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

export async function userByEmail(email: string) {
  const rows = await getDb().select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return rows[0] ?? null;
}
