"use client";

import { useMemo, useState } from "react";
import { placedSections } from "@/lib/corridor/alignment-geometry";
import type { PlanAlignment } from "@/lib/corridor/alignment";
import type { Georef } from "@/lib/corridor/georef/model";
import { exportCorridorKmz, kmzBlockers, type KmzExportResult } from "@/lib/corridor/kmz/export";
import type { KmzOptions } from "@/lib/corridor/kmz/options";
import { isSectionReady } from "@/lib/corridor/stations";
import type { Station } from "@/lib/corridor/types";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onToggle: () => void;
  projectName: string;
  stations: readonly Station[];
  alignment: PlanAlignment;
  georef: Georef;
  /** The rasterised plan the control points were picked on. */
  plan: { url: string; width: number; height: number } | null;
  stationingFtPerPx: number | null;
  options: KmzOptions;
  onOptions: (next: KmzOptions) => void;
};

type Status = { kind: "idle" } | { kind: "working" } | { kind: "done"; result: KmzExportResult };

const SURFACES: { key: "existing" | "proposed" | "cut" | "fill"; label: string }[] = [
  { key: "existing", label: "Existing ground" },
  { key: "proposed", label: "Proposed grade" },
  { key: "cut", label: "Cut" },
  { key: "fill", label: "Fill" },
];

