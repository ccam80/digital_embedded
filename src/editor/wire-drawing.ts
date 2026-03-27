/**
 * WireDrawingMode — manages the interactive wire-drawing interaction.
 *
 * The user clicks an output pin to start a wire. Manhattan-routed preview
 * segments follow the cursor. Click adds waypoints; click on an input pin
 * completes the wire. Escape cancels.
 *
 * Manhattan routing: horizontal segment first, then vertical.
 */

import type { Point } from "@/core/renderer-interface";
import type { CircuitElement } from "@/core/element";
import type { Pin } from "@/core/pin";
import { pinWorldPosition } from "@/core/pin";
import { Wire, Circuit } from "@/core/circuit";
import { snapToGrid } from "@/editor/coordinates";
import { mergeCollinearSegments } from "@/core/wire-utils";
import { checkWireConsistency } from "@/editor/wire-consistency";
// ---------------------------------------------------------------------------
// Wire-tap helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if point P lies strictly on the interior of the axis-aligned
 * segment [A, B] (not at an endpoint).
 *
 * Wires in this editor are always horizontal (same y) or vertical (same x).
 * We check collinearity on the shared axis and that P is strictly between
 * the two endpoints.
 */
export function isPointOnSegmentInterior(p: Point, a: Point, b: Point): boolean {
  if (a.x === b.x) {
    // Vertical segment
    if (p.x !== a.x) return false;
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    return p.y > minY && p.y < maxY;
  }
  if (a.y === b.y) {
    // Horizontal segment
    if (p.y !== a.y) return false;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    return p.x > minX && p.x < maxX;
  }
  // Diagonal — not a valid wire in this editor
  return false;
}

/**
 * Scan all wires in the circuit for one whose interior contains the given point.
 * If found, remove it and replace it with two wires split at that point.
 * Returns the split point if a split occurred, or undefined if nothing was split.
 */
export function splitWiresAtPoint(point: Point, circuit: Circuit): Point | undefined {
  for (const wire of circuit.wires) {
    if (isPointOnSegmentInterior(point, wire.start, wire.end)) {
      circuit.removeWire(wire);
      circuit.addWire(new Wire(wire.start, point, wire.bitWidth));
      circuit.addWire(new Wire(point, wire.end, wire.bitWidth));
      return point;
    }
  }
  return undefined;
}

/**
 * Returns true if the given point coincides with the start or end of any wire
 * in the circuit. Used to allow wire-drawing from existing wire corners/endpoints.
 */
export function isWireEndpoint(point: Point, circuit: Circuit): boolean {
  for (const wire of circuit.wires) {
    if ((wire.start.x === point.x && wire.start.y === point.y) ||
        (wire.end.x === point.x && wire.end.y === point.y)) {
      return true;
    }
  }
  return false;
}

/**
 * Targeted junction split for newly drawn wire paths.
 *
 * Unlike the blanket `circuit.splitWiresAtJunctions()`, this only considers
 * the path's start and end points (plus existing wire endpoints and pin
 * positions) as potential split points — NOT intermediate routing corners
 * of the new wire. This prevents false junctions when a Manhattan-routed
 * wire path crosses an existing wire at an intermediate corner.
 */
export function targetedJunctionSplit(
  circuit: Circuit,
  newWires: Wire[],
  pathStart: Point,
  pathEnd: Point,
): void {
  const newWireSet = new Set(newWires);
  const pathStartKey = `${pathStart.x},${pathStart.y}`;
  const pathEndKey = `${pathEnd.x},${pathEnd.y}`;

  const points = new Set<string>();

  // Include all existing wire endpoints (not from the new wires)
  for (const w of circuit.wires) {
    if (newWireSet.has(w)) {
      // For new wires, only include the path start/end, not intermediate corners
      const sk = `${w.start.x},${w.start.y}`;
      const ek = `${w.end.x},${w.end.y}`;
      if (sk === pathStartKey || sk === pathEndKey) points.add(sk);
      if (ek === pathStartKey || ek === pathEndKey) points.add(ek);
    } else {
      points.add(`${w.start.x},${w.start.y}`);
      points.add(`${w.end.x},${w.end.y}`);
    }
  }

  // Include all pin positions
  for (const el of circuit.elements) {
    for (const pin of el.getPins()) {
      const wp = pinWorldPosition(el, pin);
      points.add(`${wp.x},${wp.y}`);
    }
  }

  circuit.splitWiresAtPoints(points);
}

/** Grid size for snapping wire endpoints. */
const WIRE_GRID_SIZE = 1;

