/**
 * Tests for PlacementMode.
 */

import { describe, it, expect } from "vitest";
import { PlacementMode } from "@/editor/placement";
import { Circuit } from "@/core/circuit";
import type { ComponentDefinition } from "@/core/registry";
import { ComponentCategory } from "@/core/registry";
import type { CircuitElement } from "@/core/element";
import type { Pin, Rotation } from "@/core/pin";
import type { RenderContext, Rect, Point } from "@/core/renderer-interface";
import type { PropertyBag, PropertyValue } from "@/core/properties";
import type { SerializedElement } from "@/core/element";

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;

function makeStubElement(position: Point = { x: 0, y: 0 }): CircuitElement {
  const id = `el-${++_idCounter}`;
  return {
    typeId: "MockComp",
    instanceId: id,
    position: { ...position },
    rotation: 0 as Rotation,
    mirror: false,
    getPins: (): readonly Pin[] => [],
    getProperties: (): PropertyBag => ({} as PropertyBag),
    draw: (_ctx: RenderContext): void => {},
    getBoundingBox: (): Rect => ({ x: position.x, y: position.y, width: 4, height: 4 }),
    serialize: (): SerializedElement => ({} as SerializedElement),
    getHelpText: (): string => "Mock component",
    getAttribute: (_name: string): PropertyValue | undefined => undefined,
  };
}

function makeMockDefinition(): ComponentDefinition {
  return {
    name: "MockComp",
    typeId: -1,
    factory: (_props: PropertyBag): CircuitElement => makeStubElement(),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: "A mock component for testing",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlacementMode", () => {
  it("ghostFollowsCursorSnapped", () => {
    const mode = new PlacementMode();
    const def = makeMockDefinition();

    mode.start(def);
    mode.updateCursor({ x: 3.7, y: 2.3 });

    const ghost = mode.getGhost();
    expect(ghost).toBeDefined();
    // snapToGrid with gridSize=1: round(3.7)=4, round(2.3)=2
    expect(ghost!.position.x).toBe(4);
    expect(ghost!.position.y).toBe(2);
  });

  it("rotatesCyclically", () => {
    const mode = new PlacementMode();
    const def = makeMockDefinition();

    mode.start(def);

    const rotations: Rotation[] = [];

    // Collect rotation after each rotate() call (4 rotations back to 0)
    mode.rotate();
    rotations.push(mode.getGhost()!.rotation);
    mode.rotate();
    rotations.push(mode.getGhost()!.rotation);
    mode.rotate();
    rotations.push(mode.getGhost()!.rotation);
    mode.rotate();
    rotations.push(mode.getGhost()!.rotation);

    expect(rotations).toEqual([1, 2, 3, 0]);
  });

  it("mirrorToggles", () => {
    const mode = new PlacementMode();
    const def = makeMockDefinition();

    mode.start(def);

    const initialMirror = mode.getGhost()!.mirror;
    expect(initialMirror).toBe(false);

    mode.mirror();
    expect(mode.getGhost()!.mirror).toBe(true);

    mode.mirror();
    expect(mode.getGhost()!.mirror).toBe(false);
  });

  it("placeReturnsElement", () => {
    const mode = new PlacementMode();
    const def = makeMockDefinition();
    const circuit = new Circuit();

    mode.start(def);
    mode.updateCursor({ x: 5, y: 3 });

    const placed = mode.place(circuit);

    // place() no longer adds to circuit directly — caller uses placeComponent EditCommand
    expect(circuit.elements).toHaveLength(0);
    // Element position should match the ghost position (snapped cursor)
    expect(placed.position.x).toBe(5);
    expect(placed.position.y).toBe(3);
    // Last placed element is tracked
    expect(mode.getLastPlaced()).toBe(placed);
  });

  it("staysActiveAfterPlace", () => {
    const mode = new PlacementMode();
    const def = makeMockDefinition();
    const circuit = new Circuit();

    mode.start(def);
    mode.place(circuit);

    expect(mode.isActive()).toBe(true);
  });

  it("placedElementPositionMatchesSnappedCursor", () => {
    const mode = new PlacementMode();
    const def = makeMockDefinition();
    const circuit = new Circuit();

    mode.start(def);
    // Move cursor to a fractional world position
    mode.updateCursor({ x: 3.7, y: 2.3 });
    const placed = mode.place(circuit);

    // snapToGrid(gridSize=1): round(3.7)=4, round(2.3)=2
    expect(placed.position.x).toBe(4);
    expect(placed.position.y).toBe(2);
  });

  it("cancelExitsMode", () => {
    const mode = new PlacementMode();
    const def = makeMockDefinition();

    mode.start(def);
    expect(mode.isActive()).toBe(true);

    mode.cancel();

    expect(mode.isActive()).toBe(false);
    expect(mode.getGhost()).toBeUndefined();
  });
});
