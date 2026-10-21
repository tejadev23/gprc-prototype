"use client";

import { useMemo } from "react";
import { CRS_OPTIONS, findCrs, unitLabel, type CrsUnits } from "@/lib/corridor/georef/crs";
import { MIN_AFFINE_POINTS } from "@/lib/corridor/georef/transform";
import { isComplete, type ControlPoint, type Georef, type GeorefMethod } from "@/lib/corridor/georef/model";
import { resolveGeoreference } from "@/lib/corridor/georef/pipeline";
import type { FitQuality, FitWarning } from "@/lib/corridor/georef/transform";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onToggle: () => void;
  georef: Georef;
  onChange: (next: Georef) => void;
  /** Size of the plan raster the control points are picked on. */
  raster: { width: number; height: number } | null;
  /** Feet per pixel implied by the traced stationing, when it is established. */
  stationingFtPerPx: number | null;
  /** Traced mainline end points in plan pixels, used for a readout of where the plan lands. */
  mainlineEnds: { start: { x: number; y: number }; end: { x: number; y: number } } | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  pickingId: string | null;
  onPick: (id: string | null) => void;
};

const QUALITY_TEXT: Record<FitQuality, { label: string; tone: string }> = {
  unvalidated: { label: "Exact fit, not validated", tone: "text-amber-200" },
  consistent: { label: "Points agree with each other", tone: "text-fill" },
  fair: { label: "Points agree loosely", tone: "text-amber-200" },
  poor: { label: "Points disagree", tone: "text-cut" },
};

