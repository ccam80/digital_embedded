/**
 * Hit-testing — pure functions for determining what the user interacted with.
 *
 * Priority ordering: pin > element > wire > none.
 * All coordinates are in world (grid) space.
 */

import type { Point, Rect } from "@/core/renderer-interface";
import type { CircuitElement } from "@/core/element";
import type { Rotation } from "@/core/pin";
import type { Pin } from "@/core/pin";
import { pinWorldPosition } from "@/core/pin";
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
    const bb = worldBoundingBox(el);
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
      const wp = pinWorldPosition(el, pin);
      const dx = point.x - wp.x;
      const dy = point.y - wp.y;
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
  return elements.filter((el) => rectsIntersect(worldBoundingBox(el), rect));
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
// Rotation-aware bounding box
// ---------------------------------------------------------------------------

/**
 * Compute the axis-aligned bounding box of an element in world coordinates,
 * accounting for rotation. The renderer does translate(pos) then rotate(rot),
 * so the local rect (0,0,w,h) corners are rotated around the element origin.
 *
 * Rotation values: 0 = 0°, 1 = 90° CW, 2 = 180°, 3 = 270° CW.
 */
export function worldBoundingBox(el: CircuitElement): Rect {
  const bb = el.getBoundingBox();
  const w = bb.width;
  const h = bb.height;
  const px = el.position.x;
  const py = el.position.y;
  const rot = el.rotation as Rotation;

  switch (rot) {
    case 0: // No rotation
      return { x: px, y: py, width: w, height: h };
    case 1: // 90° CW: (x,y) -> (y, -x)
      return { x: px, y: py - w, width: h, height: w };
    case 2: // 180°: (x,y) -> (-x, -y)
      return { x: px - w, y: py - h, width: w, height: h };
    case 3: // 270° CW: (x,y) -> (-y, x)
      return { x: px - h, y: py, width: h, height: w };
    default:
      return { x: px, y: py, width: w, height: h };
  }
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
