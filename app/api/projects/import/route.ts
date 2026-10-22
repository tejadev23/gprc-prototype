import { NextResponse } from "next/server";
import { database, fromError, requireUser, unauthorized } from "@/lib/http";
import { importProjectsForOwner, type ImportItemInput } from "@/lib/projects/import";
import { BadProjectData } from "@/lib/projects/validate";

export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const body = (await request.json().catch(() => null)) as {
    dryRun?: unknown;
    overwriteIds?: unknown;
    origin?: unknown;
    items?: unknown;
  } | null;
  if (!body || !Array.isArray(body.items)) {
    return NextResponse.json({ error: "items must be an array." }, { status: 400 });
  }
  if (body.items.length > 200) {
    return NextResponse.json({ error: "Too many projects in one import." }, { status: 400 });
  }
  const overwriteIds = Array.isArray(body.overwriteIds)
    ? body.overwriteIds.filter((id): id is string => typeof id === "string")
    : [];
  const dryRun = body.dryRun !== false;
  try {
    const report = await importProjectsForOwner(database(), user.userId, body.items as ImportItemInput[], {
      apply: !dryRun,
      overwriteIds,
      origin: typeof body.origin === "string" ? body.origin : null,
    });
    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof BadProjectData) return NextResponse.json({ error: error.message }, { status: 400 });
    return fromError(error);
  }
}
