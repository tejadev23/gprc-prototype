/**
 * Coordinate contract for the tracing lab.
 *
 * This experiment does NOT use PDF / Konva scene / native-export space
 * (see docs/coordinate_system.md). Those apply to the exporter only.
 *
 * Tracing space is image pixels of the loaded raster:
 *   origin top-left, +x right, +y down, units = naturalWidth/Height pixels.
 *
 *   pointer CSS pixels
 *       -- cssToImage(view) -->
 *   image pixels   ← engine, TraceStep, polyline
 *       -- imageToCss(view) -->
 *   overlay drawing
 */
import type { Vec2, ViewState } from "./types";

export function fitView(
  canvasW: number,
  canvasH: number,
  imageW: number,
  imageH: number,
  padding = 8,
): ViewState {
  const availW = Math.max(1, canvasW - padding * 2);
  const availH = Math.max(1, canvasH - padding * 2);
  const scale = Math.min(availW / imageW, availH / imageH);
  return {
    scale,
    originX: (canvasW - imageW * scale) / 2,
    originY: (canvasH - imageH * scale) / 2,
  };
}

export function imageToCss(p: Vec2, view: ViewState): Vec2 {
  return {
    x: view.originX + p.x * view.scale,
    y: view.originY + p.y * view.scale,
  };
}

export function cssToImage(p: Vec2, view: ViewState): Vec2 {
  return {
    x: (p.x - view.originX) / view.scale,
    y: (p.y - view.originY) / view.scale,
  };
}

export function eventToCss(
  e: { clientX: number; clientY: number; nativeEvent?: { offsetX: number; offsetY: number; target: EventTarget | null } },
  canvas: HTMLCanvasElement,
): Vec2 {
  const ne = e.nativeEvent;
  if (ne && ne.target === canvas && Number.isFinite(ne.offsetX) && Number.isFinite(ne.offsetY)) {
    return { x: ne.offsetX, y: ne.offsetY };
  }
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.clientWidth / Math.max(rect.width, 1e-6);
  const sy = canvas.clientHeight / Math.max(rect.height, 1e-6);
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

export function eventToImage(
  e: { clientX: number; clientY: number },
  canvas: HTMLCanvasElement,
  view: ViewState,
): Vec2 {
  return cssToImage(eventToCss(e, canvas), view);
}

export function zoomAt(
  view: ViewState,
  cssPoint: Vec2,
  factor: number,
  minScale: number,
  maxScale: number,
): ViewState {
  const img = cssToImage(cssPoint, view);
  const scale = Math.min(maxScale, Math.max(minScale, view.scale * factor));
  return {
    scale,
    originX: cssPoint.x - img.x * scale,
    originY: cssPoint.y - img.y * scale,
  };
}

export function pan(view: ViewState, dCssX: number, dCssY: number): ViewState {
  return {
    ...view,
    originX: view.originX + dCssX,
    originY: view.originY + dCssY,
  };
}
