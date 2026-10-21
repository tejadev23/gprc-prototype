"use client";

import { useEffect, useRef, useState } from "react";
import { CalibrationPanel } from "@/components/labs/corridor/CalibrationPanel";
import { computeAreas } from "@/lib/corridor/areas";
import { hitCalibrationGroup, pxToReal, realToPx, translateGroup, type CalibrationMove } from "@/lib/corridor/calibration";
import { marksMatchRenderedPage } from "@/lib/corridor/page-ref";
import { displayProfile } from "@/lib/corridor/profile";
import { isCalibrated } from "@/lib/corridor/stations";
import type { CalibPoint, ProfilePoint, Station, TraceMode } from "@/lib/corridor/types";
import { canvasBox, clientToCanvasCss } from "@/lib/corridor/viewer";
import { cssToImage, fitView, pan, zoomAt } from "@/lib/tracing/coords";
import type { ViewState } from "@/lib/tracing/types";
import { cn } from "@/lib/utils";

type Raster = { url: string; width: number; height: number; page: number };

type Props = {
  raster: Raster | null;
  loading: boolean;
  pdfName: string | null;
  pageNumber: number;
  numPages: number;
  error: string | null;
  station: Station | null;
  mode: TraceMode;
  pickIdx: number | null;
  snap: boolean;
  onLoadFile: (file: File) => void;
  onPage: (page: number) => void;
  onMode: (mode: TraceMode) => void;
  onSnap: (snap: boolean) => void;
  onPick: (px: number, py: number) => void;
  onUndo: () => void;
  onChangePoint: (index: number, patch: Partial<CalibPoint>) => void;
  onRepick: (index: number) => void;
  onClearPoint: (index: number) => void;
  onReset: () => void;
  move: CalibrationMove | null;
  canReuse: boolean;
  onStartMove: () => void;
  onMoveDelta: (dx: number, dy: number) => void;
  onConfirmMove: () => void;
  onCancelMove: () => void;
  /** The page on screen is not the page this station was marked on. */
  pageMismatch?: { stationName: string; stationPage: number; viewPage: number } | null;
  onGoToStationPage?: () => void;
};

