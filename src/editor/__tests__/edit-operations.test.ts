/**
 * Tests for edit-operations and label-renamer.
 */

import { describe, it, expect } from "vitest";
import {
  moveSelection,
  deleteSelection,
  copyToClipboard,
  pasteFromClipboard,
} from "@/editor/edit-operations";
import { renameLabelsOnCopy } from "@/editor/label-renamer";
import { Wire, Circuit } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";
import type { Pin, Rotation } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { SerializedElement } from "@/core/element";
import type { ComponentDefinition } from "@/core/registry";
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
    getHelpText: (): string => "stub",
    getAttribute: (_name: string): PropertyValue | undefined => undefined,
  };
}

function makeDefinition(typeId: string = "StubComp"): ComponentDefinition {
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
        getHelpText: (): string => "stub",
        getAttribute: (_name: string): PropertyValue | undefined => undefined,
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

    const resolver = (_typeId: string): ComponentDefinition | undefined => def;
    const clipboard = copyToClipboard([el], [], resolver);

    const cmd = pasteFromClipboard(circuit, clipboard, { x: 5, y: 5 });
    cmd.execute();

    expect(circuit.elements).toHaveLength(2);
    expect(circuit.elements[0]!.instanceId).not.toBe(circuit.elements[1]!.instanceId);
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
