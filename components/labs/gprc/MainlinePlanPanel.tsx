"use client";

import { useEffect, useRef, useState } from "react";
import {
  alignmentWarnings,
  chainageDistance,
  pointOnPolyline,
  referenceScale,
  snapToPolyline,
  type AlignmentMarker,
  type PlanAlignment,
  type PlanPoint,
} from "@/lib/corridor/alignment";
import { canvasBox, clientToCanvasCss } from "@/lib/corridor/viewer";
import { parseStation } from "@/lib/corridor/stations";
import { cssToImage, fitView, imageToCss, pan, zoomAt } from "@/lib/tracing/coords";
import type { ViewState } from "@/lib/tracing/types";
import type { ControlPoint } from "@/lib/corridor/georef/model";
import { cn } from "@/lib/utils";

type Raster = { url: string; width: number; height: number };
export type PlanTool = "inspect" | "trace" | "station" | "control";

type Props = {
  hasProject: boolean;
  fileName: string | null;
  raster: Raster | null;
  loading: boolean;
  error: string | null;
  alignment: PlanAlignment;
  readyStationIds: readonly string[];
  onLoadFile: (file: File) => void;
  onAlignment: (next: PlanAlignment) => void;
  onCommitMarker: (marker: { id?: string; label: string; distancePx: number }) => string | null;
  onOpenSection: (marker: AlignmentMarker) => void;
  /** Georeferencing control points, in plan raster pixels. */
  controlPoints?: readonly ControlPoint[];
  selectedControlId?: string | null;
  /** When set, the next plan click moves this point instead of adding one. */
  pickingControlId?: string | null;
  onAddControl?: (px: number, py: number) => void;
  onSelectControl?: (id: string | null) => void;
  onMoveControl?: (id: string, px: number, py: number) => void;
  onToolChange?: (tool: PlanTool) => void;
};

