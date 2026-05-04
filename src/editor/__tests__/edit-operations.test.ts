/**
 * Tests for edit-operations and label-renamer.
 */

import { describe, it, expect } from "vitest";
import {
  moveSelection,
  deleteSelection,
  copyToClipboard,
  pasteFromClipboard,
  placeComponent,
} from "@/editor/edit-operations";
import { renameLabelsOnCopy } from "@/editor/label-renamer";
import { Wire, Circuit } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";
import type { Pin, Rotation, PinDirection } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { SerializedElement } from "@/core/element";
import type { StandaloneComponentDefinition } from "@/core/registry";
import { ComponentCategory } from "@/core/registry";
import { PropertyBag } from "@/core/properties";
import type { PropertyValue } from "@/core/properties";

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;

function makeStubElement(
  posX: number = 0,
  posY: number = 0,
  label?: string,
): CircuitElement {
  const id = `el-${++_idCounter}`;
  const props = new PropertyBag();
  if (label !== undefined) {
    props.set("label", label);
  }

  return {
    typeId: "StubComp",
    instanceId: id,
    position: { x: posX, y: posY },
    rotation: 0 as Rotation,
    mirror: false,
    getPins: (): readonly Pin[] => [],
    getProperties: (): PropertyBag => props,
    draw: (_ctx: RenderContext): void => {},
    getBoundingBox: (): Rect => ({ x: posX, y: posY, width: 4, height: 4 }),
    serialize: (): SerializedElement => ({} as SerializedElement),
    getAttribute: (_name: string): PropertyValue | undefined => undefined,
    setAttribute: (_name: string, _value: PropertyValue): void => {},
  };
}

function makeDefinition(typeId: string = "StubComp"): StandaloneComponentDefinition {
  return {
    name: typeId,
    typeId: -1,
    factory: (props: PropertyBag): CircuitElement => {
      const id = `el-${++_idCounter}`;
      return {
        typeId,
        instanceId: id,
        position: { x: 0, y: 0 },
        rotation: 0 as Rotation,
        mirror: false,
        getPins: (): readonly Pin[] => [],
        getProperties: (): PropertyBag => props,
        draw: (_ctx: RenderContext): void => {},
        getBoundingBox: (): Rect => ({ x: 0, y: 0, width: 4, height: 4 }),
        serialize: (): SerializedElement => ({} as SerializedElement),
        getAttribute: (_name: string): PropertyValue | undefined => undefined,
        setAttribute: (_name: string, _value: PropertyValue): void => {},
      };
    },
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: "stub",
    models: { digital: { executeFn: () => {} } },
  };
}

// ---------------------------------------------------------------------------
// EditOps tests
// ---------------------------------------------------------------------------

describe("EditOps", () => {
  it("moveUpdatesPositions", () => {
    const circuit = new Circuit();
    const el1 = makeStubElement(0, 0);
    const el2 = makeStubElement(5, 5);
    const wire = new Wire({ x: 0, y: 0 }, { x: 5, y: 5 });

    circuit.addElement(el1);
    circuit.addElement(el2);
    circuit.addWire(wire);

    const cmd = moveSelection([el1, el2], [wire], { x: 2, y: 3 });
    cmd.execute();

    expect(el1.position).toEqual({ x: 2, y: 3 });
    expect(el2.position).toEqual({ x: 7, y: 8 });
    expect(wire.start).toEqual({ x: 2, y: 3 });
    expect(wire.end).toEqual({ x: 7, y: 8 });
  });

  it("deleteRemovesFromCircuit", () => {
    const circuit = new Circuit();
    const el1 = makeStubElement(0, 0);
    const el2 = makeStubElement(5, 5);
    const el3 = makeStubElement(10, 10);

    circuit.addElement(el1);
    circuit.addElement(el2);
    circuit.addElement(el3);

    const cmd = deleteSelection(circuit, [el1, el2], []);
    cmd.execute();

    expect(circuit.elements).toHaveLength(1);
    expect(circuit.elements[0]).toBe(el3);
  });

  it("copyPasteCreatesClones", () => {
    const circuit = new Circuit();
    const def = makeDefinition("StubComp");
    const el = makeStubElement(0, 0);

    circuit.addElement(el);

    const resolver = (_typeId: string): StandaloneComponentDefinition | undefined => def;
    const clipboard = copyToClipboard([el], [], resolver);

    const cmd = pasteFromClipboard(circuit, clipboard, { x: 5, y: 5 });
    cmd.execute();

    expect(circuit.elements).toHaveLength(2);
    expect(circuit.elements[0]!.instanceId).not.toBe(circuit.elements[1]!.instanceId);
  });

});

