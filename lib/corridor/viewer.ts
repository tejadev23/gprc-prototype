/**
 * Pointer position in the same CSS-pixel space the cross-section canvas draws in.
 *
 * The canvas backing store is clientWidth × devicePixelRatio. On that canvas,
 * offsetX/offsetY are reported in backing-store pixels, not CSS pixels. Using
 * them shifts every plotted point by the device-pixel ratio, and the error
 * grows as the view is zoomed, panned, or resized. Client coordinates mapped
 * through the element's border box stay in the drawing space.
 */
export type CanvasBox = {
  left: number;
  top: number;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
};

export function canvasBox(canvas: HTMLCanvasElement): CanvasBox {
  const rect = canvas.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    clientWidth: canvas.clientWidth,
    clientHeight: canvas.clientHeight,
  };
}

export function clientToCanvasCss(clientX: number, clientY: number, box: CanvasBox): { x: number; y: number } {
  const sx = box.clientWidth / Math.max(box.width, 1e-6);
  const sy = box.clientHeight / Math.max(box.height, 1e-6);
  return {
    x: (clientX - box.left) * sx,
    y: (clientY - box.top) * sy,
  };
}
