/**
 * Tests for auto-power.ts — Auto Power Supply tool.
 */

import { describe, it, expect } from "vitest";
import { findUnconnectedPowerPins, autoConnectPower } from "@/editor/auto-power";
import { Circuit, Wire } from "@/core/circuit";
import { AbstractCircuitElement } from "@/core/element";
import { PinDirection } from "@/core/pin";
import { PropertyBag } from "@/core/properties";
import type { Pin, Rotation } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { SerializedElement } from "@/core/element";

// ---------------------------------------------------------------------------
// Stub element builder
// ---------------------------------------------------------------------------

let _idCounter = 0;

function makeElementWithPins(
  posX: number,
  posY: number,
  pins: Pin[],
): InstanceType<typeof AbstractCircuitElement> {
  const id = `el-${++_idCounter}`;
  const props = new PropertyBag();
  const capturedPins = pins;

  return new (class extends AbstractCircuitElement {
    constructor() {
      super("StubComp", id, { x: posX, y: posY }, 0 as Rotation, false, props);
    }
    getPins(): readonly Pin[] {
      return capturedPins;
    }
    draw(_ctx: RenderContext): void {}
    getBoundingBox(): Rect {
      return { x: this.position.x, y: this.position.y, width: 2, height: 2 };
    }
    getHelpText(): string {
      return "stub";
    }
    serialize(): SerializedElement {
      return {} as SerializedElement;
    }
  })();
}

