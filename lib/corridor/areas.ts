import { elevationAt, sortByOffset } from "./profile";
import type { ProfilePoint, SectionAreas } from "./types";

type Ends = { existing: ProfilePoint[]; proposed: ProfilePoint[] };

/**
 * Cross-section areas in square feet.
 * Cut = proposed below existing. Fill = proposed above existing.
 * Integration covers the proposed offset range and splits at centerline and at sign changes.
 */
export function computeAreas(station: Ends | null | undefined): SectionAreas | null {
  if (!station) return null;
  const ex = sortByOffset(station.existing);
  const pr = sortByOffset(station.proposed);
  if (ex.length < 2 || pr.length < 2) return null;

  const xL = pr[0].offset;
  const xR = pr[pr.length - 1].offset;
  if (xR - xL < 1e-9) return null;

  const xs = new Set<number>();
  for (const p of ex) {
    if (p.offset >= xL && p.offset <= xR) xs.add(p.offset);
  }
  for (const p of pr) xs.add(p.offset);
  xs.add(xL);
  xs.add(xR);
  xs.add(0);
  const xsSorted = [...xs].filter((x) => x >= xL && x <= xR).sort((a, b) => a - b);

  let cut = 0;
  let fill = 0;
  let cutL = 0;
  let cutR = 0;
  let fillL = 0;
  let fillR = 0;

  for (let i = 0; i < xsSorted.length - 1; i++) {
    const x1 = xsSorted[i];
    const x2 = xsSorted[i + 1];
    if (x2 - x1 < 1e-9) continue;

    const segs: [number, number][] = x1 < 0 && x2 > 0 ? [[x1, 0], [0, x2]] : [[x1, x2]];
    for (const [a, b] of segs) {
      const dhA = elevationAt(ex, a) - elevationAt(pr, a);
      const dhB = elevationAt(ex, b) - elevationAt(pr, b);
      const pieces: [number, number, number, number][] =
        dhA * dhB < 0
          ? (() => {
              const tc = dhA / (dhA - dhB);
              const xc = a + tc * (b - a);
              return [
                [a, xc, dhA, 0],
                [xc, b, 0, dhB],
              ];
            })()
          : [[a, b, dhA, dhB]];

      for (const [pa, pb, ha, hb] of pieces) {
        const area = ((ha + hb) * 0.5) * (pb - pa);
        const left = (pa + pb) * 0.5 < 0;
        if (area > 0) {
          cut += area;
          if (left) cutL += area;
          else cutR += area;
        } else {
          fill += -area;
          if (left) fillL += -area;
          else fillR += -area;
        }
      }
    }
  }

  return { cut, fill, cutL, cutR, fillL, fillR };
}
