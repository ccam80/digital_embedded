/**
 * Tests for analog compiler behavioral digital component support (Task 4a.5.1 + 4a.5.2).
 *
 * Verifies:
 * - Analog compiler accepts engineType "both" components with analogFactory
 * - Logic family resolution cascade: pin > component > circuit > default
 * - Pure-digital components in analog circuits produce unsupported-component-in-analog diagnostic
 * - simulationMode property handling: behavioral (default), digital stub, transistor stub
 */

import { describe, it, expect, vi } from "vitest";
import { Circuit, Wire } from "../../core/circuit.js";
import type { CircuitElement } from "../../core/element.js";
import type { Pin, PinDeclaration } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { PropertyValue } from "../../core/properties.js";
import type { Rect, RenderContext } from "../../core/renderer-interface.js";
import type { SerializedElement } from "../../core/element.js";
import { ComponentRegistry } from "../../core/registry.js";
import type { ComponentCategory } from "../../core/registry.js";
import type { AnalogElement } from "../element.js";
import type { SparseSolver } from "../sparse-solver.js";
import { compileAnalogCircuit } from "../compiler.js";
import { LOGIC_FAMILY_PRESETS, defaultLogicFamily } from "../../core/logic-family.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";

// ---------------------------------------------------------------------------
// Minimal CircuitElement factory
// ---------------------------------------------------------------------------

function makePin(x: number, y: number, label: string = ""): Pin {
  return {
    position: { x, y },
    label,
    direction: PinDirection.BIDIRECTIONAL,
    isInverted: false,
    isClock: false,
    bitWidth: 1,
  };
}

function makeElement(
  typeId: string,
  instanceId: string,
  pins: Array<{ x: number; y: number; label?: string }>,
  propsMap: Map<string, PropertyValue> = new Map(),
): CircuitElement {
  const resolvedPins = pins.map((p) => makePin(p.x, p.y, p.label ?? ""));
  const propertyBag = new PropertyBag(propsMap.entries());

  const serialized: SerializedElement = {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement["rotation"],
    mirror: false,
    properties: {},
  };

  return {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as CircuitElement["rotation"],
    mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) { /* no-op */ },
    serialize() { return serialized; },
    getHelpText() { return ""; },
    getAttribute(k: string) { return propsMap.get(k); },
  };
}

// ---------------------------------------------------------------------------
// Minimal AnalogElement factories
// ---------------------------------------------------------------------------

function makeStubElement(nodeIds: number[]): AnalogElement {
  return {
    nodeIndices: nodeIds,
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(_s: SparseSolver) { /* no-op */ },
  };
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function noopExecuteFn(): void { /* no-op */ }

function makeBaseDef(name: string) {
  return {
    name,
    typeId: -1,
    executeFn: noopExecuteFn as unknown as import("../../core/registry.js").ExecuteFunction,
    pinLayout: [] as PinDeclaration[],
    propertyDefs: [] as import("../../core/properties.js").PropertyDefinition[],
    attributeMap: [] as import("../../core/registry.js").AttributeMapping[],
    category: "MISC" as unknown as ComponentCategory,
    helpText: "",
    factory: ((_props: PropertyBag) => { throw new Error("not used in tests"); }) as unknown as import("../../core/registry.js").ComponentDefinition["factory"],
  };
}

function makeGatePinLayout(inputCount: number): PinDeclaration[] {
  const pins: PinDeclaration[] = [];
  for (let i = 1; i <= inputCount; i++) {
    pins.push({
      label: `In_${i}`,
      direction: PinDirection.INPUT,
      bitWidth: 1,
      position: { x: 0, y: i },
    });
  }
  pins.push({
    label: "out",
    direction: PinDirection.OUTPUT,
    bitWidth: 1,
    position: { x: 2, y: 1 },
  });
  return pins;
}

/**
 * Build a registry with a Ground, a "both"-engineType AND gate, and a digital-only gate.
 */
function buildBehavioralRegistry(factorySpy?: ReturnType<typeof vi.fn>): ComponentRegistry {
  const registry = new ComponentRegistry();

  registry.register({
    ...makeBaseDef("Ground"),
    engineType: "analog" as const,
  });

  const andFactory = factorySpy ?? vi.fn((nodeIds: number[]) => makeStubElement(nodeIds));

  registry.register({
    ...makeBaseDef("BehavioralAnd"),
    engineType: "both" as const,
    pinLayout: makeGatePinLayout(2),
    simulationModes: ["digital", "behavioral"] as const,
    analogFactory: andFactory as unknown as import("../../core/registry.js").ComponentDefinition["analogFactory"],
  });

  // Digital-only gate (no analogFactory, no engineType → defaults to "digital")
  registry.register({
    ...makeBaseDef("DigitalOnlyGate"),
    // no engineType → "digital"
  });

  return registry;
}

/**
 * Build a simple analog circuit: two input nodes → AND gate → output node → Ground.
 * Wire layout uses integer grid coordinates.
 *
 *  node 1 (x=10): AND input 1
 *  node 2 (x=20): AND input 2
 *  node 3 (x=30): AND output
 *  node 0 (x=0):  ground
 */
function buildAndGateCircuit(propsMap: Map<string, PropertyValue> = new Map()): {
  circuit: Circuit;
  registry: ComponentRegistry;
  factorySpy: ReturnType<typeof vi.fn>;
} {
  const circuit = new Circuit({ engineType: "analog" });
  const factorySpy = vi.fn((nodeIds: number[]) => makeStubElement(nodeIds));
  const registry = buildBehavioralRegistry(factorySpy);

  const andGate = makeElement("BehavioralAnd", "and1", [
    { x: 10, y: 0, label: "In_1" },
    { x: 20, y: 0, label: "In_2" },
    { x: 30, y: 0, label: "out" },
  ], propsMap);
  const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }]);

  circuit.addElement(andGate);
  circuit.addElement(gnd);

  circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
  circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));
  circuit.addWire(new Wire({ x: 30, y: 0 }, { x: 30, y: 0 }));
  circuit.addWire(new Wire({ x: 0,  y: 0 }, { x: 0,  y: 0 }));

  return { circuit, registry, factorySpy };
}