function makePin(label: string, relX: number, relY: number): Pin {
  return {
    direction: PinDirection.INPUT,
    position: { x: relX, y: relY },
    label,
    bitWidth: 1,
    isNegated: false,
    isClock: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AutoPower", () => {
  describe("findsUnconnectedPowerPins", () => {
    it("returns unconnected VDD pin when no wire touches it", () => {
      const circuit = new Circuit();
      const vddPin = makePin("VDD", 0, 0);
      const el = makeElementWithPins(5, 3, [vddPin]);
      circuit.addElement(el);

      const results = findUnconnectedPowerPins(circuit);

      expect(results).toHaveLength(1);
      expect(results[0]!.element).toBe(el);
      expect(results[0]!.pin.label).toBe("VDD");
    });

    it("returns unconnected GND pin when no wire touches it", () => {
      const circuit = new Circuit();
      const gndPin = makePin("GND", 1, 2);
      const el = makeElementWithPins(0, 0, [gndPin]);
      circuit.addElement(el);

      const results = findUnconnectedPowerPins(circuit);

      expect(results).toHaveLength(1);
      expect(results[0]!.pin.label).toBe("GND");
    });

    it("returns multiple power pins from multiple elements", () => {
      const circuit = new Circuit();
      const el1 = makeElementWithPins(0, 0, [makePin("VDD", 0, 0)]);
      const el2 = makeElementWithPins(10, 0, [makePin("GND", 0, 2)]);
      circuit.addElement(el1);
      circuit.addElement(el2);

      const results = findUnconnectedPowerPins(circuit);

      expect(results).toHaveLength(2);
    });

    it("ignores non-power pins", () => {
      const circuit = new Circuit();
      const el = makeElementWithPins(0, 0, [makePin("A", 0, 0), makePin("OUT", 2, 1)]);
      circuit.addElement(el);

      const results = findUnconnectedPowerPins(circuit);

      expect(results).toHaveLength(0);
    });
  });

  describe("skipsAlreadyConnected", () => {
    it("does not include VDD pin that has a wire endpoint at its world position", () => {
      const circuit = new Circuit();
      const vddPin = makePin("VDD", 2, 0);
      const el = makeElementWithPins(3, 4, [vddPin]);
      circuit.addElement(el);

      // World position of pin: (3+2, 4+0) = (5, 4)
      const wire = new Wire({ x: 5, y: 4 }, { x: 5, y: 6 });
      circuit.addWire(wire);

      const results = findUnconnectedPowerPins(circuit);

      expect(results).toHaveLength(0);
    });

    it("does not include GND pin connected via wire end endpoint", () => {
      const circuit = new Circuit();
      const gndPin = makePin("GND", 0, 3);
      const el = makeElementWithPins(2, 2, [gndPin]);
      circuit.addElement(el);

      // World position: (2+0, 2+3) = (2, 5)
      const wire = new Wire({ x: 0, y: 0 }, { x: 2, y: 5 });
      circuit.addWire(wire);

      const results = findUnconnectedPowerPins(circuit);

      expect(results).toHaveLength(0);
    });

    it("includes pin that has a wire nearby but not touching it", () => {
      const circuit = new Circuit();
      const vddPin = makePin("VDD", 0, 0);
      const el = makeElementWithPins(5, 5, [vddPin]);
      circuit.addElement(el);

      // Wire endpoint is at (5, 6) — one unit away from pin at (5, 5)
      const wire = new Wire({ x: 5, y: 6 }, { x: 5, y: 10 });
      circuit.addWire(wire);

      const results = findUnconnectedPowerPins(circuit);

      expect(results).toHaveLength(1);
    });
  });

  describe("addsVddAndGnd", () => {
    it("adds a VDD element and wire for an unconnected VDD pin", () => {
      const circuit = new Circuit();
      const vddPin = makePin("VDD", 0, 0);
      const el = makeElementWithPins(5, 5, [vddPin]);
      circuit.addElement(el);

      const cmd = autoConnectPower(circuit);
      cmd.execute();

      // Should have added one element (VDD supply) and one wire
      expect(circuit.elements).toHaveLength(2);
      expect(circuit.wires).toHaveLength(1);

      const addedEl = circuit.elements.find((e) => e.typeId === "VDD");
      expect(addedEl).toBeDefined();
      expect(addedEl!.typeId).toBe("VDD");
    });

    it("adds a GND element and wire for an unconnected GND pin", () => {
      const circuit = new Circuit();
      const gndPin = makePin("GND", 0, 0);
      const el = makeElementWithPins(3, 3, [gndPin]);
      circuit.addElement(el);

      const cmd = autoConnectPower(circuit);
      cmd.execute();

      expect(circuit.elements).toHaveLength(2);
      expect(circuit.wires).toHaveLength(1);

      const addedEl = circuit.elements.find((e) => e.typeId === "GND");
      expect(addedEl).toBeDefined();
    });

    it("connects the wire to the original pin world position", () => {
      const circuit = new Circuit();
      // Pin at relative (1, 0), element at (4, 6) → world pin at (5, 6)
      const vddPin = makePin("VDD", 1, 0);
      const el = makeElementWithPins(4, 6, [vddPin]);
      circuit.addElement(el);

      const cmd = autoConnectPower(circuit);
      cmd.execute();

      const wire = circuit.wires[0]!;
      const connectsToPin =
        (wire.start.x === 5 && wire.start.y === 6) ||
        (wire.end.x === 5 && wire.end.y === 6);
      expect(connectsToPin).toBe(true);
    });

    it("handles multiple unconnected power pins", () => {
      const circuit = new Circuit();
      const el1 = makeElementWithPins(0, 0, [makePin("VDD", 0, 0)]);
      const el2 = makeElementWithPins(10, 0, [makePin("GND", 0, 0)]);
      circuit.addElement(el1);
      circuit.addElement(el2);

      const cmd = autoConnectPower(circuit);
      cmd.execute();

      // 2 original + 2 supply elements
      expect(circuit.elements).toHaveLength(4);
      expect(circuit.wires).toHaveLength(2);
    });

    it("is undoable — removes added elements and wires on undo", () => {
      const circuit = new Circuit();
      const vddPin = makePin("VDD", 0, 0);
      const el = makeElementWithPins(5, 5, [vddPin]);
      circuit.addElement(el);

      const cmd = autoConnectPower(circuit);
      cmd.execute();

      expect(circuit.elements).toHaveLength(2);
      expect(circuit.wires).toHaveLength(1);

      cmd.undo();

      expect(circuit.elements).toHaveLength(1);
      expect(circuit.elements[0]).toBe(el);
      expect(circuit.wires).toHaveLength(0);
    });

    it("does nothing when no power pins are unconnected", () => {
      const circuit = new Circuit();
      const el = makeElementWithPins(0, 0, [makePin("A", 0, 0)]);
      circuit.addElement(el);

      const cmd = autoConnectPower(circuit);
      cmd.execute();

      expect(circuit.elements).toHaveLength(1);
      expect(circuit.wires).toHaveLength(0);
    });

    it("skips power pins that are already connected during execute", () => {
      const circuit = new Circuit();
      const vddPin = makePin("VDD", 0, 0);
      const el = makeElementWithPins(5, 5, [vddPin]);
      circuit.addElement(el);

      // Pre-connect the pin
      const existingWire = new Wire({ x: 5, y: 5 }, { x: 5, y: 8 });
      circuit.addWire(existingWire);

      const cmd = autoConnectPower(circuit);
      cmd.execute();

      // No new elements or wires should be added
      expect(circuit.elements).toHaveLength(1);
      expect(circuit.wires).toHaveLength(1);
    });

    it("command has correct description", () => {
      const circuit = new Circuit();
      const cmd = autoConnectPower(circuit);
      expect(cmd.description).toBe("Auto Power Supply");
    });
  });
});
