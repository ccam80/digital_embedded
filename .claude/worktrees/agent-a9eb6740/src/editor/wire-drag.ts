/**
 * WireDragMode — handles dragging one or more wire segments while maintaining
 * endpoint connections, matching Java Digital's behavior.
 *
 * Single wire: constrained to perpendicular movement. Pin-connected endpoints
 * get a 1-grid stalk in the wire's original direction, then a perpendicular
 * dogleg to the new position.
 *
 * Group of wires: free 2D movement. Internal junctions (shared endpoints
 * between selected wires) move together. Boundary endpoints connected to pins
 * get L-shaped doglegs; boundary endpoints connected to non-selected wires
 * stretch those wires.
 */

import type { Point } from '@/core/renderer-interface.js';
import type { CircuitElement } from '@/core/element.js';
import { Wire } from '@/core/circuit.js';
import type { Circuit } from '@/core/circuit.js';
import { pinWorldPosition } from '@/core/pin.js';
import { snapToGrid } from '@/editor/coordinates.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Record of a boundary endpoint that needs dogleg wires on drag. */
interface DoglegEndpoint {
  wireIdx: number;
  which: 'start' | 'end';
  origPinPos: Point;
  /** Stalk direction along the wire's axis (+1 or -1). */
  stalkDx: number;
  stalkDy: number;
  /** Wire orientation at this endpoint. */
  orientation: 'h' | 'v';
}

/** Record of a non-selected wire endpoint that stretches during drag. */
interface StretchRecord {
  wire: Wire;
  which: 'start' | 'end';
  origPos: Point;
}

// ---------------------------------------------------------------------------
// WireDragMode
// ---------------------------------------------------------------------------

export class WireDragMode {
  private _active = false;

  /** All wires being dragged. */
  private _wires: Wire[] = [];
  /** Original positions for each wire. */
  private _origPositions: Array<{ start: Point; end: Point }> = [];

  /** True for single wire (perpendicular constraint), false for groups. */
  private _perpendicular = false;
  /** Orientation of the single wire (only used when _perpendicular). */
  private _orientation: 'h' | 'v' = 'h';

  private _dragOrigin: Point = { x: 0, y: 0 };

  /** Boundary endpoints connected to component pins → get doglegs. */
  private _doglegEndpoints: DoglegEndpoint[] = [];

  /** Temporary dogleg wires (rendered as preview, committed on finish). */
  private _doglegs: Wire[] = [];

  /** Non-selected wire endpoints that stretch to follow. */
  private _stretched: StretchRecord[] = [];

  isActive(): boolean {
    return this._active;
  }

  /**
   * Begin dragging the given set of wires.
   */
  start(
    wires: ReadonlySet<Wire> | Wire,
    worldPt: Point,
    circuit: Circuit,
    elements: readonly CircuitElement[],
  ): void {
    // Normalise input to array
    if (wires instanceof Wire) {
      this._wires = [wires];
    } else {
      this._wires = Array.from(wires);
    }
    if (this._wires.length === 0) return;

    // Snapshot original positions
    this._origPositions = this._wires.map((w) => ({
      start: { ...w.start },
      end: { ...w.end },
    }));

    this._dragOrigin = snapToGrid(worldPt, 1);
    this._doglegs = [];
    this._stretched = [];
    this._doglegEndpoints = [];

    // Single wire: perpendicular constraint
    this._perpendicular = this._wires.length === 1;
    if (this._perpendicular) {
      const w = this._wires[0]!;
      this._orientation = w.start.y === w.end.y ? 'h' : 'v';
    }

    // Build set of selected wire references for exclusion
    const selectedSet = new Set(this._wires);

    // Collect all endpoint positions across selected wires to detect
    // internal junctions (shared between 2+ selected wires).
    const posCount = new Map<string, number>();
    for (const w of this._wires) {
      inc(posCount, ptKey(w.start));
      inc(posCount, ptKey(w.end));
    }

    // Build pin position index for fast lookup
    const pinPositions = new Set<string>();
    for (const el of elements) {
      for (const pin of el.getPins()) {
        const wp = pinWorldPosition(el, pin);
        pinPositions.add(ptKey(wp));
      }
    }

    // Analyse each endpoint of each selected wire
    for (let i = 0; i < this._wires.length; i++) {
      const w = this._wires[i]!;
      const orig = this._origPositions[i]!;
      this._analyseEndpoint(i, 'start', orig.start, w, selectedSet, posCount, pinPositions, circuit);
      this._analyseEndpoint(i, 'end', orig.end, w, selectedSet, posCount, pinPositions, circuit);
    }

    this._active = true;
  }

