/**
 * Tests for mixed-mode circuit partitioning and compilation.
 *
 * Component engine types used in tests:
 *   - "AnalogResistor"  → engineType: "analog"
 *   - "DcVoltageSource" → engineType: "analog"
 *   - "Ground"          → engineType: "both"
 *   - "And"             → engineType: "both"
 *   - "Add"             → engineType: undefined (defaults to "digital")
 *   - "In" / "Out"      → used as interface elements
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Circuit, Wire } from "../../core/circuit.js";
import { createDefaultRegistry } from "../../components/register-all.js";
import { PropertyBag } from "../../core/properties.js";
import { detectEngineMode, partitionMixedCircuit } from "../mixed-partition.js";
import { DefaultSimulatorFacade } from "../../headless/default-facade.js";
import { pinWorldPosition } from "../../core/pin.js";
import type { ComponentRegistry } from "../../core/registry.js";
import type { CircuitElement } from "../../core/element.js";

let registry: ComponentRegistry;

beforeAll(() => {
  registry = createDefaultRegistry();
});

// ---------------------------------------------------------------------------
// Helper: create an element and place it at a position
// ---------------------------------------------------------------------------
function createElement(
  reg: ComponentRegistry,
  typeName: string,
  pos: { x: number; y: number },
  props?: Record<string, unknown>,
): CircuitElement {
  const def = reg.get(typeName);
  if (!def) throw new Error(`Unknown component type: ${typeName}`);
  const bag = new PropertyBag(
    Object.entries(props ?? {}) as [string, import("../../core/properties.js").PropertyValue][],
  );
  const el = def.factory(bag);
  (el as { position: { x: number; y: number } }).position = pos;
  return el;
}

// ---------------------------------------------------------------------------
// detectEngineMode
// ---------------------------------------------------------------------------
describe("detectEngineMode", () => {
  it("returns 'digital' for digital-only circuits", () => {
    const circuit = new Circuit({ engineType: "auto" });
    // Add is digital-only (no engineType → defaults to "digital")
    circuit.addElement(createElement(registry, "Add", { x: 5, y: 5 }));
    circuit.addElement(createElement(registry, "In", { x: 0, y: 0 }, { label: "A" }));
    expect(detectEngineMode(circuit, registry)).toBe("digital");
  });

  it("returns 'analog' for analog-only circuits", () => {
    const circuit = new Circuit({ engineType: "auto" });
    // AnalogResistor is engineType: "analog"
    circuit.addElement(createElement(registry, "AnalogResistor", { x: 5, y: 5 }));
    // DcVoltageSource is engineType: "analog"
    circuit.addElement(createElement(registry, "DcVoltageSource", { x: 5, y: 10 }));
    expect(detectEngineMode(circuit, registry)).toBe("analog");
  });

  it("returns 'mixed' when both analog-only and digital-only components are present", () => {
    const circuit = new Circuit({ engineType: "auto" });
    circuit.addElement(createElement(registry, "AnalogResistor", { x: 5, y: 5 }));
    // Add has no engineType → defaults to "digital"
    circuit.addElement(createElement(registry, "Add", { x: 10, y: 5 }));
    expect(detectEngineMode(circuit, registry)).toBe("mixed");
  });

  it("returns 'digital' for 'both'-only components", () => {
    const circuit = new Circuit({ engineType: "auto" });
    circuit.addElement(createElement(registry, "And", { x: 5, y: 5 }));
    // And has engineType "both" — not analog-only, not digital-only
    expect(detectEngineMode(circuit, registry)).toBe("digital");
  });

  it("returns 'analog' for mix of 'analog' and 'both'", () => {
    const circuit = new Circuit({ engineType: "auto" });
    circuit.addElement(createElement(registry, "AnalogResistor", { x: 5, y: 5 }));
    circuit.addElement(createElement(registry, "And", { x: 10, y: 5 }));
    // AnalogResistor is analog-only, And is "both" — no digital-only present
    expect(detectEngineMode(circuit, registry)).toBe("analog");
  });
});

// ---------------------------------------------------------------------------
// partitionMixedCircuit
// ---------------------------------------------------------------------------
describe("partitionMixedCircuit", () => {
  it("separates digital-only elements into the inner circuit", () => {
    const circuit = new Circuit({ engineType: "auto" });
    const resistor = createElement(registry, "AnalogResistor", { x: 5, y: 5 });
    const adder = createElement(registry, "Add", { x: 15, y: 5 });
    circuit.addElement(resistor);
    circuit.addElement(adder);

    const { analogCircuit, partition } = partitionMixedCircuit(circuit, registry);

    // Analog circuit has the resistor, inner has the adder
    expect(analogCircuit.elements).toContain(resistor);
    expect(analogCircuit.elements).not.toContain(adder);
    expect(partition.internalCircuit.elements).toContain(adder);
    expect(partition.internalCircuit.elements).not.toContain(resistor);
  });

  it("keeps 'both' components in the analog circuit", () => {
    const circuit = new Circuit({ engineType: "auto" });
    const andGate = createElement(registry, "And", { x: 5, y: 5 });
    const adder = createElement(registry, "Add", { x: 15, y: 5 });
    const resistor = createElement(registry, "AnalogResistor", { x: 0, y: 5 });
    circuit.addElement(andGate);
    circuit.addElement(adder);
    circuit.addElement(resistor);

    const { analogCircuit, partition } = partitionMixedCircuit(circuit, registry);

    expect(analogCircuit.elements).toContain(andGate);
    expect(analogCircuit.elements).toContain(resistor);
    expect(analogCircuit.elements).not.toContain(adder);
    expect(partition.internalCircuit.elements).toContain(adder);
  });

  it("creates cut points at nets connecting both domains", () => {
    const circuit = new Circuit({ engineType: "auto" });

    // AnalogResistor pins: A at {0,0}, B at {3,0} (relative)
    const resistor = createElement(registry, "AnalogResistor", { x: 5, y: 5 });
    // Add has input pins and output pin
    const adder = createElement(registry, "Add", { x: 15, y: 5 });
    circuit.addElement(resistor);
    circuit.addElement(adder);

    // Wire resistor pin B to adder's first input pin
    const rPins = resistor.getPins();
    const aPins = adder.getPins();
    if (rPins.length > 0 && aPins.length > 0) {
      const rPos = pinWorldPosition(resistor, rPins[rPins.length - 1]!);
      const aPos = pinWorldPosition(adder, aPins[0]!);
      circuit.addWire(new Wire(rPos, aPos));
    }

    const { partition } = partitionMixedCircuit(circuit, registry);

    // Should have at least one cut point
    expect(partition.cutPoints.length).toBeGreaterThan(0);
  });

  it("sets analogCircuit engineType to 'analog'", () => {
    const circuit = new Circuit({ engineType: "auto" });
    circuit.addElement(createElement(registry, "AnalogResistor", { x: 5, y: 5 }));
    circuit.addElement(createElement(registry, "Add", { x: 15, y: 5 }));

    const { analogCircuit } = partitionMixedCircuit(circuit, registry);
    expect(analogCircuit.metadata.engineType).toBe("analog");
  });

  it("sets inner circuit engineType to 'digital'", () => {
    const circuit = new Circuit({ engineType: "auto" });
    circuit.addElement(createElement(registry, "AnalogResistor", { x: 5, y: 5 }));
    circuit.addElement(createElement(registry, "Add", { x: 15, y: 5 }));

    const { partition } = partitionMixedCircuit(circuit, registry);
    expect(partition.internalCircuit.metadata.engineType).toBe("digital");
  });

  it("adds In/Out bridge elements to the inner circuit at cut points", () => {
    const circuit = new Circuit({ engineType: "auto" });
    const resistor = createElement(registry, "AnalogResistor", { x: 5, y: 5 });
    const adder = createElement(registry, "Add", { x: 15, y: 5 });
    circuit.addElement(resistor);
    circuit.addElement(adder);

    // Wire them together
    const rPins = resistor.getPins();
    const aPins = adder.getPins();
    if (rPins.length > 0 && aPins.length > 0) {
      const rPos = pinWorldPosition(resistor, rPins[rPins.length - 1]!);
      const aPos = pinWorldPosition(adder, aPins[0]!);
      circuit.addWire(new Wire(rPos, aPos));
    }

    const { partition } = partitionMixedCircuit(circuit, registry);

    // Inner circuit should have the adder + bridge In/Out elements
    const innerTypes = partition.internalCircuit.elements.map((e) => e.typeId);
    const hasIn = innerTypes.includes("In");
    const hasOut = innerTypes.includes("Out");
    expect(hasIn || hasOut).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: DefaultSimulatorFacade.compile() with auto mode
// ---------------------------------------------------------------------------
describe("DefaultSimulatorFacade auto-mode compilation", () => {
  it("compiles a pure digital circuit in auto mode", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "A", type: "In", props: { label: "A", bitWidth: 1 } },
        { id: "B", type: "In", props: { label: "B", bitWidth: 1 } },
        { id: "gate", type: "And" },
        { id: "Y", type: "Out", props: { label: "Y" } },
      ],
      connections: [
        ["A:out", "gate:In_1"],
        ["B:out", "gate:In_2"],
        ["gate:out", "Y:in"],
      ],
    });

    // Set to auto mode
    circuit.metadata = { ...circuit.metadata, engineType: "auto" };

    // Should compile without error (digital path)
    const engine = facade.compile(circuit);
    expect(engine).toBeDefined();
  });

  it("compiles a pure analog circuit in auto mode", () => {
    const facade = new DefaultSimulatorFacade(registry);

    // Build manually: V1(pos) → R1(A)—(B) → GND, V1(neg) → GND
    const circuit = new Circuit({ engineType: "auto" });
    const v1 = createElement(registry, "DcVoltageSource", { x: 0, y: 5 }, { label: "V1", voltage: 5 });
    const r1 = createElement(registry, "AnalogResistor", { x: 10, y: 5 }, { label: "R1", resistance: 1000 });
    const gnd = createElement(registry, "AnalogGround", { x: 10, y: 10 });
    circuit.addElement(v1);
    circuit.addElement(r1);
    circuit.addElement(gnd);

    // Wire: v1 neg → gnd, r1 B → gnd, v1 pos → r1 A (using pin world positions)
    const v1Pins = v1.getPins();
    const r1Pins = r1.getPins();
    const gndPins = gnd.getPins();
    const v1Neg = pinWorldPosition(v1, v1Pins.find(p => p.label === "neg")!);
    const v1Pos = pinWorldPosition(v1, v1Pins.find(p => p.label === "pos")!);
    const r1A = pinWorldPosition(r1, r1Pins.find(p => p.label === "A")!);
    const r1B = pinWorldPosition(r1, r1Pins.find(p => p.label === "B")!);
    const gndPin = pinWorldPosition(gnd, gndPins[0]!);

    circuit.addWire(new Wire(v1Pos, r1A));
    circuit.addWire(new Wire(r1B, gndPin));
    circuit.addWire(new Wire(v1Neg, gndPin));

    const engine = facade.compile(circuit);
    expect(engine).toBeDefined();
    // Should have used analog path
    expect(facade.getCompiledAnalog()).not.toBeNull();
  });
});
