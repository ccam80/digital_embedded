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
 *
 * @param margin  Optional bounding-box inflation in grid units (for touch targets).
 */
export function hitTestElements(
  point: Point,
  elements: readonly CircuitElement[],
  margin = 0,
): CircuitElement | undefined {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]!;
    const bb = worldBoundingBox(el);
    const inflated: Rect = {
      x: bb.x - margin,
      y: bb.y - margin,
      width: bb.width + margin * 2,
      height: bb.height + margin * 2,
    };
    if (pointInRect(point, inflated)) {
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
 *
 * @param margin  Optional bounding-box inflation for element hit testing (touch targets).
 */
export function hitTestAll(
  point: Point,
  circuit: Circuit,
  threshold: number,
  margin = 0,
): HitResult {
  const pinHit = hitTestPins(point, circuit.elements, threshold);
  if (pinHit !== undefined) {
    return { type: "pin", element: pinHit.element, pin: pinHit.pin };
  }

  const elementHit = hitTestElements(point, circuit.elements, margin);
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
 * accounting for mirror and rotation.
 *
 * The renderer applies transforms as: translate(pos) → rotate(rot) → scale(-1,1).
 * Canvas transforms compose right-to-left, so the effective order on local
 * coordinates is: mirror → rotate → translate.
 *
 * getBoundingBox() returns world coordinates (includes element position),
 * so we extract the local offset, apply mirror+rotation, then translate back.
 *
 * Rotation values: 0 = 0°, 1 = 90° CW, 2 = 180°, 3 = 270° CW.
 */
export function worldBoundingBox(el: CircuitElement): Rect {
  const bb = el.getBoundingBox();
  const px = el.position.x;
  const py = el.position.y;

  // Local bounding box offset from element origin
  let lx = bb.x - px;
  let ly = bb.y - py;
  const w = bb.width;
  const h = bb.height;

  // Mirror negates Y in local space (vertical flip), matching Java Digital's
  // TransformMatrix(1,0,0,-1) convention, before rotation.
  if (el.mirror) {
    ly = -(ly + h);
  }

  const rot = el.rotation as Rotation;
  let rx: number, ry: number, rw: number, rh: number;

  switch (rot) {
    case 0:
      rx = lx; ry = ly; rw = w; rh = h;
      break;
    case 1: // 90° CW: (x,y) → (y, -x)
      rx = ly; ry = -(lx + w); rw = h; rh = w;
      break;
    case 2: // 180°: (x,y) → (-x, -y)
      rx = -(lx + w); ry = -(ly + h); rw = w; rh = h;
      break;
    case 3: // 270° CW: (x,y) → (-y, x)
      rx = -(ly + h); ry = lx; rw = h; rh = w;
      break;
    default:
      rx = lx; ry = ly; rw = w; rh = h;
  }

  return { x: px + rx, y: py + ry, width: rw, height: rh };
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
