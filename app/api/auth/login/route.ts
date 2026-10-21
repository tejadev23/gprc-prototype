import { NextResponse } from "next/server";
import { loginAllowed, recordLoginAttempt } from "@/lib/auth/rate-limit";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, sessionCookieOptions, userByEmail } from "@/lib/auth/session";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: string; password?: string } | null;
  const email = body?.email?.trim().toLowerCase() ?? "";
  const password = body?.password ?? "";
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!email || !password) return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  if (!(await loginAllowed(ip, email))) return NextResponse.json({ error: "Too many sign-in attempts. Try again later." }, { status: 429 });
  const user = await userByEmail(email);
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) {
    await recordLoginAttempt(ip, email);
    return NextResponse.json({ error: "Email or password is wrong." }, { status: 401 });
  }
  const session = await createSession(user.id);
  const response = NextResponse.json({ ok: true });
  response.cookies.set("gprc_session", session.token, sessionCookieOptions(session.expires));
  return response;
}
