"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { exportLocalIdbProjects, listLocalIdbProjects, type LocalProjectListing } from "@/lib/migrate/idb";
import { sha256Hex } from "@/lib/migrate/hash";
import type { FileUploadResult } from "@/lib/migrate/upload";
import { uploadPlannedFiles } from "@/lib/migrate/upload";
import type { ImportReport } from "@/lib/migrate/types";
import { unpackMigrationZip, type PackedMigrationProject } from "@/lib/migrate/zip";
import { MAX_UPLOAD_BYTES } from "@/lib/objects/limits";

function formatBytes(value: number | null): string {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadZip(bytes: Uint8Array, name: string) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

async function postImport(packed: PackedMigrationProject[], dryRun: boolean, overwriteIds: string[], origin: string | null): Promise<ImportReport> {
  const response = await fetch("/api/projects/import", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dryRun,
      overwriteIds,
      origin,
      items: packed.map((item) => ({
        project: item.payload.project,
        gprc: item.payload.gprc,
        files: item.meta.files,
      })),
    }),
  });
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("Sign in required.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Could not run the import.");
  }
  return (await response.json()) as ImportReport;
}

function ReportView({ report, files }: { report: ImportReport; files?: FileUploadResult[] }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-2 text-[12px] sm:grid-cols-2">
        <div>Projects in archive: {report.totals.incomingProjects}</div>
        <div>Imported: {report.totals.imported}</div>
        <div>Skipped: {report.totals.skipped}</div>
        <div>Overwritten: {report.totals.overwritten}</div>
        <div>Failed: {report.totals.failed}</div>
        <div>
          Stations in archive / on server: {report.totals.incomingStations} / {report.totals.hostedStations}
        </div>
        <div>
          Files in archive / already hosted: {report.totals.incomingFiles} / {report.totals.hostedFiles}
        </div>
        <div>Files planned to upload: {report.totals.filesToUpload}</div>
        <div>Files rejected: {report.totals.filesRejected}</div>
      </div>
      <ul className="space-y-2">
        {report.results.map((item) => (
          <li key={item.id} className="rounded-md border border-white/10 p-2 text-[12px]">
            <div className="font-medium text-foreground">
              {item.name}{" "}
              <span className="font-normal text-muted">
                ({item.action}
                {item.reason ? ` — ${item.reason}` : ""})
              </span>
            </div>
            <div className="mt-1 text-muted">
              Stations {item.stations.incoming}
              {item.stations.hosted != null ? ` → hosted ${item.stations.hosted}` : ""} · Alignment markers {item.alignmentMarkerCount} ·
              Georef points {item.georefPointCount}
            </div>
            {(["pdf", "plan"] as const).map((kind) => {
              const file = item.files[kind];
              if (file.action === "none" && !file.incoming && !file.hosted) return null;
              return (
                <div key={kind} className="text-muted">
                  {kind}: {file.action}
                  {file.incoming ? ` · ${formatBytes(file.incoming.byteSize)} · ${file.incoming.sha256.slice(0, 12)}…` : ""}
                  {file.hosted ? ` · hosted ${formatBytes(file.hosted.byteSize)}` : ""}
                  {file.reason ? ` · ${file.reason}` : ""}
                </div>
              );
            })}
          </li>
        ))}
      </ul>
      {files && (
        <div>
          <div className="text-[12px] font-medium">File uploads</div>
          <ul className="mt-1 space-y-1 text-[12px] text-muted">
            {files.length === 0 && <li>No files were uploaded.</li>}
            {files.map((file) => (
              <li key={`${file.id}-${file.kind}`}>
                {file.kind} for {file.id}: {file.action}
                {` · ${formatBytes(file.byteSize)} · ${file.sha256.slice(0, 12)}…`}
                {file.reason ? ` · ${file.reason}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function MigrateWorkspace() {
  const [listing, setListing] = useState<LocalProjectListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [packed, setPacked] = useState<PackedMigrationProject[] | null>(null);
  const [archiveOrigin, setArchiveOrigin] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportReport | null>(null);
  const [applied, setApplied] = useState<ImportReport | null>(null);
  const [validation, setValidation] = useState<ImportReport | null>(null);
  const [fileResults, setFileResults] = useState<FileUploadResult[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  const refreshListing = useCallback(async () => {
    setListError(null);
    try {
      const next = await listLocalIdbProjects();
      setListing(next);
      setSelected(new Set(next.projects.map((project) => project.id)));
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Could not read IndexedDB.");
    }
  }, []);

  useEffect(() => {
    void refreshListing();
  }, [refreshListing]);

  const skippedExisting = useMemo(() => preview?.results.filter((item) => item.action === "skip") ?? [], [preview]);

  const exportSelected = async () => {
    setError(null);
    setBusy("export");
    try {
      const ids = [...selected];
      const result = await exportLocalIdbProjects(ids);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadZip(result.zip, `gprc-migration-${stamp}.zip`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export.");
    } finally {
      setBusy(null);
    }
  };

  const onZip = async (file: File) => {
    setError(null);
    setPreview(null);
    setApplied(null);
    setValidation(null);
    setFileResults(null);
    setConfirmOverwrite(false);
    setBusy("read");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const unpacked = await unpackMigrationZip(bytes, sha256Hex);
      setPacked(unpacked.projects);
      setArchiveOrigin(unpacked.manifest.origin);
      const report = await postImport(unpacked.projects, true, [], unpacked.manifest.origin);
      setPreview(report);
    } catch (err) {
      setPacked(null);
      setError(err instanceof Error ? err.message : "Could not read that archive.");
    } finally {
      setBusy(null);
    }
  };

  const runImport = async (overwrite: boolean) => {
    if (!packed) return;
    if (overwrite && !confirmOverwrite) return;
    setError(null);
    setBusy(overwrite ? "overwrite" : "import");
    try {
      const overwriteIds = overwrite ? skippedExisting.map((item) => item.id) : [];
      const report = await postImport(packed, false, overwriteIds, archiveOrigin);
      setApplied(report);
      const files = await uploadPlannedFiles(packed, report, new Set(overwriteIds));
      setFileResults(files);
      setValidation(await postImport(packed, true, [], archiveOrigin));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-8 text-foreground">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium">Migrate projects</h1>
          <p className="mt-1 text-[13px] text-muted">
            Export from the browser that already holds the local IndexedDB, then import while signed into the hosted account.
          </p>
        </div>
        <a href="/" className="text-[13px] text-accent hover:underline">
          Back to GPRC
        </a>
      </div>

      <section className="space-y-3 rounded-lg border border-white/10 bg-card p-4">
        <h2 className="text-[14px] font-medium">1. Export from this browser origin</h2>
        <p className="text-[12px] text-muted">
          IndexedDB is scoped to a browser profile and origin. This page reads <code className="text-foreground">earthwork-corridor</code>{" "}
          on <span className="text-foreground">{listing?.origin || (typeof window === "undefined" ? "" : window.location.origin)}</span>{" "}
          only. It uses a read-only transaction and does not change local records.
        </p>
        {listing && !listing.found && (
          <p className="text-[12px] text-cut">
            No local GPRC database was found here. If the projects live in another browser, profile, or on localhost, open this page there
            instead, export the zip, then come back to the hosted app to import.
          </p>
        )}
        {listError && <p className="text-[12px] text-cut">{listError}</p>}
        <button type="button" className="text-[12px] text-accent" onClick={() => void refreshListing()}>
          Refresh local list
        </button>
        {listing && listing.projects.length > 0 && (
          <ul className="space-y-2">
            {listing.projects.map((project) => (
              <li key={project.id} className="flex items-start gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={selected.has(project.id)}
                  onChange={(event) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(project.id);
                      else next.delete(project.id);
                      return next;
                    });
                  }}
                />
                <div>
                  <div className="text-foreground">{project.name}</div>
                  <div className="text-muted">
                    {project.stationCount} stations · PDF {project.hasPdf ? formatBytes(project.pdfBytes) : "none"}
                    {project.pdfBytes != null && project.pdfBytes > MAX_UPLOAD_BYTES ? " (over 40 MB)" : ""} · Plan{" "}
                    {project.hasPlan ? formatBytes(project.planBytes) : "none"}
                    {project.planBytes != null && project.planBytes > MAX_UPLOAD_BYTES ? " (over 40 MB)" : ""} · Markers{" "}
                    {project.alignmentMarkerCount} · Georef {project.georefPointCount}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          disabled={busy != null || selected.size === 0}
          onClick={() => void exportSelected()}
          className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-black disabled:opacity-50"
        >
          {busy === "export" ? "Exporting…" : `Download zip (${selected.size})`}
        </button>
      </section>

      <section className="space-y-3 rounded-lg border border-white/10 bg-card p-4">
        <h2 className="text-[14px] font-medium">2. Preview and import into this account</h2>
        <p className="text-[12px] text-muted">
          Sign into the hosted app, choose the zip, and review the preview. Existing project ids are skipped unless you confirm overwrite
          separately. Files go through the normal upload API. Nothing in the zip contains database or storage credentials.
        </p>
        <input
          type="file"
          accept=".zip,application/zip"
          disabled={busy != null}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onZip(file);
            event.target.value = "";
          }}
        />
        {archiveOrigin && <p className="text-[12px] text-muted">Archive origin: {archiveOrigin}</p>}
        {error && <p className="text-[12px] text-cut">{error}</p>}
        {preview && (
          <>
            <h3 className="text-[13px] font-medium">Preview (no writes yet)</h3>
            <ReportView report={preview} />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy != null || !packed}
                onClick={() => void runImport(false)}
                className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-black disabled:opacity-50"
              >
                {busy === "import" ? "Importing…" : "Import new projects"}
              </button>
            </div>
            {skippedExisting.length > 0 && (
              <div className="space-y-2 rounded-md border border-cut/40 p-3">
                <p className="text-[12px] text-cut">
                  {skippedExisting.length} project{skippedExisting.length === 1 ? "" : "s"} already exist on this account. Importing again
                  will not change them unless you confirm overwrite.
                </p>
                <label className="flex items-start gap-2 text-[12px]">
                  <input type="checkbox" checked={confirmOverwrite} onChange={(event) => setConfirmOverwrite(event.target.checked)} />
                  Replace those existing projects and their files with the archive copies.
                </label>
                <button
                  type="button"
                  disabled={busy != null || !confirmOverwrite || !packed}
                  onClick={() => void runImport(true)}
                  className="rounded-md bg-cut px-3 py-1.5 text-[13px] font-medium text-black disabled:opacity-50"
                >
                  {busy === "overwrite" ? "Overwriting…" : "Overwrite existing projects"}
                </button>
              </div>
            )}
          </>
        )}
        {applied && (
          <>
            <h3 className="text-[13px] font-medium">Import result</h3>
            <ReportView report={applied} files={fileResults ?? undefined} />
          </>
        )}
        {validation && (
          <>
            <h3 className="text-[13px] font-medium">Validation after import</h3>
            <p className="text-[12px] text-muted">
              Existing ids should now be skipped. Station and file counts should match the archive except for rejected files.
            </p>
            <ReportView report={validation} />
          </>
        )}
      </section>
    </main>
  );
}
