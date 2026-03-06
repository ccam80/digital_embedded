/**
 * Hit-testing — pure functions for determining what the user interacted with.
 *
 * Priority ordering: pin > element > wire > none.
 * All coordinates are in world (grid) space.
 */

import type { Point, Rect } from "@/core/renderer-interface";
import type { CircuitElement } from "@/core/element";
import type { Pin } from "@/core/pin";
import type { Wire } from "@/core/circuit";
import type { Circuit } from "@/core/circuit";

// ---------------------------------------------------------------------------
// HitResult discriminated union
// ---------------------------------------------------------------------------

export type HitResult =
  | { type: "pin"; element: CircuitElement; pin: Pin }
  | { type: "element"; element: CircuitElement }
  | { type: "wire"; wire: Wire }
  | { type: "none" };

// ---------------------------------------------------------------------------
// Public hit-test functions
// ---------------------------------------------------------------------------

/**
 * Returns the topmost element whose bounding box contains the point.
 * Front-to-back order: last element in the array is considered on top.
 */
export function hitTestElements(
  point: Point,
  elements: readonly CircuitElement[],
): CircuitElement | undefined {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]!;
    const bb = el.getBoundingBox();
    if (pointInRect(point, bb)) {
      return el;
    }
  }
  return undefined;
}

/**
 * Returns the first wire whose line segment is within threshold distance of point.
 * Iterates front-to-back (last wire is on top).
 */
export function hitTestWires(
  point: Point,
  wires: readonly Wire[],
  threshold: number,
): Wire | undefined {
  for (let i = wires.length - 1; i >= 0; i--) {
    const wire = wires[i]!;
    if (distancePointToSegment(point, wire.start, wire.end) <= threshold) {
      return wire;
    }
  }
  return undefined;
}

/**
 * Returns the first pin (across all elements) within threshold distance of point.
 * Pin positions are stored relative to the component origin — this function
 * checks them in world space (getPins() returns world-space positions per the
 * CircuitElement contract).
 */
export function hitTestPins(
  point: Point,
  elements: readonly CircuitElement[],
  threshold: number,
): { element: CircuitElement; pin: Pin } | undefined {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]!;
    for (const pin of el.getPins()) {
      // Pin positions are resolved at origin (0,0); offset by element world position
      const dx = point.x - (el.position.x + pin.position.x);
      const dy = point.y - (el.position.y + pin.position.y);
      if (Math.sqrt(dx * dx + dy * dy) <= threshold) {
        return { element: el, pin };
      }
    }
  }
  return undefined;
}

/**
 * Unified hit test with priority: pin > element > wire > none.
 */
export function hitTestAll(
  point: Point,
  circuit: Circuit,
  threshold: number,
): HitResult {
  const pinHit = hitTestPins(point, circuit.elements, threshold);
  if (pinHit !== undefined) {
    return { type: "pin", element: pinHit.element, pin: pinHit.pin };
  }

  const elementHit = hitTestElements(point, circuit.elements);
  if (elementHit !== undefined) {
    return { type: "element", element: elementHit };
  }

  const wireHit = hitTestWires(point, circuit.wires, threshold);
  if (wireHit !== undefined) {
    return { type: "wire", wire: wireHit };
  }

  return { type: "none" };
}

/**
 * Returns all elements whose bounding box intersects the given rectangle.
 */
export function elementsInRect(
  rect: Rect,
  elements: readonly CircuitElement[],
): CircuitElement[] {
  return elements.filter((el) => rectsIntersect(el.getBoundingBox(), rect));
}

/**
 * Returns all wires with at least one endpoint inside the given rectangle.
 */
export function wiresInRect(rect: Rect, wires: readonly Wire[]): Wire[] {
  return wires.filter(
    (wire) => pointInRect(wire.start, rect) || pointInRect(wire.end, rect),
  );
}

// ---------------------------------------------------------------------------
// Geometric helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Minimum distance from point P to line segment [A, B].
 *
 * When the perpendicular foot lies outside the segment, the distance is to
 * the nearest endpoint.
 */
export function distancePointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    // Degenerate segment — point distance to A
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }

  // Project P onto the line through A–B, clamping t to [0,1]
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const closestX = a.x + t * dx;
  const closestY = a.y + t * dy;
  const fx = p.x - closestX;
  const fy = p.y - closestY;
  return Math.sqrt(fx * fx + fy * fy);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
