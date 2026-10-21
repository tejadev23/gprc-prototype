import { NextResponse } from "next/server";
import { database, fromError, notFound, requireUser, unauthorized } from "@/lib/http";
import { loadForOwner, removeForOwner, saveForOwner } from "@/lib/projects/repo";
import { parseGprcBody, parseProjectBody } from "@/lib/projects/validate";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const loaded = await loadForOwner(database(), user.userId, id);
  if (!loaded) return notFound();
  return NextResponse.json(loaded);
}

export async function PUT(request: Request, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as {
    project?: unknown;
    gprc?: unknown;
    revision?: number;
    touchLast?: boolean;
  } | null;
  if (!body || typeof body.revision !== "number") return NextResponse.json({ error: "Revision is required." }, { status: 400 });
  try {
    const project = body.project ? parseProjectBody(body.project, id) : null;
    if (!project) return NextResponse.json({ error: "Project is required." }, { status: 400 });
    const gprc = body.gprc === undefined ? undefined : parseGprcBody(body.gprc);
    const revision = await saveForOwner(database(), user.userId, project, gprc, body.revision, body.touchLast !== false);
    return NextResponse.json({ revision });
  } catch (error) {
    return fromError(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const removed = await removeForOwner(database(), user.userId, id);
  if (!removed) return notFound();
  return NextResponse.json({ ok: true });
}
