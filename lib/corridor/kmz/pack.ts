import { strToU8, zipSync } from "fflate";

/** A KMZ is a zip with doc.kml at its root. Extra files (the plan image) sit under files/. */
export function packKmz(kml: string, files: Record<string, Uint8Array> = {}): Uint8Array {
  // Object key order is the archive order, so doc.kml comes first.
  return zipSync({ "doc.kml": strToU8(kml), ...files }, { level: 6 });
}
