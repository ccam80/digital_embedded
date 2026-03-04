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
import { Wire, Circuit } from "@/core/circuit";
import { snapToGrid } from "@/editor/coordinates";
import { mergeCollinearSegments } from "@/editor/wire-merge";
import { checkWireConsistency } from "@/editor/wire-consistency";
import { FacadeError } from "@/headless/types";

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
  /** The origin of the entire wire (the starting pin world position). */
  private _origin: Point = { x: 0, y: 0 };
  /** Locked waypoints including the origin. Each is the start of a new segment. */
  private _waypoints: Point[] = [];
  /** Current cursor position (snapped). */
  private _cursor: Point = { x: 0, y: 0 };

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Begin a wire from the given pin's world position.
   * The pin position is used as the starting point.
   */
  startFromPin(element: CircuitElement, pin: Pin): void {
    const startPos = {
      x: element.position.x + pin.position.x,
      y: element.position.y + pin.position.y,
    };
    this._origin = startPos;
    this._waypoints = [startPos];
    this._cursor = startPos;
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
    // The Manhattan corner is the turning point between the two segments
    const corner = { x: this._cursor.x, y: last.y };
    this._waypoints.push(corner);
    this._waypoints.push({ x: this._cursor.x, y: this._cursor.y });
  }

  /**
   * Complete the wire by connecting to the given pin. Creates Wire objects
   * for all locked segments plus the final Manhattan segments to the target
   * pin, runs consistency check, merges collinear segments, adds to circuit.
   *
   * Throws FacadeError if consistency check fails.
   */
  completeToPin(element: CircuitElement, pin: Pin, circuit: Circuit): Wire[] {
    if (!this._active) {
      throw new Error("WireDrawingMode: cannot complete when not active");
    }

    const endPos = {
      x: element.position.x + pin.position.x,
      y: element.position.y + pin.position.y,
    };

    // Build all wire segments from waypoints + final Manhattan route to end
    const segments = this._buildSegments(endPos);
    const wires = segments.map((seg) => new Wire(seg.start, seg.end));

    // Merge collinear adjacent segments
    const merged = mergeCollinearSegments(wires);

    // Consistency check
    const error = checkWireConsistency(circuit, merged);
    if (error !== undefined) {
      throw error;
    }

    // Add to circuit
    for (const wire of merged) {
      circuit.addWire(wire);
    }

    this._active = false;
    return merged;
  }

  /**
   * Discard the in-progress wire without adding anything to the circuit.
   */
  cancel(): void {
    this._active = false;
    this._waypoints = [];
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
    const preview = manhattanSegments(last, this._cursor);
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
    const finalSegments = manhattanSegments(last, endPos);
    for (const seg of finalSegments) {
      result.push(seg);
    }

    return result;
  }
}

/**
 * Compute Manhattan-routed segments from `from` to `to`.
 *
 * Routing strategy: horizontal first, then vertical.
 * If the points share an axis, only one segment is needed.
 */
export function manhattanSegments(from: Point, to: Point): PreviewSegment[] {
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
  // Two-segment Manhattan: horizontal first
  const corner: Point = { x: to.x, y: from.y };
  return [
    { start: from, end: corner },
    { start: corner, end: to },
  ];
}
