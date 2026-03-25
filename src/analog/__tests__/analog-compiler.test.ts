/**
 * Tests for analog compiler behavioral digital component support (Task 4a.5.1 + 4a.5.2).
 *
 * Verifies:
 * - Analog compiler accepts components with both digital and analog models
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
    pinNodeIds: nodeIds,
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
    pinLayout: [] as PinDeclaration[],
    propertyDefs: [] as import("../../core/properties.js").PropertyDefinition[],
    attributeMap: [] as import("../../core/registry.js").AttributeMapping[],
    category: "MISC" as unknown as ComponentCategory,
    helpText: "",
    factory: ((_props: PropertyBag) => makeElement(name, crypto.randomUUID(), [])) as unknown as import("../../core/registry.js").ComponentDefinition["factory"],
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
 * Build a registry with a Ground, a dual-model (digital+analog) AND gate, and a digital-only gate.
 */
function buildBehavioralRegistry(factorySpy?: ReturnType<typeof vi.fn>): ComponentRegistry {
  const registry = new ComponentRegistry();

  registry.register({
    ...makeBaseDef("Ground"),
    models: { analog: {} },
  });

  const andFactory = factorySpy ?? vi.fn((pinNodes: ReadonlyMap<string, number>) => makeStubElement([...pinNodes.values()]));

  registry.register({
    ...makeBaseDef("BehavioralAnd"),
    pinLayout: makeGatePinLayout(2),
    models: {
      digital: { executeFn: noopExecuteFn as unknown as import("../../core/registry.js").ExecuteFunction },
      analog: { factory: andFactory as unknown as import("../../core/registry.js").AnalogModel["factory"] },
    },
    defaultModel: "digital",
  });

  // Digital-only gate
  registry.register({
    ...makeBaseDef("DigitalOnlyGate"),
    models: { digital: { executeFn: noopExecuteFn as unknown as import("../../core/registry.js").ExecuteFunction } },
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
  const factorySpy = vi.fn((pinNodes: ReadonlyMap<string, number>) => makeStubElement([...pinNodes.values()]));
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
    const propsMap = new Map<string, PropertyValue>([["simulationMode", "analog-pins"]]);
    const { circuit, registry } = buildAndGateCircuit(propsMap);
    const compiled = compileAnalogCircuit(circuit, registry);

    // AND gate compiled as one behavioral analog element; no errors
    expect(compiled.elements.length).toBe(1);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("resolves_logic_family_defaults", () => {
    const propsMap = new Map<string, PropertyValue>([["simulationMode", "analog-pins"]]);
    const { circuit, registry, factorySpy } = buildAndGateCircuit(propsMap);
    compileAnalogCircuit(circuit, registry);

    expect(factorySpy).toHaveBeenCalledOnce();
    const [, , , props] = factorySpy.mock.calls[0]!;
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

    const factorySpy = vi.fn((pinNodes: ReadonlyMap<string, number>) => makeStubElement([...pinNodes.values()]));
    const registry = buildBehavioralRegistry(factorySpy);

    const andGate = makeElement("BehavioralAnd", "and1", [
      { x: 10, y: 0, label: "In_1" },
      { x: 20, y: 0, label: "In_2" },
      { x: 30, y: 0, label: "out" },
    ], new Map<string, PropertyValue>([["simulationMode", "analog-pins"]]));
    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }]);
    circuit.addElement(andGate);
    circuit.addElement(gnd);
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));
    circuit.addWire(new Wire({ x: 30, y: 0 }, { x: 30, y: 0 }));
    circuit.addWire(new Wire({ x: 0,  y: 0 }, { x: 0,  y: 0 }));

    compileAnalogCircuit(circuit, registry);

    expect(factorySpy).toHaveBeenCalledOnce();
    const [, , , props] = factorySpy.mock.calls[0]!;
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
      models: { analog: {} },
    });

    // Digital-only component — only digital model, no analog
    registry.register({
      ...makeBaseDef("PureDigital"),
      models: { digital: { executeFn: noopExecuteFn as unknown as import("../../core/registry.js").ExecuteFunction } },
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

    const factorySpy = vi.fn((pinNodes: ReadonlyMap<string, number>) => makeStubElement([...pinNodes.values()]));
    const registry = new ComponentRegistry();

    registry.register({
      ...makeBaseDef("Ground"),
      models: { analog: {} },
    });

    // Register a gate with per-pin rOut override on "out" pin
    registry.register({
      ...makeBaseDef("HighDriveAnd"),
      pinLayout: makeGatePinLayout(2),
      models: {
        digital: { executeFn: noopExecuteFn as unknown as import("../../core/registry.js").ExecuteFunction },
        analog: {
          factory: factorySpy as unknown as import("../../core/registry.js").AnalogModel["factory"],
          pinElectricalOverrides: {
            out: { rOut: 25 },
          },
        },
      },
    });

    const andGate = makeElement("HighDriveAnd", "and1", [
      { x: 10, y: 0, label: "In_1" },
      { x: 20, y: 0, label: "In_2" },
      { x: 30, y: 0, label: "out" },
    ], new Map<string, PropertyValue>([["simulationMode", "analog-pins"]]));
    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }]);

    circuit.addElement(andGate);
    circuit.addElement(gnd);
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));
    circuit.addWire(new Wire({ x: 30, y: 0 }, { x: 30, y: 0 }));
    circuit.addWire(new Wire({ x: 0,  y: 0 }, { x: 0,  y: 0 }));

    compileAnalogCircuit(circuit, registry);

    expect(factorySpy).toHaveBeenCalledOnce();
    const [, , , props] = factorySpy.mock.calls[0]!;
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
  it("default_is_first_simulationMode_entry", () => {
    // No simulationMode property set → defaults based on defaultModel.
    // BehavioralAnd has defaultModel: 'digital', so default mode is 'logical'.
    // Set mode to 'analog-pins' explicitly and
    // verify the factory IS called — proving that without the explicit
    // property the compiler would NOT have taken the analog-pins path.
    const analogPinsProps = new Map<string, PropertyValue>([["simulationMode", "analog-pins"]]);
    const { circuit: c1, registry: r1, factorySpy: spy1 } = buildAndGateCircuit(analogPinsProps);
    compileAnalogCircuit(c1, r1);
    expect(spy1).toHaveBeenCalledOnce(); // explicit analog-pins → factory called

    // Without simulationMode set, default is 'logical' → factory NOT called
    const { circuit: c2, registry: r2, factorySpy: spy2 } = buildAndGateCircuit();
    // The logical path needs In/Out in the registry to synthesize a bridge;
    // with the stub registry it emits diagnostics but still doesn't call analogFactory.
    compileAnalogCircuit(c2, r2);
    expect(spy2).not.toHaveBeenCalled();
  });

  it("explicit_simplified_compiles", () => {
    // simulationMode explicitly set to 'analog-pins' → compiles normally
    const propsMap = new Map<string, PropertyValue>([["simulationMode", "analog-pins"]]);
    const { circuit, registry, factorySpy } = buildAndGateCircuit(propsMap);
    const compiled = compileAnalogCircuit(circuit, registry);
    expect(factorySpy).toHaveBeenCalledOnce();
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("digital_mode_creates_bridge_instance", () => {
    // simulationMode: "logical" synthesizes an inner digital circuit and
    // creates a BridgeInstance — the analogFactory is NOT called.

    // Build a fresh registry that includes In, Out, Ground, and BehavioralAnd
    // with a working factory (needed by synthesizeDigitalCircuit).
    const registry = new ComponentRegistry();
    const factorySpy = vi.fn();

    // Helper: make a minimal element stub for a given typeId and pin list
    function makeStubElFactory(typeId: string, pinsFn: (props: PropertyBag) => Pin[]) {
      return (props: PropertyBag): CircuitElement => ({
        typeId,
        instanceId: crypto.randomUUID(),
        position: { x: 0, y: 0 },
        rotation: 0 as const,
        mirror: false,
        getPins() { return pinsFn(props); },
        getProperties() { return props; },
        getAttribute(k: string) { return props.has(k) ? props.get(k) : undefined; },
        draw() {},
        getBoundingBox() { return { x: 0, y: 0, width: 4, height: 4 }; },
        serialize() { return { typeId, instanceId: this.instanceId, position: this.position, rotation: 0, mirror: false, properties: {} }; },
        getHelpText() { return ""; },
      } as unknown as CircuitElement);
    }

    registry.register({
      ...makeBaseDef("Ground"),
      models: { analog: {} },
    });

    registry.register({
      ...makeBaseDef("In"),
      factory: makeStubElFactory("In", (props) => [{
        direction: PinDirection.OUTPUT,
        position: { x: 0, y: 0 },
        label: "out",
        bitWidth: props.getOrDefault<number>("bitWidth", 1),
        isNegated: false,
        isClock: false,
      }]),
      pinLayout: [{ label: "out", direction: PinDirection.OUTPUT, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false }],
      propertyDefs: [{ key: "label", defaultValue: "" }, { key: "bitWidth", defaultValue: 1 }],
      models: { digital: { executeFn: noopExecuteFn as unknown as import("../../core/registry.js").ExecuteFunction } },
    });

    registry.register({
      ...makeBaseDef("Out"),
      factory: makeStubElFactory("Out", (props) => [{
        direction: PinDirection.INPUT,
        position: { x: 0, y: 0 },
        label: "in",
        bitWidth: props.getOrDefault<number>("bitWidth", 1),
        isNegated: false,
        isClock: false,
      }]),
      pinLayout: [{ label: "in", direction: PinDirection.INPUT, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false }],
      propertyDefs: [{ key: "label", defaultValue: "" }, { key: "bitWidth", defaultValue: 1 }],
      models: { digital: { executeFn: noopExecuteFn as unknown as import("../../core/registry.js").ExecuteFunction } },
    });

    registry.register({
      ...makeBaseDef("BehavioralAnd"),
      pinLayout: makeGatePinLayout(2),
      factory: makeStubElFactory("BehavioralAnd", (_props) => [
        { direction: PinDirection.INPUT,  position: { x: 0, y: 1 }, label: "In_1", bitWidth: 1, isNegated: false, isClock: false },
        { direction: PinDirection.INPUT,  position: { x: 0, y: 2 }, label: "In_2", bitWidth: 1, isNegated: false, isClock: false },
        { direction: PinDirection.OUTPUT, position: { x: 2, y: 1 }, label: "out",  bitWidth: 1, isNegated: false, isClock: false },
      ]),
      models: {
        digital: { executeFn: noopExecuteFn as unknown as import("../../core/registry.js").ExecuteFunction },
        analog: { factory: factorySpy as unknown as import("../../core/registry.js").AnalogModel["factory"] },
      },
    });

    // Build the outer analog circuit with the AND gate set to simulationMode: "logical"
    const propsMap = new Map<string, PropertyValue>([["simulationMode", "logical"]]);
    const circuit = new Circuit({ engineType: "analog" });

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

    const compiled = compileAnalogCircuit(circuit, registry);

    // analogFactory should NOT be called — bridge path bypasses it
    expect(factorySpy).not.toHaveBeenCalled();

    // Should produce exactly one bridge instance for the digital component
    expect(compiled.bridges).toHaveLength(1);
    const bridge = compiled.bridges[0]!;
    expect(bridge.compiledInner).toBeDefined();

    // BehavioralAnd has 2 inputs and 1 output
    expect(bridge.inputAdapters).toHaveLength(2);
    expect(bridge.outputAdapters).toHaveLength(1);

    // No errors
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("analog_internals_with_transistorModel_but_no_registry_emits_diagnostic", () => {
    const propsMap = new Map<string, PropertyValue>([["simulationMode", "analog-internals"]]);
    const { circuit, registry, factorySpy } = buildAndGateCircuit(propsMap);
    // Add transistorModel to the registered definition so the transistor path is triggered
    const def = registry.get("BehavioralAnd")!;
    registry.update({
      ...def,
      models: {
        ...def.models,
        analog: { ...def.models.analog, transistorModel: "CmosAnd2" },
      },
    });

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

  it("analog_internals_without_transistorModel_falls_through_to_analogFactory", () => {
    // Fuse/switch case: analog-internals but no transistorModel → use analogFactory
    const propsMap = new Map<string, PropertyValue>([["simulationMode", "analog-internals"]]);
    const { circuit, registry, factorySpy } = buildAndGateCircuit(propsMap);
    const compiled = compileAnalogCircuit(circuit, registry);

    // Factory SHOULD be called — falls through to analogFactory path
    expect(factorySpy).toHaveBeenCalledOnce();
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });
});
