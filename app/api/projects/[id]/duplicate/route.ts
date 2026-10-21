import { NextResponse } from "next/server";
import { database, notFound, requireUser, unauthorized } from "@/lib/http";
import { duplicateForOwner } from "@/lib/projects/repo";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id } = await params;
  const project = await duplicateForOwner(database(), user.userId, id);
  if (!project) return notFound();
  return NextResponse.json({ project, revision: 2 });
}