// ---------------------------------------------------------------------------
// Wire punch-out tests
// ---------------------------------------------------------------------------

/**
 * Create a stub element with pins at specified LOCAL positions and a
 * configurable bounding box. Pin world positions = element.position +
 * pin.position (rotation=0, mirror=false).
 */
function makeStubWithPins(
  posX: number,
  posY: number,
  pinOffsets: Array<{ x: number; y: number }>,
  bboxOverride?: Rect,
): CircuitElement {
  const id = `el-${++_idCounter}`;
  const props = new PropertyBag();
  const pins: Pin[] = pinOffsets.map((off, i) => ({
    direction: "INPUT" as PinDirection,
    position: { x: off.x, y: off.y },
    label: `P${i}`,
    bitWidth: 1,
    isNegated: false,
    isClock: false,
    kind: "signal" as const,
  }));

  // Default bbox: centered on the pin span with 1-unit padding
  const defaultBbox: Rect = { x: posX - 1, y: posY - 1, width: 6, height: 6 };
  const bbox = bboxOverride ?? defaultBbox;

  return {
    typeId: "StubComp",
    instanceId: id,
    position: { x: posX, y: posY },
    rotation: 0 as Rotation,
    mirror: false,
    getPins: (): readonly Pin[] => pins,
    getProperties: (): PropertyBag => props,
    draw: (_ctx: RenderContext): void => {},
    getBoundingBox: (): Rect => bbox,
    serialize: (): SerializedElement => ({} as SerializedElement),
    getAttribute: (_name: string): PropertyValue | undefined => undefined,
    setAttribute: (_name: string, _value: PropertyValue): void => {},
  };
}

