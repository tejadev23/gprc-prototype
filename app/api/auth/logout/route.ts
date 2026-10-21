import { NextResponse } from "next/server";
import { readSession, revokeSession, SESSION_COOKIE } from "@/lib/auth/session";

export async function POST() {
  const session = await readSession();
  if (session) await revokeSession(session.tokenHash);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
