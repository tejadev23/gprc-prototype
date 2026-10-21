import type { NextConfig } from "next";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Serve the pdf.js worker from /labs without committing the 1.2MB file. */
function copyPdfWorker() {
  const src = join(process.cwd(), "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
  const dest = join(process.cwd(), "public/pdf.worker.min.mjs");
  if (!existsSync(src)) return;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}
copyPdfWorker();

const nextConfig: NextConfig = {
  transpilePackages: ["pdfjs-dist", "three"],
};

export default nextConfig;