/** A preview segment with start and end points. */
export interface PreviewSegment {
  readonly start: Point;
  readonly end: Point;
}

/**
 * Controls wire-drawing mode.
 *
 * Lifecycle:
 *   startFromPin(element, pin) → active
 *   updateCursor(point)        → preview updates
 *   addWaypoint()              → locks current segment, starts next
 *   completeToPin(element, pin, circuit) → finalizes wire, adds to circuit
 *   cancel()                   → discards in-progress wire
 */
export class WireDrawingMode {
  private _active: boolean = false;
  /** Locked waypoints including the origin. Each is the start of a new segment. */
  private _waypoints: Point[] = [];
  /** Current cursor position (snapped). */
  private _cursor: Point = { x: 0, y: 0 };
  /**
   * Once the user moves >= 2 grid units in a direction from the last waypoint,
   * lock that as the "first" axis for the current segment so routing doesn't
   * flip-flop. Reset on new segment (waypoint / start).
   */
  private _lockedAxis: 'h' | 'v' | null = null;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Begin a wire from the given pin's world position.
   * The pin position is used as the starting point.
   */
  startFromPin(element: CircuitElement, pin: Pin): void {
    const startPos = pinWorldPosition(element, pin);
    this._waypoints = [startPos];
    this._cursor = startPos;
    this._lockedAxis = null;
    this._active = true;
  }

  /**
   * Begin a wire from an arbitrary world-space point (e.g. a tap on an
   * existing wire segment).
   */
  startFromPoint(point: Point): void {
    this._waypoints = [{ ...point }];
    this._cursor = { ...point };
    this._lockedAxis = null;
    this._active = true;
  }

  /**
   * Update the current cursor position. Recomputes the Manhattan-routed
   * preview segments from the last waypoint to the cursor.
   */
  updateCursor(worldPoint: Point): void {
    if (!this._active) {
      return;
    }
    this._cursor = snapToGrid(worldPoint, WIRE_GRID_SIZE);

    // Lock the routing axis once the cursor moves >= 2 grids from the last
    // waypoint in any direction.  Once locked, the axis stays until the next
    // waypoint or new wire start.
    if (this._lockedAxis === null && this._waypoints.length > 0) {
      const last = this._waypoints[this._waypoints.length - 1]!;
      const dx = Math.abs(this._cursor.x - last.x);
      const dy = Math.abs(this._cursor.y - last.y);
      if (dx >= 2 && dx > dy) {
        this._lockedAxis = 'h';
      } else if (dy >= 2 && dy > dx) {
        this._lockedAxis = 'v';
      }
    }
  }

  /**
   * Lock the current segment by adding the intermediate corner point as a
   * waypoint, then start a new segment from the cursor.
   */
  addWaypoint(): void {
    if (!this._active) {
      return;
    }
    const last = this._waypoints[this._waypoints.length - 1]!;
    const verticalFirst = this._lockedAxis === 'v';
    const corner = verticalFirst
      ? { x: last.x, y: this._cursor.y }
      : { x: this._cursor.x, y: last.y };
    this._waypoints.push(corner);
    this._waypoints.push({ x: this._cursor.x, y: this._cursor.y });
    this._lockedAxis = null; // reset for the next segment
  }

  /**
   * Complete the wire by connecting to the given pin. Creates Wire objects
   * for all locked segments plus the final Manhattan segments to the target
   * pin, runs consistency check, merges collinear segments, adds to circuit.
   *
   * Throws FacadeError if consistency check fails.
   */
  completeToPin(element: CircuitElement, pin: Pin, circuit: Circuit, analogTypeIds?: ReadonlySet<string>): Wire[] {
    if (!this._active) {
      throw new Error("WireDrawingMode: cannot complete when not active");
    }

    const endPos = pinWorldPosition(element, pin);

    // Build all wire segments from waypoints + final Manhattan route to end
    const segments = this._buildSegments(endPos);
    const wires = segments.map((seg) => new Wire(seg.start, seg.end));

    // Merge collinear adjacent segments
    const merged = mergeCollinearSegments(wires);

    // Consistency check
    const error = checkWireConsistency(circuit, merged, analogTypeIds);
    if (error !== undefined) {
      throw error;
    }

    // Add to circuit
    for (const wire of merged) {
      circuit.addWire(wire);
    }

    // Split wires at T-junctions, excluding intermediate routing corners
    // of the new path to avoid false junctions when crossing existing wires.
    targetedJunctionSplit(circuit, merged, this._waypoints[0]!, endPos);

    this._active = false;
    return merged;
  }

