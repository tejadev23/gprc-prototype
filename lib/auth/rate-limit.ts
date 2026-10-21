import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { loginAttempts } from "@/lib/db/schema";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export async function loginAllowed(ip: string, email: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS);
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.ip, ip), eq(loginAttempts.email, email.toLowerCase()), gt(loginAttempts.createdAt, since)));
  return (rows[0]?.count ?? 0) < MAX_ATTEMPTS;
}

export async function recordLoginAttempt(ip: string, email: string): Promise<void> {
  await getDb().insert(loginAttempts).values({ id: randomUUID(), ip, email: email.toLowerCase() });
}