// ---------------------------------------------------------------------------
// BehavioralCompilation tests
// ---------------------------------------------------------------------------

describe("BehavioralCompilation", () => {
  it("compiles_and_gate_in_analog_circuit", () => {
    const { circuit, registry } = buildAndGateCircuit();
    const compiled = compileAnalogCircuit(circuit, registry);

    // AND gate compiled as one behavioral analog element; no errors
    expect(compiled.elements.length).toBe(1);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("resolves_logic_family_defaults", () => {
    const { circuit, registry, factorySpy } = buildAndGateCircuit();
    compileAnalogCircuit(circuit, registry);

    expect(factorySpy).toHaveBeenCalledOnce();
    const [, , props] = factorySpy.mock.calls[0]!;
    const propsTyped = props as PropertyBag;

    // _pinElectrical should be injected with CMOS 3.3V defaults
    expect(propsTyped.has("_pinElectrical")).toBe(true);
    const pinElec = propsTyped.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>;

    // Check In_1 pin electrical has CMOS 3.3V values
    expect(pinElec["In_1"]).toBeDefined();
    expect(pinElec["In_1"]!.vIH).toBe(2.0);
    expect(pinElec["In_1"]!.vOH).toBe(3.3);
    expect(pinElec["out"]).toBeDefined();
    expect(pinElec["out"]!.vOH).toBe(3.3);
  });

  it("respects_circuit_logic_family", () => {
    const ttlFamily = LOGIC_FAMILY_PRESETS["ttl"];
    const circuit = new Circuit({
      engineType: "analog",
      logicFamily: ttlFamily,
    });

    const factorySpy = vi.fn((nodeIds: number[]) => makeStubElement(nodeIds));
    const registry = buildBehavioralRegistry(factorySpy);

    const andGate = makeElement("BehavioralAnd", "and1", [
      { x: 10, y: 0, label: "In_1" },
      { x: 20, y: 0, label: "In_2" },
      { x: 30, y: 0, label: "out" },
    ]);
    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }]);
    circuit.addElement(andGate);
    circuit.addElement(gnd);
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));
    circuit.addWire(new Wire({ x: 30, y: 0 }, { x: 30, y: 0 }));
    circuit.addWire(new Wire({ x: 0,  y: 0 }, { x: 0,  y: 0 }));

    compileAnalogCircuit(circuit, registry);

    expect(factorySpy).toHaveBeenCalledOnce();
    const [, , props] = factorySpy.mock.calls[0]!;
    const propsTyped = props as PropertyBag;

    const pinElec = propsTyped.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>;
    // TTL values: vIH=2.0, vOH=3.4
    expect(pinElec["In_1"]!.vIH).toBe(2.0);
    expect(pinElec["In_1"]!.vOH).toBe(3.4);
    expect(pinElec["out"]!.vOH).toBe(3.4);
  });

  it("digital_only_component_emits_diagnostic", () => {
    const circuit = new Circuit({ engineType: "analog" });
    const registry = new ComponentRegistry();

    registry.register({
      ...makeBaseDef("Ground"),
      engineType: "analog" as const,
    });

    // Digital-only component — no engineType means "digital"
    registry.register({
      ...makeBaseDef("PureDigital"),
      // no engineType → defaults to "digital"
    });

    const digitalComp = makeElement("PureDigital", "d1", [{ x: 10, y: 0 }]);
    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }]);

    circuit.addElement(digitalComp);
    circuit.addElement(gnd);
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 0,  y: 0 }, { x: 0,  y: 0 }));

    // Compiler should not throw — emits diagnostic instead
    expect(() => compileAnalogCircuit(circuit, registry)).not.toThrow();
    const compiled = compileAnalogCircuit(circuit, registry);
    const errorDiags = compiled.diagnostics.filter(
      (d) => d.code === "unsupported-component-in-analog",
    );
    expect(errorDiags).toHaveLength(1);
    expect(errorDiags[0]!.severity).toBe("error");
  });

  it("pin_override_applied", () => {
    const circuit = new Circuit({ engineType: "analog" });

    const factorySpy = vi.fn((nodeIds: number[]) => makeStubElement(nodeIds));
    const registry = new ComponentRegistry();

    registry.register({
      ...makeBaseDef("Ground"),
      engineType: "analog" as const,
    });

    // Register a gate with per-pin rOut override on "out" pin
    registry.register({
      ...makeBaseDef("HighDriveAnd"),
      engineType: "both" as const,
      pinLayout: makeGatePinLayout(2),
      simulationModes: ["digital", "behavioral"] as const,
      pinElectricalOverrides: {
        out: { rOut: 25 },
      },
      analogFactory: factorySpy as unknown as import("../../core/registry.js").ComponentDefinition["analogFactory"],
    });

    const andGate = makeElement("HighDriveAnd", "and1", [
      { x: 10, y: 0, label: "In_1" },
      { x: 20, y: 0, label: "In_2" },
      { x: 30, y: 0, label: "out" },
    ]);
    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }]);

    circuit.addElement(andGate);
    circuit.addElement(gnd);
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));
    circuit.addWire(new Wire({ x: 30, y: 0 }, { x: 30, y: 0 }));
    circuit.addWire(new Wire({ x: 0,  y: 0 }, { x: 0,  y: 0 }));

    compileAnalogCircuit(circuit, registry);

    expect(factorySpy).toHaveBeenCalledOnce();
    const [, , props] = factorySpy.mock.calls[0]!;
    const propsTyped = props as PropertyBag;

    const pinElec = propsTyped.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>;
    // "out" pin override: rOut=25 (not family default 50)
    expect(pinElec["out"]!.rOut).toBe(25);
    // Input pins should still use family default rIn
    expect(pinElec["In_1"]!.rIn).toBe(defaultLogicFamily().rIn);
  });
});

