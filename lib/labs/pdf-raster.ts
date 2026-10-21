/**
 * Client-side PDF → raster. Used only by the lab import workflow.
 * Renders one page at a time; no vector/CAD extraction.
 *
 * pdf.js is loaded only in the browser (dynamic import) so Next SSR
 * does not pull the Node-incompatible main build.
 */
import { IMPORT_RASTER_MAX_SIDE } from "./import-types";
import type { PDFDocumentProxy } from "pdfjs-dist";

let workerReady = false;

async function pdfjs() {
  const mod = await import("pdfjs-dist");
  if (!workerReady && typeof window !== "undefined") {
    mod.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    workerReady = true;
  }
  return mod;
}

export async function openPdfDocument(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const { getDocument } = await pdfjs();
  const task = getDocument({
    data: new Uint8Array(data),
    disableRange: true,
    disableStream: true,
  });
  return task.promise;
}

export async function renderPdfPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  maxSide = IMPORT_RASTER_MAX_SIDE,
): Promise<{ objectUrl: string; width: number; height: number }> {
  await pdfjs();
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(maxSide / Math.max(base.width, base.height), 4);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2d context unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const objectUrl = await canvasToObjectUrl(canvas);
  return { objectUrl, width: canvas.width, height: canvas.height };
}

function canvasToObjectUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Failed to encode page raster"));
          return;
        }
        resolve(URL.createObjectURL(blob));
      },
      "image/png",
    );
  });
}