  /**
   * Complete the wire by connecting to an arbitrary world-space point (used
   * when the endpoint lands on the interior of an existing wire segment rather
   * than on a pin). The caller is responsible for splitting the target wire
   * before or after calling this method.
   *
   * Throws FacadeError if consistency check fails.
   */
  completeToPoint(endPos: Point, circuit: Circuit, analogTypeIds?: ReadonlySet<string>): Wire[] {
    if (!this._active) {
      throw new Error("WireDrawingMode: cannot complete when not active");
    }

    const segments = this._buildSegments(endPos);
    const wires = segments.map((seg) => new Wire(seg.start, seg.end));
    const merged = mergeCollinearSegments(wires);

    const error = checkWireConsistency(circuit, merged, analogTypeIds);
    if (error !== undefined) {
      throw error;
    }

    for (const wire of merged) {
      circuit.addWire(wire);
    }

    // Split wires at T-junctions, excluding intermediate routing corners.
    targetedJunctionSplit(circuit, merged, this._waypoints[0]!, endPos);

    this._active = false;
    return merged;
  }

  /**
   * Discard the in-progress wire without adding anything to the circuit.
   */
  cancel(): void {
    this._active = false;
    this._waypoints = [];
    this._lockedAxis = null;
  }

  /** Returns true when wire-drawing mode is active. */
  isActive(): boolean {
    return this._active;
  }

  /**
   * Returns true if the given point is the same as the last locked waypoint.
   * Used to detect double-click-in-place to finalize a wire at an empty spot.
   */
  isSameAsLastWaypoint(point: Point): boolean {
    if (!this._active || this._waypoints.length === 0) return false;
    const last = this._waypoints[this._waypoints.length - 1]!;
    return last.x === point.x && last.y === point.y;
  }

  /**
   * Returns the current preview segments for the renderer.
   * These are the locked segments plus the current Manhattan route from the
   * last waypoint to the cursor.
   */
  getPreviewSegments(): PreviewSegment[] {
    if (!this._active || this._waypoints.length === 0) {
      return [];
    }
    const result: PreviewSegment[] = [];

    // Locked segments between consecutive waypoints
    for (let i = 0; i < this._waypoints.length - 1; i++) {
      result.push({ start: this._waypoints[i]!, end: this._waypoints[i + 1]! });
    }

    // Current Manhattan preview from last waypoint to cursor
    const last = this._waypoints[this._waypoints.length - 1]!;
    const preview = manhattanSegments(last, this._cursor, this._lockedAxis);
    for (const seg of preview) {
      result.push(seg);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Build all segments: locked segments between waypoints, plus the final
   * Manhattan route to the given endpoint.
   */
  private _buildSegments(endPos: Point): PreviewSegment[] {
    const result: PreviewSegment[] = [];

    for (let i = 0; i < this._waypoints.length - 1; i++) {
      result.push({ start: this._waypoints[i]!, end: this._waypoints[i + 1]! });
    }

    const last = this._waypoints[this._waypoints.length - 1]!;
    const finalSegments = manhattanSegments(last, endPos, this._lockedAxis);
    for (const seg of finalSegments) {
      result.push(seg);
    }

    return result;
  }
}

/**
 * Compute Manhattan-routed segments from `from` to `to`.
 *
 * When `lockedAxis` is provided ('h' or 'v'), that axis is always routed
 * first — this prevents the routing from flip-flopping once the user has
 * committed to a direction (>= 2 grid units of movement).
 *
 * Without a locked axis, the heuristic picks the axis with more displacement
 * (ties default to horizontal-first).
 */
export function manhattanSegments(
  from: Point,
  to: Point,
  lockedAxis?: 'h' | 'v' | null,
): PreviewSegment[] {
  if (from.x === to.x && from.y === to.y) {
    return [];
  }
  if (from.x === to.x) {
    // Pure vertical
    return [{ start: from, end: to }];
  }
  if (from.y === to.y) {
    // Pure horizontal
    return [{ start: from, end: to }];
  }
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  // Honour locked axis; fall back to displacement heuristic
  const verticalFirst = lockedAxis === 'v'
    ? true
    : lockedAxis === 'h'
      ? false
      : (dy >= 2 && dy > dx);
  const corner: Point = verticalFirst
    ? { x: from.x, y: to.y }
    : { x: to.x, y: from.y };
  return [
    { start: from, end: corner },
    { start: corner, end: to },
  ];
}