// ---------------------------------------------------------------------------
// SimulationMode tests (Task 4a.5.2)
// ---------------------------------------------------------------------------

describe("SimulationMode", () => {
  it("default_is_behavioral", () => {
    // No simulationMode property set → defaults to 'behavioral' → compiles normally
    const { circuit, registry, factorySpy } = buildAndGateCircuit();
    compileAnalogCircuit(circuit, registry);
    // Factory called = compiled as behavioral analog element
    expect(factorySpy).toHaveBeenCalledOnce();
  });

  it("explicit_behavioral_compiles", () => {
    // simulationMode explicitly set to 'behavioral' → compiles normally
    const propsMap = new Map<string, PropertyValue>([["simulationMode", "behavioral"]]);
    const { circuit, registry, factorySpy } = buildAndGateCircuit(propsMap);
    const compiled = compileAnalogCircuit(circuit, registry);
    expect(factorySpy).toHaveBeenCalledOnce();
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("digital_mode_emits_stub_diagnostic", () => {
    const propsMap = new Map<string, PropertyValue>([["simulationMode", "digital"]]);
    const { circuit, registry, factorySpy } = buildAndGateCircuit(propsMap);
    const compiled = compileAnalogCircuit(circuit, registry);

    // Factory should NOT be called (component is skipped)
    expect(factorySpy).not.toHaveBeenCalled();

    // Should emit info diagnostic
    const stubDiags = compiled.diagnostics.filter(
      (d) => d.code === "digital-bridge-not-yet-implemented",
    );
    expect(stubDiags).toHaveLength(1);
    expect(stubDiags[0]!.severity).toBe("info");
  });

  it("transistor_mode_without_registry_emits_diagnostic", () => {
    const propsMap = new Map<string, PropertyValue>([["simulationMode", "transistor"]]);
    const { circuit, registry, factorySpy } = buildAndGateCircuit(propsMap);
    const compiled = compileAnalogCircuit(circuit, registry);

    // Factory should NOT be called (component is skipped — no registry supplied)
    expect(factorySpy).not.toHaveBeenCalled();

    // Should emit missing-transistor-model error when no TransistorModelRegistry is passed
    const errorDiags = compiled.diagnostics.filter(
      (d) => d.code === "missing-transistor-model",
    );
    expect(errorDiags).toHaveLength(1);
    expect(errorDiags[0]!.severity).toBe("error");
  });
});
