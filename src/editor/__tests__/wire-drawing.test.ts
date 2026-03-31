/**
 * Tests for WireDrawingMode, mergeCollinearSegments, and checkWireConsistency.
 *
 * All described in task 2.3.4 spec.
 */

import { describe, it, expect } from "vitest";
import { WireDrawingMode, splitWiresAtPoint } from "@/editor/wire-drawing";
import { mergeCollinearSegments } from "@/core/wire-utils";
import { checkWireConsistency } from "@/editor/wire-consistency";
import { Wire, Circuit } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";
import type { Pin, Rotation } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { PropertyBag, PropertyValue } from "@/core/properties";
import type { SerializedElement } from "@/core/element";

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;

interface StubPinSpec {
  label: string;
  direction: PinDirection;
  relX: number;
  relY: number;
}

function makeStubElement(
  posX: number,
  posY: number,
  pinSpecs: StubPinSpec[] = [],
): CircuitElement {
  const id = `el-${++_idCounter}`;
  const pins: Pin[] = pinSpecs.map((spec) => ({
    direction: spec.direction,
    position: { x: spec.relX, y: spec.relY },
    label: spec.label,
    bitWidth: 1,
    isNegated: false,
    isClock: false,
    kind: 'signal' as const,
  }));

  return {
    typeId: "StubComp",
    instanceId: id,
    position: { x: posX, y: posY },
    rotation: 0 as Rotation,
    mirror: false,
    getPins: (): readonly Pin[] => pins,
    getProperties: (): PropertyBag => ({} as PropertyBag),
    draw: (_ctx: RenderContext): void => {},
    getBoundingBox: (): Rect => ({ x: posX, y: posY, width: 4, height: 4 }),
    serialize: (): SerializedElement => ({} as SerializedElement),
    getAttribute: (_name: string): PropertyValue | undefined => undefined,
    setAttribute: (_name: string, _value: PropertyValue): void => {},
  };
}

// ---------------------------------------------------------------------------
// WireDrawing tests
// ---------------------------------------------------------------------------

describe("WireDrawing", () => {
  it("manhattanRouteHorizontalFirst", () => {
    const mode = new WireDrawingMode();

    // Element at (0,0) with output pin at relative (0,0)
    const srcElement = makeStubElement(0, 0, [
      { label: "out", direction: PinDirection.OUTPUT, relX: 0, relY: 0 },
    ]);
    const srcPin = srcElement.getPins()[0]!;

    mode.startFromPin(srcElement, srcPin);
    mode.updateCursor({ x: 5, y: 3 });

    const segments = mode.getPreviewSegments();

    // Manhattan routing: horizontal first (0,0)→(5,0), then vertical (5,0)→(5,3)
    expect(segments).toHaveLength(2);
    expect(segments[0]!.start).toEqual({ x: 0, y: 0 });
    expect(segments[0]!.end).toEqual({ x: 5, y: 0 });
    expect(segments[1]!.start).toEqual({ x: 5, y: 0 });
    expect(segments[1]!.end).toEqual({ x: 5, y: 3 });
  });

  it("waypointLocksSegment", () => {
    const mode = new WireDrawingMode();

    const srcElement = makeStubElement(0, 0, [
      { label: "out", direction: PinDirection.OUTPUT, relX: 0, relY: 0 },
    ]);
    const srcPin = srcElement.getPins()[0]!;

    mode.startFromPin(srcElement, srcPin);
    mode.updateCursor({ x: 5, y: 3 });

    // Lock a waypoint — the corner at (5, 0) and cursor at (5, 3) become locked
    mode.addWaypoint();

    // Now move cursor further
    mode.updateCursor({ x: 10, y: 3 });

    const segments = mode.getPreviewSegments();

    // We should have locked segments plus the new preview to (10, 3)
    // The locked waypoints from addWaypoint include the corner and the cursor at time of waypoint
    // Preview segments = locked segs + current manhattan route from last waypoint
    expect(segments.length).toBeGreaterThanOrEqual(1);

    // The first locked segment(s) from origin should still be present
    const allStarts = segments.map((s) => s.start);
    const hasOrigin = allStarts.some((p) => p.x === 0 && p.y === 0);
    expect(hasOrigin).toBe(true);
  });

  it("completeToPinAddsWires", () => {
    const mode = new WireDrawingMode();
    const circuit = new Circuit();

    const srcElement = makeStubElement(0, 0, [
      { label: "out", direction: PinDirection.OUTPUT, relX: 0, relY: 0 },
    ]);
    const srcPin = srcElement.getPins()[0]!;

    const dstElement = makeStubElement(5, 0, [
      { label: "in", direction: PinDirection.INPUT, relX: 0, relY: 0 },
    ]);
    const dstPin = dstElement.getPins()[0]!;

    mode.startFromPin(srcElement, srcPin);
    mode.updateCursor({ x: 5, y: 0 });

    const wires = mode.completeToPin(dstElement, dstPin, circuit);

    expect(wires.length).toBeGreaterThan(0);
    expect(circuit.wires.length).toBeGreaterThan(0);
  });

  it("cancelDiscardsWire", () => {
    const mode = new WireDrawingMode();
    const circuit = new Circuit();

    const srcElement = makeStubElement(0, 0, [
      { label: "out", direction: PinDirection.OUTPUT, relX: 0, relY: 0 },
    ]);
    const srcPin = srcElement.getPins()[0]!;

    mode.startFromPin(srcElement, srcPin);
    mode.updateCursor({ x: 5, y: 3 });
    mode.cancel();

    // No wires added to circuit
    expect(circuit.wires).toHaveLength(0);
    // Preview segments are empty after cancel
    expect(mode.getPreviewSegments()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WireMerge tests
// ---------------------------------------------------------------------------

describe("WireMerge", () => {
  it("mergesCollinearHorizontal", () => {
    const wire1 = new Wire({ x: 0, y: 0 }, { x: 5, y: 0 });
    const wire2 = new Wire({ x: 5, y: 0 }, { x: 10, y: 0 });

    const merged = mergeCollinearSegments([wire1, wire2]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.start.x).toBe(0);
    expect(merged[0]!.start.y).toBe(0);
    expect(merged[0]!.end.x).toBe(10);
    expect(merged[0]!.end.y).toBe(0);
  });

  it("doesNotMergeNonCollinear", () => {
    // Two wires at different y values — not collinear
    const wire1 = new Wire({ x: 0, y: 0 }, { x: 5, y: 0 });
    const wire2 = new Wire({ x: 5, y: 1 }, { x: 10, y: 1 });

    const merged = mergeCollinearSegments([wire1, wire2]);

    expect(merged).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Wire-tap tests
// ---------------------------------------------------------------------------


describe("splitWiresAtPoint", () => {
  it("splits a horizontal wire at an interior point", () => {
    const circuit = new Circuit();
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 10, y: 0 }));

    const result = splitWiresAtPoint({ x: 4, y: 0 }, circuit);

    expect(result).toEqual({ x: 4, y: 0 });
    expect(circuit.wires).toHaveLength(2);
    // One wire from 0 to 4, one from 4 to 10
    const sorted = [...circuit.wires].sort((a, b) => a.start.x - b.start.x);
    expect(sorted[0]!.start).toEqual({ x: 0, y: 0 });
    expect(sorted[0]!.end).toEqual({ x: 4, y: 0 });
    expect(sorted[1]!.start).toEqual({ x: 4, y: 0 });
    expect(sorted[1]!.end).toEqual({ x: 10, y: 0 });
  });

  it("splits a vertical wire at an interior point", () => {
    const circuit = new Circuit();
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 10 }));

    const result = splitWiresAtPoint({ x: 0, y: 6 }, circuit);

    expect(result).toEqual({ x: 0, y: 6 });
    expect(circuit.wires).toHaveLength(2);
  });

  it("returns undefined when no wire is hit", () => {
    const circuit = new Circuit();
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 10, y: 0 }));

    const result = splitWiresAtPoint({ x: 5, y: 3 }, circuit);

    expect(result).toBeUndefined();
    expect(circuit.wires).toHaveLength(1);
  });

  it("returns undefined when point is at a wire endpoint (not interior)", () => {
    const circuit = new Circuit();
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 10, y: 0 }));

    const result = splitWiresAtPoint({ x: 10, y: 0 }, circuit);

    expect(result).toBeUndefined();
    expect(circuit.wires).toHaveLength(1);
  });
});

