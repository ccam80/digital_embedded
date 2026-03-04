/**
 * Tests for WireDrawingMode, mergeCollinearSegments, and checkWireConsistency.
 *
 * All described in task 2.3.4 spec.
 */

import { describe, it, expect } from "vitest";
import { WireDrawingMode } from "@/editor/wire-drawing";
import { mergeCollinearSegments } from "@/editor/wire-merge";
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
    getHelpText: (): string => "stub",
    getAttribute: (_name: string): PropertyValue | undefined => undefined,
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
