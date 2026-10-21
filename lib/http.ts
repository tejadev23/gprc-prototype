import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { MissingProject, StaleRevision } from "@/lib/projects/repo";
import { BadProjectData } from "@/lib/projects/validate";

export async function requireUser() {
  const session = await readSession();
  if (!session) return null;
  return session;
}

export function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401 });
}

export function fromError(error: unknown) {
  if (error instanceof MissingProject) return notFound();
  if (error instanceof StaleRevision) return NextResponse.json({ error: "conflict", revision: error.revision }, { status: 409 });
  if (error instanceof BadProjectData) return NextResponse.json({ error: error.message }, { status: 400 });
  throw error;
}

export function database() {
  return getDb();
}
