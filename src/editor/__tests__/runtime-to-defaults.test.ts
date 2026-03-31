import { describe, it, expect } from "vitest";
import {
  captureRuntimeToDefaults,
  restoreAllFuses,
  type ElementSignalAccess,
} from "../runtime-to-defaults.js";
import { Circuit } from "@/core/circuit";
import { PropertyBag } from "@/core/properties";
import type { CircuitElement } from "@/core/element";
import type { Rect } from "@/core/renderer-interface";
import type { Pin } from "@/core/pin";
import type { RenderContext } from "@/core/renderer-interface";
import type { PropertyValue } from "@/core/properties";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeElement(
  typeId: string,
  properties: Record<string, PropertyValue>,
): CircuitElement {
  const bag = new PropertyBag(Object.entries(properties));

  return {
    typeId,
    instanceId: `inst-${typeId}-${Math.random()}`,
    position: { x: 0, y: 0 },
    rotation: 0,
    mirror: false,
    getPins(): Pin[] {
      return [];
    },
    getBoundingBox(): Rect {
      return { x: 0, y: 0, width: 10, height: 10 };
    },
    getProperties(): PropertyBag {
      return bag;
    },
    draw(_ctx: RenderContext): void {},
    serialize() {
      return {
        typeId,
        instanceId: `inst-${typeId}`,
        position: { x: 0, y: 0 },
        rotation: 0 as const,
        mirror: false,
        properties: {},
      };
    },
    getAttribute(name: string): PropertyValue | undefined {
      return bag.has(name) ? bag.get(name) : undefined;
    },
    setAttribute(_name: string, _value: PropertyValue): void {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RuntimeToDefaults", () => {
  it("capturesCurrentValues", () => {
    const circuit = new Circuit();
    const element = makeElement("Register", { value: 0 });
    circuit.addElement(element);

    const mockAccess: ElementSignalAccess = {
      getElementValue(el: CircuitElement): number | undefined {
        if (el === element) return 42;
        return undefined;
      },
    };

    const cmd = captureRuntimeToDefaults(circuit, mockAccess);
    cmd.execute();

    expect(element.getProperties().get<number>("value")).toBe(42);
  });

  it("restoresFuses", () => {
    const circuit = new Circuit();
    const fuse1 = makeElement("Fuse", { blown: true });
    const fuse2 = makeElement("Fuse", { blown: true });
    circuit.addElement(fuse1);
    circuit.addElement(fuse2);

    const cmd = restoreAllFuses(circuit);
    cmd.execute();

    expect(fuse1.getProperties().get<boolean>("blown")).toBe(false);
    expect(fuse2.getProperties().get<boolean>("blown")).toBe(false);
  });

  it("undoableCapture", () => {
    const circuit = new Circuit();
    const element = makeElement("Register", { value: 0 });
    circuit.addElement(element);

    const mockAccess: ElementSignalAccess = {
      getElementValue(_el: CircuitElement): number | undefined {
        return 42;
      },
    };

    const cmd = captureRuntimeToDefaults(circuit, mockAccess);
    cmd.execute();
    expect(element.getProperties().get<number>("value")).toBe(42);

    cmd.undo();
    expect(element.getProperties().get<number>("value")).toBe(0);
  });
});
