import { NextResponse } from "next/server";
import { database, fromError, requireUser, unauthorized } from "@/lib/http";
import { createForOwner, listForOwner } from "@/lib/projects/repo";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  const projects = await listForOwner(database(), user.userId);
  return NextResponse.json({ projects });
}

export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const body = (await request.json().catch(() => null)) as { name?: string } | null;
  try {
    const created = await createForOwner(database(), user.userId, body?.name ?? "");
    return NextResponse.json(created);
  } catch (error) {
    return fromError(error);
  }
}
