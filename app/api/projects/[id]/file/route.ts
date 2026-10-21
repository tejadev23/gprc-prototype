import { NextResponse } from "next/server";
import { database, fromError, notFound, requireUser, unauthorized } from "@/lib/http";
import { MAX_UPLOAD_BYTES } from "@/lib/objects/store";
import { clearFile, readFile, writeFile } from "@/lib/projects/repo";

type Params = { params: Promise<{ id: string }> };

function kindOf(request: Request): "pdf" | "plan" | null {
  const kind = new URL(request.url).searchParams.get("kind");
  return kind === "pdf" || kind === "plan" ? kind : null;
}

function allowed(kind: "pdf" | "plan", mime: string, name: string): boolean {
  if (kind === "pdf") return mime === "application/pdf" || name.toLowerCase().endsWith(".pdf");
  return mime === "application/pdf" || mime === "image/png" || mime === "image/jpeg" || mime === "image/webp" || /\.(pdf|png|jpe?g|webp)$/i.test(name);
}

export async function GET(request: Request, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const kind = kindOf(request);
  if (!kind) return NextResponse.json({ error: "kind must be pdf or plan." }, { status: 400 });
  const { id } = await params;
  const file = await readFile(database(), user.userId, id, kind);
  if (!file) return notFound();
  return new NextResponse(new Uint8Array(file.body), { headers: { "content-type": file.mime } });
}

export async function PUT(request: Request, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const kind = kindOf(request);
  if (!kind) return NextResponse.json({ error: "kind must be pdf or plan." }, { status: 400 });
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "That file is larger than 40 MB." }, { status: 413 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a file." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "That file is larger than 40 MB." }, { status: 413 });
  if (!allowed(kind, file.type, file.name)) return NextResponse.json({ error: "That file type is not accepted." }, { status: 400 });
  const { id } = await params;
  try {
    await writeFile(database(), user.userId, id, kind, Buffer.from(await file.arrayBuffer()), file.type || "application/octet-stream", file.name);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fromError(error);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const kind = kindOf(request);
  if (!kind) return NextResponse.json({ error: "kind must be pdf or plan." }, { status: 400 });
  const { id } = await params;
  try {
    await clearFile(database(), user.userId, id, kind);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fromError(error);
  }
}