export function MainlinePlanPanel({
  hasProject,
  fileName,
  raster,
  loading,
  error,
  alignment,
  readyStationIds,
  onLoadFile,
  onAlignment,
  onCommitMarker,
  onOpenSection,
  controlPoints = [],
  selectedControlId = null,
  pickingControlId = null,
  onAddControl,
  onSelectControl,
  onMoveControl,
  onToolChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<ViewState | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; moved: boolean; panning: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [userView, setUserView] = useState<ViewState | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [grabbing, setGrabbing] = useState(false);
  const [tool, setTool] = useState<PlanTool>("inspect");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ distancePx: number; id?: string; label: string } | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [chainage, setChainage] = useState("");
  const [chainageError, setChainageError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [selectStationFt, setSelectStationFt] = useState<number | null>(null);
  const rasterKey = raster?.url ?? "";
  const [seenRaster, setSeenRaster] = useState(rasterKey);

  if (rasterKey !== seenRaster) {
    setSeenRaster(rasterKey);
    setUserView(null);
    setImage(null);
  }
  if (selectedId && !alignment.markers.some((marker) => marker.id === selectedId)) setSelectedId(null);
  if (movingId && !alignment.markers.some((marker) => marker.id === movingId)) setMovingId(null);
  if (selectStationFt != null) {
    const located = alignment.markers.find((marker) => Math.abs(marker.stationFt - selectStationFt) < 1e-6);
    if (located) {
      setSelectedId(located.id);
      setSelectStationFt(null);
    }
  }

  const fitted =
    image && size.w >= 8 && size.h >= 8 ? fitView(size.w, size.h, image.naturalWidth, image.naturalHeight) : null;
  const view = userView ?? fitted;
  const warnings = alignmentWarnings(alignment.markers);
  const stationing =
    alignment.points.length < 2
      ? "Trace the mainline, then place station markers."
      : alignment.markers.length < 2
        ? "Stationing is not established. Place at least two station markers."
        : "";
  const rasterMismatch =
    alignment.points.length >= 2 &&
    alignment.rasterWidth != null &&
    alignment.rasterHeight != null &&
    raster != null &&
    (raster.width !== alignment.rasterWidth || raster.height !== alignment.rasterHeight);
  const traced = alignment.points.length >= 2;

  useEffect(() => {
    viewRef.current = view;
    imageRef.current = image;
  }, [view, image]);

  useEffect(() => {
    if (!raster) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setImage(img);
    };
    img.src = raster.url;
    return () => {
      cancelled = true;
    };
  }, [raster]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      setSize({ w: canvas.clientWidth, h: canvas.clientHeight });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      const current = viewRef.current;
      const img = imageRef.current;
      if (!current || !img) return;
      event.preventDefault();
      const css = clientToCanvasCss(event.clientX, event.clientY, canvasBox(canvas));
      const min = fitView(canvas.clientWidth, canvas.clientHeight, img.naturalWidth, img.naturalHeight).scale * 0.5;
      setUserView(zoomAt(current, css, event.deltaY > 0 ? 0.9 : 1.1, min, 16));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#121417";
    ctx.fillRect(0, 0, cssW, cssH);
    if (!image || !view) {
      ctx.fillStyle = "#8a8f98";
      ctx.font = "13px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const message = !hasProject
        ? "Open or duplicate a project to add a stitched plan"
        : loading
          ? "Opening plan…"
          : "Upload a stitched roadway plan";
      ctx.fillText(message, cssW / 2, cssH / 2);
      return;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, view.originX, view.originY, image.naturalWidth * view.scale, image.naturalHeight * view.scale);
    strokePlan(ctx, alignment.points, view, "#7f1d1d", false);
    strokePlan(ctx, alignment.draft, view, "#fbbf24", true);
    const ready = new Set(readyStationIds);
    for (const marker of alignment.markers) {
      const at = pointOnPolyline(alignment.points, marker.distancePx);
      if (!at) continue;
      const css = imageToCss(at.point, view);
      const selected = marker.id === selectedId;
      const complete = marker.stationId != null && ready.has(marker.stationId);
      ctx.beginPath();
      ctx.arc(css.x, css.y, selected ? 5 : 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = selected ? "#fbbf24" : "#7dd3fc";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (complete) {
        ctx.fillStyle = selected ? "#fbbf24" : "#7dd3fc";
        ctx.fill();
      }
      ctx.font = "11px ui-monospace, monospace";
      ctx.fillStyle = "#e2e8f0";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(marker.label, css.x + 8, css.y - 6);
    }
    for (const control of controlPoints) {
      const css = imageToCss({ x: control.px, y: control.py }, view);
      const selected = control.id === selectedControlId;
      const complete = control.easting != null && control.northing != null;
      const color = control.check ? "#f472b6" : complete ? "#34d399" : "#fbbf24";
      const arm = selected ? 11 : 8;
      ctx.lineWidth = selected ? 2.5 : 1.75;
      ctx.strokeStyle = "#0b0c0e";
      ctx.beginPath();
      ctx.moveTo(css.x - arm - 1, css.y);
      ctx.lineTo(css.x + arm + 1, css.y);
      ctx.moveTo(css.x, css.y - arm - 1);
      ctx.lineTo(css.x, css.y + arm + 1);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 1.75 : 1.25;
      ctx.beginPath();
      ctx.moveTo(css.x - arm, css.y);
      ctx.lineTo(css.x + arm, css.y);
      ctx.moveTo(css.x, css.y - arm);
      ctx.lineTo(css.x, css.y + arm);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(css.x, css.y, 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = "bold 11px ui-monospace, monospace";
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(control.name || "CP", css.x + arm + 3, css.y + 3);
    }
  }, [image, view, size, loading, hasProject, alignment, selectedId, readyStationIds, controlPoints, selectedControlId]);

  const fit = () => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    setUserView(null);
  };

  const imagePoint = (css: { x: number; y: number }): PlanPoint | null => {
    const current = viewRef.current;
    if (!current) return null;
    return cssToImage(css, current);
  };

  const commitPrompt = () => {
    if (!prompt) return;
    const message = onCommitMarker({ id: prompt.id, label: prompt.label, distancePx: prompt.distancePx });
    if (message) {
      setPromptError(message);
      return;
    }
    setPrompt(null);
    setPromptError(null);
    setMovingId(null);
  };

  const chooseTool = (next: PlanTool) => {
    setTool(next);
    onToolChange?.(next);
  };

  const placeChainage = () => {
    const stationFt = parseStation(chainage);
    if (!Number.isFinite(stationFt)) {
      setChainageError("Enter a station such as 116+00.");
      return;
    }
    const existing = alignment.markers.find((marker) => Math.abs(marker.stationFt - stationFt) < 1e-6);
    if (existing) {
      setSelectedId(existing.id);
      setChainage("");
      setChainageError(null);
      return;
    }
    const placed = chainageDistance(alignment.markers, stationFt);
    if ("error" in placed) {
      setChainageError(placed.error);
      return;
    }
    const message = onCommitMarker({ label: chainage.trim(), distancePx: placed.distancePx });
    if (message) {
      setChainageError(message);
      return;
    }
    setChainage("");
    setChainageError(null);
    setSelectStationFt(stationFt);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.06] px-2 py-1">
        <button
          type="button"
          disabled={!hasProject}
          onClick={() => fileRef.current?.click()}
          className="rounded bg-white/10 px-2 py-1 text-[11px] disabled:opacity-40"
        >
          Upload plan
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp,application/pdf,.pdf"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onLoadFile(file);
          }}
        />
        <button type="button" onClick={fit} disabled={!raster} className="rounded bg-white/10 px-2 py-1 text-[11px] disabled:opacity-40">
          Fit
        </button>
        <ToolButton active={tool === "inspect"} onClick={() => chooseTool("inspect")}>
          Inspect
        </ToolButton>
        <ToolButton active={tool === "trace"} disabled={!raster || traced} onClick={() => chooseTool("trace")}>
          Trace
        </ToolButton>
        <ToolButton active={tool === "station"} disabled={!traced} onClick={() => chooseTool("station")}>
          Station
        </ToolButton>
        {onAddControl && (
          <ToolButton active={tool === "control"} disabled={!raster} onClick={() => chooseTool("control")}>
            Control pts
          </ToolButton>
        )}
        <button
          type="button"
          disabled={alignment.draft.length === 0}
          onClick={() => onAlignment({ ...alignment, draft: alignment.draft.slice(0, -1) })}
          className="rounded bg-white/10 px-2 py-1 text-[11px] disabled:opacity-40"
        >
          Undo
        </button>
        <button
          type="button"
          disabled={alignment.draft.length === 0}
          onClick={() => onAlignment({ ...alignment, draft: [] })}
          className="rounded bg-white/10 px-2 py-1 text-[11px] disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={alignment.draft.length < 2 || traced || !raster}
          onClick={() =>
            onAlignment({
              ...alignment,
              points: alignment.draft,
              draft: [],
              rasterWidth: raster?.width ?? alignment.rasterWidth,
              rasterHeight: raster?.height ?? alignment.rasterHeight,
            })
          }
          className="rounded bg-white/10 px-2 py-1 text-[11px] disabled:opacity-40"
        >
          Finish
        </button>
        {traced && !confirmReplace && (
          <button type="button" onClick={() => setConfirmReplace(true)} className="rounded bg-white/10 px-2 py-1 text-[11px]">
            Replace
          </button>
        )}
        {confirmReplace && (
          <>
            <span className="text-[11px] text-amber-200">Clear the mainline and its markers?</span>
            <button
              type="button"
              onClick={() => {
                onAlignment({ ...alignment, points: [], draft: [], markers: [], rasterWidth: null, rasterHeight: null });
                setConfirmReplace(false);
                setSelectedId(null);
                setMovingId(null);
                setTool("trace");
              }}
              className="rounded bg-white/10 px-2 py-1 text-[11px] text-cut"
            >
              Confirm replace
            </button>
            <button type="button" onClick={() => setConfirmReplace(false)} className="rounded bg-white/10 px-2 py-1 text-[11px]">
              Keep
            </button>
          </>
        )}
        <span className="truncate text-[11px] text-muted" title={fileName ?? undefined}>
          {fileName ?? "No plan loaded"}
        </span>
      </div>
      {(stationing || rasterMismatch || warnings.length > 0) && (
        <div className="space-y-0.5 border-b border-white/[0.06] px-2 py-1 text-[11px] text-amber-200">
          {stationing && <div>{stationing}</div>}
          {rasterMismatch && <div>The plan raster changed. The trace may not sit on the sheet.</div>}
          {warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      )}
      {error && <div className="truncate px-2 py-0.5 text-[11px] text-amber-200">{error}</div>}
      <div className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          className={cn("h-full w-full touch-none", grabbing ? "cursor-grabbing" : tool === "inspect" ? "cursor-grab" : "cursor-crosshair")}
          onPointerDown={(event) => {
            if (!viewRef.current || event.button > 2) return;
            const css = clientToCanvasCss(event.clientX, event.clientY, canvasBox(event.currentTarget));
            const panning = event.button === 1 || event.button === 2 || event.altKey || event.shiftKey || tool === "inspect";
            dragRef.current = { x: css.x, y: css.y, moved: false, panning };
            if (panning) setGrabbing(true);
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // Capture keeps the pan alive if the pointer leaves the canvas.
            }
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            const current = viewRef.current;
            if (!drag || !current) return;
            const css = clientToCanvasCss(event.clientX, event.clientY, canvasBox(event.currentTarget));
            const dx = css.x - drag.x;
            const dy = css.y - drag.y;
            if (Math.hypot(dx, dy) > 4) drag.moved = true;
            if (!drag.panning && !drag.moved) return;
            drag.panning = true;
            drag.x = css.x;
            drag.y = css.y;
            setGrabbing(true);
            setUserView(pan(current, dx, dy));
          }}
          onPointerUp={(event) => {
            const drag = dragRef.current;
            dragRef.current = null;
            setGrabbing(false);
            if (!drag || drag.moved || drag.panning || tool === "inspect") return;
            const css = clientToCanvasCss(event.clientX, event.clientY, canvasBox(event.currentTarget));
            const point = imagePoint(css);
            if (!point) return;
            if (tool === "trace") {
              onAlignment({ ...alignment, draft: [...alignment.draft, point] });
              return;
            }
            if (tool === "control") {
              const reach = 12 / Math.max(viewRef.current?.scale ?? 1, 1e-6);
              const near = controlPoints.find((control) => Math.hypot(control.px - point.x, control.py - point.y) <= reach);
              if (pickingControlId) onMoveControl?.(pickingControlId, point.x, point.y);
              else if (near) onSelectControl?.(near.id);
              else onAddControl?.(point.x, point.y);
              return;
            }
            const hit = hitMarker(alignment, point, 14 / Math.max(viewRef.current?.scale ?? 1, 1e-6));
            if (movingId) {
              const snap = snapToPolyline(alignment.points, point.x, point.y);
              if (!snap) return;
              onAlignment({
                ...alignment,
                markers: alignment.markers.map((marker) =>
                  marker.id === movingId ? { ...marker, distancePx: snap.distancePx } : marker,
                ),
              });
              setMovingId(null);
              return;
            }
            if (hit) {
              setSelectedId(hit.id);
              return;
            }
            const snap = snapToPolyline(alignment.points, point.x, point.y);
            if (!snap) return;
            setPrompt({ distancePx: snap.distancePx, label: "" });
            setPromptError(null);
          }}
          onPointerCancel={() => {
            dragRef.current = null;
            setGrabbing(false);
          }}
        />
        {prompt && (
          <form
            className="absolute left-2 top-2 z-10 w-56 rounded-md border border-white/10 bg-[#101214]/95 p-2 shadow-lg"
            onSubmit={(event) => {
              event.preventDefault();
              commitPrompt();
            }}
          >
            <div className="text-[11px] text-muted">{prompt.id ? "Edit station" : "Station on the mainline"}</div>
            <input
              autoFocus
              value={prompt.label}
              onChange={(event) => setPrompt({ ...prompt, label: event.target.value })}
              placeholder="110+00"
              className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1 text-[13px] outline-none focus:border-accent"
            />
            {promptError && <div className="mt-1 text-[11px] text-amber-200">{promptError}</div>}
            <div className="mt-2 flex gap-1.5">
              <button type="submit" className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-black">
                Save
              </button>
              <button type="button" onClick={() => setPrompt(null)} className="rounded bg-white/10 px-2 py-1 text-[11px]">
                Cancel
              </button>
            </div>
          </form>
        )}
        {selectedId && tool === "station" && !prompt && (
          <div className="absolute bottom-2 left-2 z-10 flex gap-1.5 rounded-md border border-white/10 bg-[#101214]/95 px-2 py-1.5">
            <button
              type="button"
              className="rounded bg-white/10 px-2 py-1 text-[11px]"
              onClick={() => {
                const marker = alignment.markers.find((item) => item.id === selectedId);
                if (!marker) return;
                setPrompt({ id: marker.id, label: marker.label, distancePx: marker.distancePx });
                setPromptError(null);
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className={cn("rounded px-2 py-1 text-[11px]", movingId === selectedId ? "bg-accent text-black" : "bg-white/10")}
              onClick={() => setMovingId((current) => (current === selectedId ? null : selectedId))}
            >
              {movingId === selectedId ? "Click the line" : "Move"}
            </button>
            <button
              type="button"
              className="rounded bg-white/10 px-2 py-1 text-[11px]"
              onClick={() => {
                const marker = alignment.markers.find((item) => item.id === selectedId);
                if (marker) onOpenSection(marker);
              }}
            >
              Open cross-section
            </button>
            <button
              type="button"
              className="rounded bg-white/10 px-2 py-1 text-[11px] text-cut"
              onClick={() => {
                onAlignment({ ...alignment, markers: alignment.markers.filter((marker) => marker.id !== selectedId) });
                setSelectedId(null);
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      {tool === "station" && (
        <form
          className="flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] px-2 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            placeChainage();
          }}
        >
          <label className="text-[11px] text-muted" htmlFor="chainage-station">
            Locate station
          </label>
          <input
            id="chainage-station"
            value={chainage}
            onChange={(event) => setChainage(event.target.value)}
            placeholder="116+00"
            disabled={alignment.markers.length < 2}
            className="w-24 rounded border border-white/10 bg-transparent px-2 py-1 text-[12px] outline-none focus:border-accent disabled:opacity-40"
          />
          <button
            type="submit"
            disabled={alignment.markers.length < 2}
            className="rounded bg-white/10 px-2 py-1 text-[11px] disabled:opacity-40"
          >
            Locate
          </button>
          {chainageError && <span className="text-[11px] text-amber-200">{chainageError}</span>}
          {referenceScale(alignment.markers) == null && traced && (
            <span className="text-[11px] text-muted">Two markers establish the scale.</span>
          )}
        </form>
      )}
    </div>
  );
}

function ToolButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn("rounded px-2 py-1 text-[11px] disabled:opacity-40", active ? "bg-accent text-black" : "bg-white/10")}
    >
      {children}
    </button>
  );
}

function strokePlan(
  ctx: CanvasRenderingContext2D,
  points: PlanPoint[],
  view: ViewState,
  color: string,
  dashed: boolean,
) {
  if (points.length === 0) return;
  ctx.beginPath();
  points.forEach((point, index) => {
    const css = imageToCss(point, view);
    if (index === 0) ctx.moveTo(css.x, css.y);
    else ctx.lineTo(css.x, css.y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(dashed ? [5, 4] : []);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const point of points) {
    const css = imageToCss(point, view);
    ctx.beginPath();
    ctx.arc(css.x, css.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

function hitMarker(alignment: PlanAlignment, point: PlanPoint, tolerance: number): AlignmentMarker | null {
  let best: AlignmentMarker | null = null;
  let bestGap = tolerance;
  for (const marker of alignment.markers) {
    const at = pointOnPolyline(alignment.points, marker.distancePx);
    if (!at) continue;
    const gap = Math.hypot(at.point.x - point.x, at.point.y - point.y);
    if (gap <= bestGap) {
      best = marker;
      bestGap = gap;
    }
  }
  return best;
}