  /**
   * Update wire positions during drag.
   * Returns true if anything changed (caller should schedule render).
   */
  update(worldPt: Point): boolean {
    if (!this._active || this._wires.length === 0) return false;

    const snapped = snapToGrid(worldPt, 1);
    let dx = snapped.x - this._dragOrigin.x;
    let dy = snapped.y - this._dragOrigin.y;

    // Perpendicular constraint for single wire
    if (this._perpendicular) {
      if (this._orientation === 'h') {
        dx = 0;
      } else {
        dy = 0;
      }
    }

    // Move all selected wires
    for (let i = 0; i < this._wires.length; i++) {
      const w = this._wires[i]!;
      const orig = this._origPositions[i]!;
      w.start = { x: orig.start.x + dx, y: orig.start.y + dy };
      w.end = { x: orig.end.x + dx, y: orig.end.y + dy };
    }

    // For pin-connected boundary endpoints, adjust wire endpoint inward
    // by stalk amount and build dogleg wires
    this._doglegs = [];
    const hasDelta = dx !== 0 || dy !== 0;

    for (const de of this._doglegEndpoints) {
      const w = this._wires[de.wireIdx]!;

      if (!hasDelta) {
        // At zero delta, restore to pin position (no dogleg needed)
        if (de.which === 'start') {
          w.start = { ...de.origPinPos };
        } else {
          w.end = { ...de.origPinPos };
        }
        continue;
      }

      // Shift wire endpoint inward by stalk amount
      if (de.which === 'start') {
        w.start = {
          x: w.start.x + de.stalkDx,
          y: w.start.y + de.stalkDy,
        };
      } else {
        w.end = {
          x: w.end.x + de.stalkDx,
          y: w.end.y + de.stalkDy,
        };
      }

      // Build dogleg: pin → stalk end → wire endpoint
      const wireEndpoint = de.which === 'start' ? w.start : w.end;
      const stalkEnd: Point = {
        x: de.origPinPos.x + de.stalkDx,
        y: de.origPinPos.y + de.stalkDy,
      };

      // Pin → stalk (along wire axis)
      pushSegment(this._doglegs, de.origPinPos, stalkEnd);
      // Stalk → wire endpoint (perpendicular connector)
      pushSegment(this._doglegs, stalkEnd, wireEndpoint);
    }

    // Stretch non-selected connected wires
    for (const s of this._stretched) {
      const newPos = { x: s.origPos.x + dx, y: s.origPos.y + dy };
      if (s.which === 'start') {
        s.wire.start = newPos;
      } else {
        s.wire.end = newPos;
      }
    }

    return true;
  }

  /** Dogleg preview wires to render during drag. */
  getDoglegs(): readonly Wire[] {
    return this._doglegs;
  }

  /** Commit the drag: add dogleg wires to the circuit permanently. */
  finish(circuit: Circuit): void {
    if (!this._active) return;
    for (const dw of this._doglegs) {
      circuit.addWire(dw);
    }
    // Split wires at any T-junctions created by the drag.
    circuit.splitWiresAtJunctions();
    this._active = false;
    this._doglegs = [];
  }

  /** Cancel and restore all positions to pre-drag state. */
  cancel(): void {
    if (!this._active) return;
    for (let i = 0; i < this._wires.length; i++) {
      this._wires[i]!.start = { ...this._origPositions[i]!.start };
      this._wires[i]!.end = { ...this._origPositions[i]!.end };
    }
    for (const s of this._stretched) {
      if (s.which === 'start') {
        s.wire.start = { ...s.origPos };
      } else {
        s.wire.end = { ...s.origPos };
      }
    }
    this._active = false;
    this._doglegs = [];
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Analyse one endpoint of one selected wire.
   * Determines whether it's internal (shared with another selected wire),
   * connected to a pin, connected to a non-selected wire, or free.
   */
  private _analyseEndpoint(
    wireIdx: number,
    which: 'start' | 'end',
    pt: Point,
    _wire: Wire,
    selectedSet: Set<Wire>,
    posCount: Map<string, number>,
    pinPositions: Set<string>,
    circuit: Circuit,
  ): void {
    const key = ptKey(pt);

    // Internal junction: another selected wire shares this endpoint → moves
    // with the group, no special handling needed
    if ((posCount.get(key) ?? 0) > 1) return;

    // Pin connection → dogleg
    if (pinPositions.has(key)) {
      const orig = this._origPositions[wireIdx]!;
      const otherEnd = which === 'start' ? orig.end : orig.start;
      const orientation: 'h' | 'v' = pt.y === otherEnd.y ? 'h' : 'v';

      // Stalk direction: from this endpoint toward the wire interior
      let stalkDx = 0;
      let stalkDy = 0;
      if (orientation === 'h') {
        stalkDx = otherEnd.x > pt.x ? 1 : -1;
      } else {
        stalkDy = otherEnd.y > pt.y ? 1 : -1;
      }

      this._doglegEndpoints.push({
        wireIdx,
        which,
        origPinPos: { ...pt },
        stalkDx,
        stalkDy,
        orientation,
      });
      return;
    }

    // Non-selected wire connection → stretch
    for (const w of circuit.wires) {
      if (selectedSet.has(w)) continue;
      if (w.start.x === pt.x && w.start.y === pt.y) {
        this._stretched.push({ wire: w, which: 'start', origPos: { ...w.start } });
      }
      if (w.end.x === pt.x && w.end.y === pt.y) {
        this._stretched.push({ wire: w, which: 'end', origPos: { ...w.end } });
      }
    }
    // Free endpoint: nothing to do, moves with the group
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function ptKey(p: Point): string {
  return `${p.x},${p.y}`;
}

function inc(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Push a wire segment, skipping zero-length. */
function pushSegment(out: Wire[], a: Point, b: Point): void {
  if (a.x !== b.x || a.y !== b.y) {
    out.push(new Wire(a, b));
  }
}