describe("WireDrawing wire-tap", () => {
  it("startFromPoint activates drawing from an arbitrary point", () => {
    const mode = new WireDrawingMode();
    mode.startFromPoint({ x: 5, y: 3 });

    expect(mode.isActive()).toBe(true);
    mode.updateCursor({ x: 8, y: 3 });
    const segments = mode.getPreviewSegments();
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0]!.start).toEqual({ x: 5, y: 3 });
  });

  it("completeToPoint adds wires and splits the target wire", () => {
    const circuit = new Circuit();
    // Existing wire from (0,5) to (10,5)
    circuit.addWire(new Wire({ x: 0, y: 5 }, { x: 10, y: 5 }));

    // Tap the existing wire at (4,5) to split it
    splitWiresAtPoint({ x: 4, y: 5 }, circuit);
    expect(circuit.wires).toHaveLength(2);

    // Draw a new wire from (4,0) down to the tap point (4,5)
    const mode = new WireDrawingMode();
    mode.startFromPoint({ x: 4, y: 0 });
    const newWires = mode.completeToPoint({ x: 4, y: 5 }, circuit);

    expect(newWires.length).toBeGreaterThan(0);
    // Circuit now has the 2 split wires + the new wire(s)
    expect(circuit.wires.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// WireConsistency tests
// ---------------------------------------------------------------------------

describe("WireConsistency", () => {
  it("detectsShortedOutputs", () => {
    const circuit = new Circuit();

    // Two output pins at (0,0) and (5,0)
    const el1 = makeStubElement(0, 0, [
      { label: "out", direction: PinDirection.OUTPUT, relX: 0, relY: 0 },
    ]);
    const el2 = makeStubElement(5, 0, [
      { label: "out", direction: PinDirection.OUTPUT, relX: 0, relY: 0 },
    ]);

    circuit.addElement(el1);
    circuit.addElement(el2);

    // Wire connecting both output pins
    const connectingWire = new Wire({ x: 0, y: 0 }, { x: 5, y: 0 });

    const error = checkWireConsistency(circuit, [connectingWire]);

    expect(error).toBeDefined();
    expect(error!.message).toContain("Shorted outputs");
  });
});