describe("Wire punch-out on placeComponent", () => {
  it("punches out a horizontal wire that passes through the body", () => {
    const circuit = new Circuit();
    // Horizontal wire from (0,5) to (10,5)
    circuit.addWire(new Wire({ x: 0, y: 5 }, { x: 10, y: 5 }));

    // Component at (3,5) with pins at local (0,0) and (4,0)
    // → world pins at (3,5) and (7,5), both on the wire
    // Bbox: body spans y=3→7, so wire at y=5 is strictly inside
    const el = makeStubWithPins(3, 5,
      [{ x: 0, y: 0 }, { x: 4, y: 0 }],
      { x: 2, y: 3, width: 6, height: 4 },
    );

    const cmd = placeComponent(circuit, el);
    cmd.execute();

    // Original wire removed, replaced by two stubs
    expect(circuit.wires).toHaveLength(2);
    const left = circuit.wires.find(w => w.start.x === 0 && w.end.x === 3);
    expect(left).toBeDefined();
    const right = circuit.wires.find(w => w.start.x === 7 && w.end.x === 10);
    expect(right).toBeDefined();
  });

  it("punches out a vertical wire that passes through the body", () => {
    const circuit = new Circuit();
    // Vertical wire from (5,0) to (5,10)
    circuit.addWire(new Wire({ x: 5, y: 0 }, { x: 5, y: 10 }));

    // Component at (5,2) with pins at local (0,0) and (0,6)
    // → world pins at (5,2) and (5,8)
    // Bbox: body spans x=3→7, so wire at x=5 is strictly inside
    const el = makeStubWithPins(5, 2,
      [{ x: 0, y: 0 }, { x: 0, y: 6 }],
      { x: 3, y: 1, width: 4, height: 8 },
    );

    const cmd = placeComponent(circuit, el);
    cmd.execute();

    expect(circuit.wires).toHaveLength(2);
    const top = circuit.wires.find(w => w.start.y === 0 && w.end.y === 2);
    expect(top).toBeDefined();
    const bottom = circuit.wires.find(w => w.start.y === 8 && w.end.y === 10);
    expect(bottom).toBeDefined();
  });

  it("does NOT punch out a wire running along an edge (ground rail)", () => {
    const circuit = new Circuit();
    // Ground rail: horizontal wire at y=10
    circuit.addWire(new Wire({ x: 0, y: 10 }, { x: 20, y: 10 }));

    // Component body from y=4 to y=10 (bbox.y=4, height=6).
    // Two south-face pins at world (5,10) and (8,10) sit ON the bbox edge.
    // Wire at y=10 is NOT strictly inside (10 >= 4+6=10), so no punch-out.
    const el = makeStubWithPins(5, 4,
      [{ x: 0, y: 6 }, { x: 3, y: 6 }],
      { x: 4, y: 4, width: 5, height: 6 },
    );

    const cmd = placeComponent(circuit, el);
    cmd.execute();

    // Wire must be untouched
    expect(circuit.wires).toHaveLength(1);
    expect(circuit.wires[0]!.start).toEqual({ x: 0, y: 10 });
    expect(circuit.wires[0]!.end).toEqual({ x: 20, y: 10 });
  });

  it("does nothing when only 1 pin touches a wire", () => {
    const circuit = new Circuit();
    circuit.addWire(new Wire({ x: 0, y: 5 }, { x: 10, y: 5 }));

    const el = makeStubWithPins(3, 5, [{ x: 0, y: 0 }, { x: 0, y: -3 }]);

    const cmd = placeComponent(circuit, el);
    cmd.execute();

    expect(circuit.wires).toHaveLength(1);
    expect(circuit.wires[0]!.start).toEqual({ x: 0, y: 5 });
    expect(circuit.wires[0]!.end).toEqual({ x: 10, y: 5 });
  });

  it("pins at wire endpoints produce no stubs (full consumption)", () => {
    const circuit = new Circuit();
    // Wire from (3,5) to (7,5)- exactly matching the pin positions
    circuit.addWire(new Wire({ x: 3, y: 5 }, { x: 7, y: 5 }));

    // Bbox encloses the wire strictly in y
    const el = makeStubWithPins(3, 5,
      [{ x: 0, y: 0 }, { x: 4, y: 0 }],
      { x: 2, y: 3, width: 6, height: 4 },
    );

    const cmd = placeComponent(circuit, el);
    cmd.execute();

    // Entire wire consumed, no stubs (zero-length filtered by addWire)
    expect(circuit.wires).toHaveLength(0);
  });

  it("undo restores the original wire", () => {
    const circuit = new Circuit();
    const origWire = new Wire({ x: 0, y: 5 }, { x: 10, y: 5 });
    circuit.addWire(origWire);

    const el = makeStubWithPins(3, 5,
      [{ x: 0, y: 0 }, { x: 4, y: 0 }],
      { x: 2, y: 3, width: 6, height: 4 },
    );

    const cmd = placeComponent(circuit, el);
    cmd.execute();
    expect(circuit.wires).toHaveLength(2);
    expect(circuit.elements).toHaveLength(1);

    cmd.undo();
    expect(circuit.elements).toHaveLength(0);
    expect(circuit.wires).toHaveLength(1);
    expect(circuit.wires[0]).toBe(origWire);
  });
});

// ---------------------------------------------------------------------------
// LabelRenamer tests
// ---------------------------------------------------------------------------

describe("LabelRenamer", () => {
  it("incrementsNumericSuffix", () => {
    const existing = makeStubElement(0, 0, "Reg1");
    const newEl = makeStubElement(5, 0, "Reg1");

    // newEl is the copy; existing is already in the circuit
    renameLabelsOnCopy([newEl], [existing, newEl]);

    const newLabel = String(newEl.getProperties().get("label"));
    expect(newLabel).toBe("Reg2");
  });

  it("skipsExistingLabels", () => {
    // Reg1 and Reg2 already exist; copy of Reg1 should become Reg3
    const reg1 = makeStubElement(0, 0, "Reg1");
    const reg2 = makeStubElement(5, 0, "Reg2");
    const copied = makeStubElement(10, 0, "Reg1");

    renameLabelsOnCopy([copied], [reg1, reg2, copied]);

    const newLabel = String(copied.getProperties().get("label"));
    expect(newLabel).toBe("Reg3");
  });

  it("noSuffixNoRename", () => {
    const existing = makeStubElement(0, 0, "Clock");
    const copied = makeStubElement(5, 0, "Clock");

    renameLabelsOnCopy([copied], [existing, copied]);

    const label = String(copied.getProperties().get("label"));
    expect(label).toBe("Clock");
  });
});
