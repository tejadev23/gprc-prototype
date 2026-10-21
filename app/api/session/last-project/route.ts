import { NextResponse } from "next/server";
import { database, fromError, requireUser, unauthorized } from "@/lib/http";
import { lastProjectFor, rememberProject } from "@/lib/projects/repo";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  const id = await lastProjectFor(database(), user.userId);
  return NextResponse.json({ id });
}

export async function PUT(request: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const body = (await request.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "Project id is required." }, { status: 400 });
  try {
    await rememberProject(database(), user.userId, body.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fromError(error);
  }
}
