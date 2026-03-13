/**
 * Wire merging — collinear adjacent wire segment fusion.
 *
 * After wire drawing, adjacent wires on the same horizontal or vertical line
 * are merged into a single wire spanning both. This reduces redundant segments
 * in the circuit model.
 */

import { Wire } from "@/core/circuit";

/**
 * Merge collinear adjacent wires into single wires.
 *
 * Two wires are collinear and adjacent when:
 *   - Both are horizontal (same y) and one endpoint of each matches, AND
 *     together they span a contiguous range.
 *   - Both are vertical (same x) and one endpoint of each matches, AND
 *     together they span a contiguous range.
 *
 * This is applied iteratively until no more merges can be made.
 */
export function mergeCollinearSegments(wires: Wire[]): Wire[] {
  if (wires.length <= 1) {
    return wires.slice();
  }

  let current = wires.slice();
  let merged = true;

  while (merged) {
    merged = false;
    const result: Wire[] = [];
    const used = new Set<number>();

    for (let i = 0; i < current.length; i++) {
      if (used.has(i)) {
        continue;
      }
      const a = current[i]!;
      let combined = false;

      for (let j = i + 1; j < current.length; j++) {
        if (used.has(j)) {
          continue;
        }
        const b = current[j]!;
        const mergedWire = tryMerge(a, b);
        if (mergedWire !== undefined) {
          result.push(mergedWire);
          used.add(i);
          used.add(j);
          merged = true;
          combined = true;
          break;
        }
      }

      if (!combined) {
        result.push(a);
        used.add(i);
      }
    }

    current = result;
  }

  return current;
}

/**
 * Attempt to merge two wires into one.
 *
 * Returns the merged wire if the two wires are collinear and adjacent
 * (share exactly one endpoint and lie on the same axis), or undefined
 * if they cannot be merged.
 */
function tryMerge(a: Wire, b: Wire): Wire | undefined {
  // Normalize so start <= end on the relevant axis
  const aH = a.start.y === a.end.y;
  const bH = b.start.y === b.end.y;
  const aV = a.start.x === a.end.x;
  const bV = b.start.x === b.end.x;

  if (aH && bH && a.start.y === b.start.y) {
    // Both horizontal, same y — check for adjacency
    return mergeOnAxis("x", a, b);
  }

  if (aV && bV && a.start.x === b.start.x) {
    // Both vertical, same x — check for adjacency
    return mergeOnAxis("y", a, b);
  }

  return undefined;
}

/**
 * Merge two wires that are collinear on the given axis.
 *
 * They are adjacent when the end of one equals the start of the other,
 * or they overlap with a shared endpoint. We merge into the spanning wire.
 */
function mergeOnAxis(axis: "x" | "y", a: Wire, b: Wire): Wire | undefined {
  // Extract the varying coordinate for each wire
  const aMin = Math.min(a.start[axis], a.end[axis]);
  const aMax = Math.max(a.start[axis], a.end[axis]);
  const bMin = Math.min(b.start[axis], b.end[axis]);
  const bMax = Math.max(b.start[axis], b.end[axis]);

  // They are adjacent or overlapping if their ranges touch or overlap
  if (aMax < bMin || bMax < aMin) {
    // Gap between them — not adjacent
    return undefined;
  }

  // Merge: span from min to max
  const mergedMin = Math.min(aMin, bMin);
  const mergedMax = Math.max(aMax, bMax);

  // Preserve bus width from either wire (take the wider one)
  const bitWidth = Math.max(a.bitWidth, b.bitWidth);

  if (axis === "x") {
    const y = a.start.y;
    return new Wire({ x: mergedMin, y }, { x: mergedMax, y }, bitWidth);
  } else {
    const x = a.start.x;
    return new Wire({ x, y: mergedMin }, { x, y: mergedMax }, bitWidth);
  }
}