export function GeoreferencePanel({
  open,
  onToggle,
  georef,
  onChange,
  raster,
  stationingFtPerPx,
  mainlineEnds,
  selectedId,
  onSelect,
  pickingId,
  onPick,
}: Props) {
  const crs = findCrs(georef.crs.code);
  const result = useMemo(
    () => resolveGeoreference(georef, { raster, stationingFtPerPx }),
    [georef, raster, stationingFtPerPx],
  );
  const complete = georef.points.filter((point) => !point.check && isComplete(point)).length;
  const affineAllowed = complete >= MIN_AFFINE_POINTS;
  const patchPoint = (id: string, patch: Partial<ControlPoint>) =>
    onChange({ ...georef, points: georef.points.map((point) => (point.id === id ? { ...point, ...patch } : point)) });
  const unit = unitLabel(georef.crs.units);
  const rows = result.ok ? new Map(result.georeference.report.residuals.map((row) => [row.id, row])) : new Map();
  const warnings: FitWarning[] = result.warnings;
  const summary = result.ok ? result.georeference.report : null;
  const tone = summary ? QUALITY_TEXT[summary.quality] : null;

  return (
    <div className="max-h-[46%] min-h-0 shrink-0 overflow-hidden border-t border-white/[0.06] bg-[#101214]" data-georef-panel="">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] text-muted hover:text-foreground"
        aria-expanded={open}
      >
        <span className="font-medium uppercase tracking-[0.14em]">Georeference</span>
        <span>
          {complete} control {complete === 1 ? "point" : "points"}
          {summary && tone ? ` · ${tone.label}` : ""}
        </span>
        <span className="ml-auto">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="max-h-[calc(100%-1.75rem)] space-y-2 overflow-auto px-2 pb-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-muted">
              Coordinate system
              <select
                aria-label="Coordinate system"
                value={georef.crs.code}
                onChange={(event) => {
                  const next = findCrs(event.target.value);
                  if (next) onChange({ ...georef, crs: { code: next.code, units: next.units, verified: false } });
                }}
                className="rounded border border-white/10 bg-[#0b0c0e] px-1.5 py-1 text-foreground"
              >
                {CRS_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.name} · {option.code}
                  </option>
                ))}
                {!crs && <option value={georef.crs.code}>{georef.crs.code} (not supported)</option>}
              </select>
            </label>
            <label className="flex items-center gap-1 text-muted" title="Tick once you have checked this against the plan sheet">
              <input
                type="checkbox"
                checked={georef.crs.verified}
                disabled={!crs}
                onChange={(event) => onChange({ ...georef, crs: { ...georef.crs, verified: event.target.checked } })}
              />
              I confirmed this matches the plan
            </label>
          </div>
          <p className="text-muted">
            Start from NAD83 / Georgia West (ftUS), as in PlanStitch, and change it if the sheet says otherwise. Eastings and northings below are in {unit}.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-muted">Fit</span>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="georef-method"
                checked={georef.method === "similarity"}
                onChange={() => onChange({ ...georef, method: "similarity" as GeorefMethod })}
              />
              Similarity (rotate, one scale, shift)
            </label>
            <label className={cn("flex items-center gap-1", !affineAllowed && "opacity-50")} title={affineAllowed ? undefined : `Needs ${MIN_AFFINE_POINTS} control points`}>
              <input
                type="radio"
                name="georef-method"
                disabled={!affineAllowed && georef.method !== "affine"}
                checked={georef.method === "affine"}
                onChange={() => onChange({ ...georef, method: "affine" as GeorefMethod })}
              />
              Affine (also stretch and shear)
            </label>
            {!affineAllowed && <span className="text-muted">Affine needs {MIN_AFFINE_POINTS}+ control points.</span>}
          </div>

          {georef.points.length === 0 ? (
            <p className="text-muted">
              Choose <span className="text-foreground">Control pts</span> in the plan toolbar, then click spots on the plan with known coordinates (manholes, corners, survey marks).
            </p>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-0.5 pr-1 font-normal">Point</th>
                  <th className="px-1 font-normal">Pixel</th>
                  <th className="px-1 font-normal">Easting ({unit})</th>
                  <th className="px-1 font-normal">Northing ({unit})</th>
                  <th className="px-1 font-normal" title="Check points are compared with the fit and never change it">
                    Check
                  </th>
                  <th className="px-1 font-normal">Error</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {georef.points.map((point) => {
                  const row = rows.get(point.id);
                  const selected = point.id === selectedId;
                  return (
                    <tr
                      key={point.id}
                      data-control-id={point.id}
                      className={cn("border-t border-white/[0.04]", selected && "bg-white/[0.06]")}
                      onClick={() => onSelect(point.id)}
                    >
                      <td className="py-0.5 pr-1">
                        <input
                          aria-label="Control point name"
                          defaultValue={point.name ?? ""}
                          key={`${point.id}:n:${point.name ?? ""}`}
                          onBlur={(event) => patchPoint(point.id, { name: event.target.value.trim() || undefined })}
                          className="w-16 rounded border border-transparent bg-transparent px-1 py-0.5 font-mono hover:border-white/10 focus:border-accent focus:outline-none"
                        />
                      </td>
                      <td className="whitespace-nowrap px-1 font-mono text-muted">
                        {point.px.toFixed(1)}, {point.py.toFixed(1)}
                      </td>
                      <td className="px-1">
                        <NumberField label="Easting" value={point.easting} onCommit={(value) => patchPoint(point.id, { easting: value })} />
                      </td>
                      <td className="px-1">
                        <NumberField label="Northing" value={point.northing} onCommit={(value) => patchPoint(point.id, { northing: value })} />
                      </td>
                      <td className="px-1 text-center">
                        <input
                          type="checkbox"
                          aria-label="Check point"
                          checked={point.check === true}
                          onChange={(event) => patchPoint(point.id, { check: event.target.checked || undefined })}
                        />
                      </td>
                      <td className={cn("whitespace-nowrap px-1 font-mono", row?.outlier ? "text-cut" : "text-muted")}>
                        {row ? `${row.residualFt.toFixed(2)} ft · ${row.residualPx.toFixed(1)} px${row.outlier ? " outlier" : ""}` : isComplete(point) ? "—" : "needs coordinates"}
                      </td>
                      <td className="whitespace-nowrap py-0.5 text-right">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onPick(pickingId === point.id ? null : point.id);
                          }}
                          className={cn("mr-1 rounded px-1.5 py-0.5", pickingId === point.id ? "bg-accent text-black" : "bg-white/10")}
                          title="Then click the new spot on the plan"
                        >
                          {pickingId === point.id ? "Click plan" : "Re-pick"}
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${point.name ?? "control point"}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (pickingId === point.id) onPick(null);
                            onChange({ ...georef, points: georef.points.filter((item) => item.id !== point.id) });
                          }}
                          className="rounded px-1 text-muted hover:text-cut"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {summary && tone && (
            <div className="space-y-0.5 rounded border border-white/[0.06] p-1.5" data-georef-summary="">
              <div className={cn("font-medium", tone.tone)}>{tone.label}</div>
              <div className="font-mono text-muted">
                scale {summary.scaleFtPerPx.toFixed(4)} ft/px · rotation {summary.rotationDeg.toFixed(3)}° · {summary.method}
              </div>
              {summary.rmsFt != null && summary.maxFt != null && summary.rmsPx != null && summary.maxPx != null && (
                <div className="font-mono text-muted">
                  control: rms {summary.rmsFt.toFixed(2)} ft ({summary.rmsPx.toFixed(1)} px) · max {summary.maxFt.toFixed(2)} ft ({summary.maxPx.toFixed(1)} px)
                </div>
              )}
              {summary.checkMaxFt != null && summary.checkMaxPx != null && (
                <div className="font-mono text-muted">
                  check points: max {summary.checkMaxFt.toFixed(2)} ft ({summary.checkMaxPx.toFixed(1)} px) from the fit
                </div>
              )}
              <div className="text-muted">
                This says how well your points agree, not how accurate the plan is. It is not a survey.
              </div>
            </div>
          )}

          {warnings.length > 0 && (
            <ul className="space-y-0.5" data-georef-warnings="">
              {warnings.map((warning, index) => (
                <li
                  key={`${warning.code}-${warning.pointId ?? index}`}
                  className={warning.level === "error" ? "text-cut" : warning.level === "warn" ? "text-amber-200" : "text-muted"}
                >
                  {warning.message}
                </li>
              ))}
            </ul>
          )}
          {!result.ok && warnings.length === 0 && <p className="text-amber-200">{result.reason}</p>}

          {result.ok && (
            <details>
              <summary className="cursor-pointer text-muted hover:text-foreground">Pixel → projected → WGS84, per point</summary>
              <div className="mt-1 overflow-x-auto">
                <table className="w-full border-collapse font-mono text-[10px] text-muted">
                  <thead>
                    <tr className="text-left">
                      <th className="pr-2 font-normal">Point</th>
                      <th className="pr-2 font-normal">Known lat, lon</th>
                      <th className="pr-2 font-normal">Fitted lat, lon</th>
                      <th className="font-normal">Ground error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.checks.map((check) => (
                      <tr key={check.id} className="border-t border-white/[0.04]">
                        <td className="pr-2">
                          {check.name ?? check.id.slice(0, 4)}
                          {check.check ? " (check)" : ""}
                        </td>
                        <td className="pr-2">
                          {check.known.lat.toFixed(7)}, {check.known.lon.toFixed(7)}
                        </td>
                        <td className="pr-2">
                          {check.fitted.lat.toFixed(7)}, {check.fitted.lon.toFixed(7)}
                        </td>
                        <td>{check.groundErrorM.toFixed(2)} m</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {mainlineEnds && (
                <div className="mt-1 font-mono text-[10px] text-muted">
                  {[
                    ["Mainline start", mainlineEnds.start],
                    ["Mainline end", mainlineEnds.end],
                  ].map(([label, at]) => {
                    const point = at as { x: number; y: number };
                    const lonLat = result.georeference.pixelToLonLat(point.x, point.y);
                    const projected = result.georeference.pixelToProjected(point.x, point.y);
                    return (
                      <div key={label as string}>
                        {label as string}: {lonLat.lat.toFixed(7)}, {lonLat.lon.toFixed(7)} · E {projected.easting.toFixed(2)} N {projected.northing.toFixed(2)} {unit}
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="mt-1 text-muted">
                NAD83 is treated as WGS84 here (about a metre apart in Georgia). Horizontal only.
              </p>
            </details>
          )}

          <div className="space-y-1 border-t border-white/[0.06] pt-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-muted">
                Vertical datum
                <input
                  aria-label="Vertical datum"
                  value={georef.vertical.datum}
                  placeholder="NAVD88"
                  onChange={(event) => onChange({ ...georef, vertical: { ...georef.vertical, datum: event.target.value } })}
                  className="w-24 rounded border border-white/10 bg-transparent px-1.5 py-1 text-foreground outline-none focus:border-accent"
                />
              </label>
              <label className="flex items-center gap-1 text-muted">
                Elevation units
                <select
                  aria-label="Elevation units"
                  value={georef.vertical.units}
                  onChange={(event) => onChange({ ...georef, vertical: { ...georef.vertical, units: event.target.value as CrsUnits } })}
                  className="rounded border border-white/10 bg-[#0b0c0e] px-1.5 py-1 text-foreground"
                >
                  <option value="ft-us">US survey feet</option>
                  <option value="ft-intl">International feet</option>
                  <option value="m">Metres</option>
                </select>
              </label>
            </div>
            <p className="text-muted">
              Elevations on the cross-section sheets are recorded as given. The vertical datum is a label only: nothing here converts it to the WGS84 ellipsoid height Google Earth expects.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function NumberField({ label, value, onCommit }: { label: string; value: number | null; onCommit: (value: number | null) => void }) {
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      defaultValue={value == null ? "" : String(value)}
      key={`${label}:${value ?? ""}`}
      onBlur={(event) => {
        const text = event.target.value.replace(/[,\s]/g, "");
        if (text === "") {
          onCommit(null);
          return;
        }
        const parsed = Number(text);
        if (Number.isFinite(parsed)) onCommit(parsed);
        else event.target.value = value == null ? "" : String(value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className="w-28 rounded border border-white/10 bg-transparent px-1 py-0.5 font-mono outline-none focus:border-accent"
    />
  );
}
