import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = pathname === "/login" || pathname === "/api/auth/login" || pathname === "/api/health";
  const token = request.cookies.get("gprc_session")?.value;
  if (!isPublic && !token) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (pathname === "/login" && token) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|pdf.worker.min.mjs).*)"],
};