export function KmzExportPanel({ open, onToggle, projectName, stations, alignment, georef, plan, stationingFtPerPx, options, onOptions }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const context = useMemo(() => ({ raster: plan ? { width: plan.width, height: plan.height } : null, stationingFtPerPx }), [plan, stationingFtPerPx]);
  const blockers = useMemo(
    () => kmzBlockers({ projectName, stations, alignment, georef, context }),
    [projectName, stations, alignment, georef, context],
  );
  const bays = useMemo(() => {
    const placed = placedSections(stations, alignment);
    const drawn: string[] = [];
    const gaps: string[] = [];
    for (let i = 0; i < placed.length - 1; i++) {
      const name = `${placed[i].marker.label} to ${placed[i + 1].marker.label}`;
      (isSectionReady(placed[i].station) && isSectionReady(placed[i + 1].station) ? drawn : gaps).push(name);
    }
    return { placed: placed.length, drawn, gaps };
  }, [stations, alignment]);
  const set = (patch: Partial<KmzOptions>) => {
    setStatus({ kind: "idle" });
    onOptions({ ...options, ...patch });
  };
  const noSurface = !options.existing && !options.proposed && !options.cut && !options.fill;
  const canExport = blockers.length === 0 && !noSurface && bays.drawn.length > 0 && status.kind !== "working";

  const run = async () => {
    setStatus({ kind: "working" });
    let planImage = null;
    if (options.planOverlay && plan) {
      try {
        const blob = await (await fetch(plan.url)).blob();
        planImage = { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, width: plan.width, height: plan.height };
      } catch {
        setStatus({ kind: "done", result: { ok: false, errors: ["The plan image could not be read for the overlay."] } });
        return;
      }
    }
    const result = exportCorridorKmz({ projectName, stations, alignment, georef, context, options, planImage });
    if (result.ok) {
      const url = URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: "application/vnd.google-earth.kmz" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
    setStatus({ kind: "done", result });
  };

  return (
    <div className="max-h-[46%] min-h-0 shrink-0 overflow-hidden border-t border-white/[0.06] bg-[#101214]" data-kmz-panel="">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] text-muted hover:text-foreground"
        aria-expanded={open}
      >
        <span className="font-medium uppercase tracking-[0.14em]">Export</span>
        <span>
          {blockers.length > 0 ? "Not ready" : `${bays.drawn.length} ${bays.drawn.length === 1 ? "bay" : "bays"} ready`}
          {bays.gaps.length > 0 ? ` · ${bays.gaps.length} gap${bays.gaps.length === 1 ? "" : "s"}` : ""}
        </span>
        <span className="ml-auto">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="max-h-[calc(100%-1.75rem)] space-y-2 overflow-auto px-2 pb-2 text-[11px]">
          <p className="text-muted">
            Writes the reconstructed corridor, as placed on the georeferenced plan, to a KMZ for Google Earth. Existing ground and proposed grade are
            separate folders you can switch on and off.
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {SURFACES.map(({ key, label }) => (
              <Check key={key} label={label} checked={options[key]} onChange={(value) => set({ [key]: value })} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Check label="Section lines" checked={options.sectionLines} onChange={(value) => set({ sectionLines: value })} />
            <Check label="Mainline" checked={options.mainline} onChange={(value) => set({ mainline: value })} />
            <Check label="Plan image underlay" checked={options.planOverlay} onChange={(value) => set({ planOverlay: value })} />
            <Check label="Station labels" checked={options.stationLabels} onChange={(value) => set({ stationLabels: value })} />
          </div>
          <label className="flex flex-wrap items-center gap-2 text-muted">
            Altitude
            <select
              aria-label="Altitude mode"
              value={options.altitudeMode}
              onChange={(event) => set({ altitudeMode: event.target.value === "clampToGround" ? "clampToGround" : "absolute" })}
              className="rounded border border-white/10 bg-[#0b0c0e] px-1.5 py-1 text-foreground"
            >
              <option value="absolute">On the ground, sheet shape kept</option>
              <option value="clampToGround">Clamp to ground: ignore elevations</option>
            </select>
          </label>
          {options.altitudeMode === "absolute" ? (
            <p className="text-muted">
              The roadway is placed on the Google Earth ground. Heights above and below that line stay as on the sheet ({georef.vertical.datum || "datum not stated"}, {georef.vertical.units}). The sheet elevation itself is not stacked on top of the terrain.
            </p>
          ) : (
            <p className="text-amber-200">Clamped surfaces are flat footprints on the terrain, so existing and proposed overlap and cut/fill show no depth.</p>
          )}
          {bays.gaps.length > 0 && (
            <p className="text-amber-200">
              No surface will be drawn between {bays.gaps.join(", ")}: a section there is missing or unfinished. Gaps are kept, never bridged.
            </p>
          )}
          {noSurface && <p className="text-cut">Choose at least one surface.</p>}
          {blockers.length > 0 && (
            <ul className="space-y-0.5 text-cut">
              {blockers.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
          {blockers.length === 0 && bays.drawn.length === 0 && !noSurface && (
            <p className="text-amber-200">
              A surface needs two neighbouring finished sections, each with an existing and a proposed profile of two or more points.
            </p>
          )}
          <button
            type="button"
            disabled={!canExport}
            onClick={() => void run()}
            className={cn("rounded-md px-3 py-1.5 text-[12px] font-medium", canExport ? "bg-accent text-black" : "cursor-not-allowed bg-white/10 text-muted")}
          >
            {status.kind === "working" ? "Exporting…" : "Export 3D Corridor (KMZ)"}
          </button>
          {status.kind === "done" && <Result result={status.result} />}
        </div>
      )}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-foreground">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function Result({ result }: { result: KmzExportResult }) {
  if (!result.ok) {
    return (
      <div role="alert" className="space-y-0.5 rounded border border-cut/40 px-2 py-1 text-cut" data-kmz-result="error">
        {result.errors.map((message) => (
          <p key={message}>{message}</p>
        ))}
      </div>
    );
  }
  const { validation, fileName, bytes, expect, warnings } = result;
  const triangles = Object.entries(validation.stats.triangles).filter(([, count]) => count > 0);
  return (
    <div className="space-y-0.5 rounded border border-fill/40 px-2 py-1" data-kmz-result="ok">
      <p className="text-fill">
        Saved {fileName} ({(bytes.length / 1024).toFixed(0)} KB)
      </p>
      <p className="text-muted">
        {expect.drawnBays.length} bays, {triangles.map(([kind, count]) => `${count} ${kind} triangles`).join(", ")}, as a 3D model. Checked: zip, XML,
        coordinate ranges, altitude mode, triangle counts and gaps. Open it in the Google Earth 3D view. Street View can draw a model in the sky when the
        panorama altitude is wrong.
      </p>
      {warnings.map((message) => (
        <p key={message} className="text-amber-200">
          {message}
        </p>
      ))}
    </div>
  );
}
