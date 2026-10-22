import { MAX_UPLOAD_BYTES } from "@/lib/objects/limits";
import type { ImportReport, MigrationFileKind } from "./types";
import type { PackedMigrationProject as Packed } from "./zip";

export type FileUploadResult = {
  id: string;
  kind: MigrationFileKind;
  action: "uploaded" | "skipped" | "failed";
  byteSize: number;
  sha256: string;
  reason: string | null;
};

function fileName(item: Packed, kind: MigrationFileKind, mime: string): string {
  if (kind === "pdf") {
    const name = item.payload.project.document.name;
    if (name) return name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
    return "sections.pdf";
  }
  const named = item.payload.gprc.planFileName;
  if (named) return named;
  if (mime === "image/jpeg") return "plan.jpg";
  if (mime === "image/webp") return "plan.webp";
  if (mime === "application/pdf") return "plan.pdf";
  return "plan.png";
}

export async function uploadPlannedFiles(
  packed: Packed[],
  report: ImportReport,
  overwriteIds: Set<string>,
): Promise<FileUploadResult[]> {
  const byId = new Map(packed.map((item) => [item.meta.id, item]));
  const results: FileUploadResult[] = [];
  for (const row of report.results) {
    if (row.action === "fail") continue;
    const item = byId.get(row.id);
    if (!item) continue;
    for (const kind of ["pdf", "plan"] as const) {
      const plan = row.files[kind];
      const bytes = item.files[kind];
      const meta = item.meta.files[kind];
      if (!meta || !bytes) continue;
      if (plan.action === "skip" || plan.action === "none") {
        results.push({ id: row.id, kind, action: "skipped", byteSize: meta.byteSize, sha256: meta.sha256, reason: plan.reason });
        continue;
      }
      if (plan.action === "reject") {
        results.push({ id: row.id, kind, action: "failed", byteSize: meta.byteSize, sha256: meta.sha256, reason: plan.reason });
        continue;
      }
      if (plan.action === "replace" && !overwriteIds.has(row.id)) {
        results.push({
          id: row.id,
          kind,
          action: "skipped",
          byteSize: meta.byteSize,
          sha256: meta.sha256,
          reason: "Existing file was not replaced.",
        });
        continue;
      }
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        results.push({ id: row.id, kind, action: "failed", byteSize: bytes.byteLength, sha256: meta.sha256, reason: "That file is larger than 40 MB." });
        continue;
      }
      const form = new FormData();
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      form.set("file", new File([copy], fileName(item, kind, meta.mime), { type: meta.mime }));
      const response = await fetch(`/api/projects/${row.id}/file?kind=${kind}`, { method: "PUT", body: form, credentials: "same-origin" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        results.push({
          id: row.id,
          kind,
          action: "failed",
          byteSize: meta.byteSize,
          sha256: meta.sha256,
          reason: body?.error ?? "Could not store the file.",
        });
        continue;
      }
      results.push({ id: row.id, kind, action: "uploaded", byteSize: meta.byteSize, sha256: meta.sha256, reason: null });
    }
  }
  return results;
}