export function CrossSectionPanel({
  raster,
  loading,
  pdfName,
  pageNumber,
  numPages,
  error,
  station,
  mode,
  pickIdx,
  snap,
  onLoadFile,
  onPage,
  onMode,
  onSnap,
  onPick,
  onUndo,
  onChangePoint,
  onRepick,
  onClearPoint,
  onReset,
  move,
  canReuse,
  onStartMove,
  onMoveDelta,
  onConfirmMove,
  onCancelMove,
  pageMismatch = null,
  onGoToStationPage,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<ViewState | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const userView = useRef(false);
  const dragRef = useRef<{ x: number; y: number; panning: boolean; moved: boolean } | null>(null);
  const groupDragRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  /** Page number of `image`. Null while the next page is loading, so the previous image is not reused. */
  const [imagePage, setImagePage] = useState<number | null>(null);
  const [view, setView] = useState<ViewState | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);

  viewRef.current = view;
  imageRef.current = image;

  useEffect(() => {
    userView.current = false;
    setView(null);
    setCursor(null);
    if (!raster) {
      setImage(null);
      setImagePage(null);
      return;
    }
    const page = raster.page;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      setImage(img);
      setImagePage(page);
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
    setSize({ w: canvas.clientWidth, h: canvas.clientHeight });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!image || userView.current || size.w < 8 || size.h < 8) return;
    setView(fitView(size.w, size.h, image.naturalWidth, image.naturalHeight));
  }, [image, size]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      const current = viewRef.current;
      const img = imageRef.current;
      if (!current || !img) return;
      event.preventDefault();
      userView.current = true;
      const css = clientToCanvasCss(event.clientX, event.clientY, canvasBox(canvas));
      const min = fitView(canvas.clientWidth, canvas.clientHeight, img.naturalWidth, img.naturalHeight).scale * 0.5;
      setView(zoomAt(current, css, event.deltaY > 0 ? 0.9 : 1.1, min, 16));
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

    // The image must be the page this raster was rendered for. A stale image from the previous page is not drawn.
    const imageIsThisPage = raster != null && image != null && view != null && imagePage === raster.page;
    if (!imageIsThisPage || !image || !view) {
      ctx.fillStyle = "#8a8f98";
      ctx.font = "13px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(loading || raster ? "Rendering page…" : "Load a cross-section PDF", cssW / 2, cssH / 2);
      return;
    }

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, view.originX, view.originY, image.naturalWidth * view.scale, image.naturalHeight * view.scale);
    const showMarks = marksMatchRenderedPage(station?.pageNumber ?? null, raster.page);
    if (!showMarks) return;
    const toCss = (px: number, py: number) => ({
      x: view.originX + px * view.scale,
      y: view.originY + py * view.scale,
    });
    const transform = station?.calibration.transform;
    const movingGroup = move != null && station != null && move.stationId === station.id;
    const groupPoints = movingGroup ? translateGroup(move.origin, move.dx, move.dy) : station?.calibration.points;
    if (transform && station) {
      const activeExisting = mode === "existing" ? station.existing[station.existing.length - 1] : undefined;
      const activeProposed = mode === "proposed" ? station.proposed[station.proposed.length - 1] : undefined;
      strokeProfile(ctx, displayProfile(station.existing), "#7dd3fc", true, transform, toCss, activeExisting);
      strokeProfile(ctx, displayProfile(station.proposed), "#fbbf24", false, transform, toCss, activeProposed);
    }
    if (groupPoints) drawCalibrationGroup(ctx, groupPoints, toCss, movingGroup, mode === "calibrate" && !movingGroup ? pickIdx : null);
  }, [raster, image, imagePage, view, station, mode, pickIdx, loading, size, move]);

  const calibrated = isCalibrated(station);
  const moving = move != null && station != null && move.stationId === station.id;
  const areas = computeAreas(station);
  const canUndo = (mode === "existing" && (station?.existing.length ?? 0) > 0) || (mode === "proposed" && (station?.proposed.length ?? 0) > 0);
  let readout = "—";
  if (cursor && station?.calibration.transform) {
    let { offset, elevation } = pxToReal(station.calibration.transform, cursor.x, cursor.y);
    if (snap) {
      offset = Math.round(offset);
      elevation = Math.round(elevation);
    }
    readout = `${offset.toFixed(2)}  ${elevation.toFixed(2)}`;
  }

  const fit = () => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    userView.current = false;
    setView(fitView(canvas.clientWidth, canvas.clientHeight, img.naturalWidth, img.naturalHeight));
  };

  const pointerCss = (event: { clientX: number; clientY: number }, canvas: HTMLCanvasElement) =>
    clientToCanvasCss(event.clientX, event.clientY, canvasBox(canvas));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.06] px-2 py-1">
        <button type="button" onClick={() => fileRef.current?.click()} className="rounded bg-white/10 px-2 py-1 text-[11px]">
          PDF
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onLoadFile(file);
          }}
        />
        <div className="flex items-center gap-1 text-[11px]">
          <button type="button" disabled={!pdfName || pageNumber <= 1} onClick={() => onPage(pageNumber - 1)} className="rounded bg-white/10 px-1.5 py-1 disabled:opacity-40">
            ‹
          </button>
          <span className="font-mono text-muted" title={pdfName ?? undefined}>
            {pdfName ? `${pageNumber}/${numPages}` : "—"}
          </span>
          <button type="button" disabled={!pdfName || pageNumber >= numPages} onClick={() => onPage(pageNumber + 1)} className="rounded bg-white/10 px-1.5 py-1 disabled:opacity-40">
            ›
          </button>
        </div>
        <button type="button" onClick={fit} className="rounded bg-white/10 px-2 py-1 text-[11px]">
          Fit
        </button>
        <ModeButton active={mode === "existing"} disabled={!calibrated} onClick={() => onMode("existing")}>
          Existing
        </ModeButton>
        <ModeButton active={mode === "proposed"} disabled={!calibrated} onClick={() => onMode("proposed")}>
          Proposed
        </ModeButton>
        <button type="button" disabled={!canUndo} onClick={onUndo} className="rounded bg-white/10 px-2 py-1 text-[11px] disabled:opacity-40">
          Undo
        </button>
        <label className="flex items-center gap-1 px-1 text-[11px] text-muted" title="Move the point to the nearest whole foot">
          <input type="checkbox" checked={snap} onChange={(event) => onSnap(event.target.checked)} />
          Snap
        </label>
        <span className={cn("text-[11px]", calibrated ? "text-fill" : "text-muted")}>
          {calibrated ? "Calibration ✓" : "Calibration ○"}
        </span>
        <button type="button" disabled={!station} onClick={() => onMode("calibrate")} className="rounded bg-white/10 px-2 py-1 text-[11px] disabled:opacity-40">
          Recalibrate
        </button>
        <button
          type="button"
          disabled={!canReuse}
          onClick={onStartMove}
          title={canReuse ? "Drag a finished calibration triangle onto this cross-section" : "Calibrate a station on this page first"}
          className={cn("rounded px-2 py-1 text-[11px] disabled:opacity-40", moving ? "bg-accent text-black" : "bg-white/10")}
        >
          Reuse
        </button>
        <span className="ml-auto font-mono text-[11px] text-cut">Cut {areas ? areas.cut.toFixed(1) : "—"}</span>
        <span className="font-mono text-[11px] text-fill">Fill {areas ? areas.fill.toFixed(1) : "—"}</span>
        <span className="font-mono text-[11px] text-muted">{cursor ? readout : station?.name ?? ""}</span>
      </div>
      {error && <div className="truncate px-2 py-0.5 text-[11px] text-amber-200">{error}</div>}
      {pageMismatch && (
        <div className="flex flex-wrap items-center gap-2 px-2 py-0.5 text-[11px] text-amber-200" data-page-mismatch="">
          <span>
            {pageMismatch.stationName} is marked on page {pageMismatch.stationPage}. This is page {pageMismatch.viewPage}.
          </span>
          {onGoToStationPage && (
            <button type="button" onClick={onGoToStationPage} className="rounded bg-white/10 px-1.5 py-0.5 text-foreground">
              Go to page {pageMismatch.stationPage}
            </button>
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          className={cn("h-full w-full touch-none", moving && (grabbing ? "cursor-grabbing" : "cursor-grab"))}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            const box = canvasBox(event.currentTarget);
            const css = clientToCanvasCss(event.clientX, event.clientY, box);
            const current = viewRef.current;
            const panning = event.button === 1 || event.button === 2 || event.altKey || event.shiftKey;
            if (!panning && moving && move && current) {
              const img = cssToImage(css, current);
              const preview = translateGroup(move.origin, move.dx, move.dy);
              if (hitCalibrationGroup(img.x, img.y, preview, 18 / current.scale)) {
                groupDragRef.current = { x: img.x, y: img.y, dx: move.dx, dy: move.dy };
                setGrabbing(true);
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  // Capture keeps the drag alive if the pointer leaves the canvas.
                }
                return;
              }
            }
            dragRef.current = {
              x: css.x,
              y: css.y,
              panning,
              moved: false,
            };
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // Capture is only a convenience for panning.
            }
          }}
          onPointerMove={(event) => {
            const current = viewRef.current;
            const css = pointerCss(event, event.currentTarget);
            if (current) setCursor(cssToImage(css, current));
            const groupDrag = groupDragRef.current;
            if (groupDrag && current) {
              const img = cssToImage(css, current);
              onMoveDelta(groupDrag.dx + (img.x - groupDrag.x), groupDrag.dy + (img.y - groupDrag.y));
              return;
            }
            const drag = dragRef.current;
            if (!drag?.panning || !current) return;
            const dx = css.x - drag.x;
            const dy = css.y - drag.y;
            if (Math.hypot(dx, dy) > 2) drag.moved = true;
            drag.x = css.x;
            drag.y = css.y;
            userView.current = true;
            setView(pan(current, dx, dy));
          }}
          onPointerUp={(event) => {
            if (groupDragRef.current) {
              groupDragRef.current = null;
              setGrabbing(false);
              return;
            }
            const drag = dragRef.current;
            dragRef.current = null;
            if (!drag || drag.panning || drag.moved || moving) return;
            const css = pointerCss(event, event.currentTarget);
            if (Math.hypot(css.x - drag.x, css.y - drag.y) > 4) return;
            const current = viewRef.current;
            if (!current) return;
            const img = cssToImage(css, current);
            onPick(img.x, img.y);
          }}
          onPointerLeave={() => setCursor(null)}
        />
        {moving && (
          <div className="absolute left-2 top-2 z-10 max-w-sm rounded-md border border-[#7f1d1d]/60 bg-[#101214]/95 px-3 py-2 shadow-lg">
            <div className="text-[11px] font-medium tracking-wide text-[#fecaca]">Move calibration</div>
            <p className="mt-0.5 text-[11px] leading-snug text-muted">
              Drag the triangle onto this station’s cross-section. Offset and elevation stay the same.
            </p>
            <div className="mt-2 flex gap-1.5">
              <button type="button" onClick={onConfirmMove} className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-black">
                Confirm
              </button>
              <button type="button" onClick={onCancelMove} className="rounded bg-white/10 px-2 py-1 text-[11px]">
                Cancel
              </button>
            </div>
          </div>
        )}
        {mode === "calibrate" && !moving && (
          <div className="absolute inset-x-2 bottom-2 z-10 max-h-[46%] overflow-auto rounded-md border border-white/10 bg-[#101214]/95 shadow-lg">
            <CalibrationPanel
              station={station}
              mode={mode}
              pickIdx={pickIdx}
              onChangePoint={onChangePoint}
              onRepick={onRepick}
              onClearPoint={onClearPoint}
              onReset={onReset}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function drawCalibrationGroup(
  ctx: CanvasRenderingContext2D,
  points: Station["calibration"]["points"],
  toCss: (px: number, py: number) => { x: number; y: number },
  moving: boolean,
  pickIdx: number | null,
) {
  const placed = points.flatMap((point, index) =>
    point.px == null || point.py == null ? [] : [{ index, css: toCss(point.px, point.py) }],
  );
  if (placed.length === 3) {
    ctx.beginPath();
    ctx.moveTo(placed[0].css.x, placed[0].css.y);
    ctx.lineTo(placed[1].css.x, placed[1].css.y);
    ctx.lineTo(placed[2].css.x, placed[2].css.y);
    ctx.closePath();
    if (moving) {
      ctx.fillStyle = "rgba(127, 29, 29, 0.16)";
      ctx.fill();
    }
    ctx.strokeStyle = "#7f1d1d";
    ctx.lineWidth = moving ? 2 : 1.25;
    ctx.setLineDash(moving ? [] : [4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const point of placed) {
    const hot = moving || pickIdx === point.index;
    ctx.beginPath();
    ctx.arc(point.css.x, point.css.y, hot ? 7 : 5, 0, Math.PI * 2);
    ctx.strokeStyle = "#fff7ed";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "#7f1d1d";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#7f1d1d";
    ctx.beginPath();
    ctx.arc(point.css.x, point.css.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "bold 11px ui-monospace, monospace";
    ctx.fillStyle = "#7f1d1d";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(`P${point.index + 1}`, point.css.x + 10, point.css.y - 8);
  }
}

function ModeButton({
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

function strokeProfile(
  ctx: CanvasRenderingContext2D,
  points: ProfilePoint[],
  color: string,
  dashed: boolean,
  transform: NonNullable<Station["calibration"]["transform"]>,
  toCss: (px: number, py: number) => { x: number; y: number },
  active?: ProfilePoint,
) {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  points.forEach((point, index) => {
    const raw = realToPx(transform, point.offset, point.elevation);
    const css = toCss(raw.px, raw.py);
    if (index === 0) ctx.moveTo(css.x, css.y);
    else ctx.lineTo(css.x, css.y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(dashed ? [5, 3] : []);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const point of points) {
    const raw = realToPx(transform, point.offset, point.elevation);
    const css = toCss(raw.px, raw.py);
    const hot = point === active;
    ctx.beginPath();
    ctx.arc(css.x, css.y, hot ? 4 : 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    if (hot) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
  }
}
