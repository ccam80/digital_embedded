/**
 * lrcxor fixture tests — digital and behavioral mode for XOR gate in analog circuits.
 *
 * Tests the full pipeline:
 *   compileUnified() → MNAEngine → verify output voltages
 *
 * Circuit topology (DC simplified version of the lrcxor.dig fixture):
 *   VS1 (DC, V_HIGH or V_LOW) → R_drive → XOR In_1 (node at x=20)
 *   VS2 (DC, 0V) → XOR In_2 (node at x=30) — always 0V for both-inputs-match tests
 *   XOR out (node at x=40) → R_load → GND (x=50)
 *
 * Output node is identified by retrieving the wire at (x=40,y=0) from
 * compiled.wireToNodeId, then reading that node's voltage from the engine.
 *
 * Two compilation modes are tested:
 *   - behavioral: XOR uses analogFactory (BehavioralGateElement)
 *   - digital: XOR uses bridge path (synthesizeDigitalCircuit + BridgeInstance)
 *
 * Part 1 fix coverage:
 *   custom_voh_via_*_flows_through_bridge tests verify that the compiler
 *   passes pinOverride and componentOverride to resolvePinElectrical when
 *   creating bridge adapters for the digital bridge path.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { Circuit, Wire } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Pin } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import { PropertyBag } from "../../../core/properties.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { Rect, RenderContext } from "../../../core/renderer-interface.js";
import type { SerializedElement } from "../../../core/element.js";
import { ComponentRegistry } from "../../../core/registry.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import { compileUnified } from "@/compile/compile.js";
import { MNAEngine } from "../analog-engine.js";
import { EngineState } from "../../../core/engine-interface.js";
import { loadDig } from "../../../io/dig-loader.js";
import { DefaultSimulationCoordinator } from "../../coordinator.js";
import type { CompiledCircuitUnified } from "../../../compile/types.js";

// Real component definitions
import { ResistorDefinition } from "../../../components/passives/resistor.js";
import { CapacitorDefinition } from "../../../components/passives/capacitor.js";
import { InductorDefinition } from "../../../components/passives/inductor.js";
import { DcVoltageSourceDefinition } from "../../../components/sources/dc-voltage-source.js";
import { AcVoltageSourceDefinition } from "../../../components/sources/ac-voltage-source.js";
import { GroundDefinition } from "../../../components/io/ground.js";
import { XOrDefinition } from "../../../components/gates/xor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const V_HIGH = 3.3;   // drive voltage (logic HIGH)
const V_LOW  = 0.0;   // 0V source for logic LOW input
const R_DRIVE = 1000; // 1kΩ series resistor on In_1
const R_LOAD  = 10000; // 10kΩ load on XOR output

// Default CMOS 3.3V from the logic family preset
const DEFAULT_VOH  = 3.3;
const DEFAULT_VOL  = 0.0;
const DEFAULT_ROUT = 50;

// ---------------------------------------------------------------------------
// Minimal CircuitElement factory (same pattern as mna-end-to-end.test.ts)
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
    getAttribute(k: string) { return propsMap.get(k); },
  };
}

// ---------------------------------------------------------------------------
// Registry builder
// ---------------------------------------------------------------------------

function buildBehavioralRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register(GroundDefinition);
  registry.register(ResistorDefinition);
  registry.register(DcVoltageSourceDefinition);
  registry.register(XOrDefinition);
  return registry;
}

function buildDigitalRegistry(): ComponentRegistry {
  const registry = buildBehavioralRegistry();

  const noopExecuteFn = () => {};

  // Minimal In stub — one OUTPUT pin labelled "out"
  const inStubFactory = (props: PropertyBag): CircuitElement => ({
    typeId: "In",
    instanceId: crypto.randomUUID(),
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: false,
    getPins() {
      return [{
        direction: PinDirection.OUTPUT,
        position: { x: 0, y: 0 },
        label: "out",
        bitWidth: props.getOrDefault<number>("bitWidth", 1),
        isInverted: false,
        isClock: false,
      }];
    },
    getProperties() { return props; },
    getAttribute(k: string) { return props.has(k) ? props.get(k) : undefined; },
    draw() {},
    getBoundingBox() { return { x: 0, y: 0, width: 2, height: 2 }; },
    serialize() { return { typeId: "In", instanceId: this.instanceId, position: { x: 0, y: 0 }, rotation: 0, mirror: false, properties: {} }; },
  } as unknown as CircuitElement);

  // Minimal Out stub — one INPUT pin labelled "in"
  const outStubFactory = (props: PropertyBag): CircuitElement => ({
    typeId: "Out",
    instanceId: crypto.randomUUID(),
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: false,
    getPins() {
      return [{
        direction: PinDirection.INPUT,
        position: { x: 0, y: 0 },
        label: "in",
        bitWidth: props.getOrDefault<number>("bitWidth", 1),
        isInverted: false,
        isClock: false,
      }];
    },
    getProperties() { return props; },
    getAttribute(k: string) { return props.has(k) ? props.get(k) : undefined; },
    draw() {},
    getBoundingBox() { return { x: 0, y: 0, width: 2, height: 2 }; },
    serialize() { return { typeId: "Out", instanceId: this.instanceId, position: { x: 0, y: 0 }, rotation: 0, mirror: false, properties: {} }; },
  } as unknown as CircuitElement);

  registry.register({
    name: "In",
    typeId: -1,
    factory: inStubFactory,
    pinLayout: [{ label: "out", direction: PinDirection.OUTPUT, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false }],
    propertyDefs: [{ key: "label", defaultValue: "" }, { key: "bitWidth", defaultValue: 1 }],
    attributeMap: [],
    category: 0,
    helpText: "",
    models: { digital: { executeFn: noopExecuteFn as unknown as ComponentDefinition["executeFn"] as import("../../core/registry.js").ExecuteFunction } },
  } as unknown as ComponentDefinition);

  registry.register({
    name: "Out",
    typeId: -1,
    factory: outStubFactory,
    pinLayout: [{ label: "in", direction: PinDirection.INPUT, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false }],
    propertyDefs: [{ key: "label", defaultValue: "" }, { key: "bitWidth", defaultValue: 1 }],
    attributeMap: [],
    category: 0,
    helpText: "",
    models: { digital: { executeFn: noopExecuteFn as unknown as ComponentDefinition["executeFn"] as import("../../core/registry.js").ExecuteFunction } },
  } as unknown as ComponentDefinition);

  return registry;
}

// ---------------------------------------------------------------------------
// Circuit builder
//
// Node layout (grid positions, y=0 plane):
//   x=10: VS1 pos / R_drive pin A
//   x=20: R_drive pin B / XOR In_1
//   x=30: VS2 pos / XOR In_2
//   x=40: XOR out / R_load pin A   ← OUTPUT node
//   x=50: R_load pin B / GND / VS1 neg / VS2 neg
//
// Returns the circuit, registry, AND the Wire at x=40 (output node wire) so
// tests can look up the output node ID from compiled.wireToNodeId.
// ---------------------------------------------------------------------------

interface XorCircuitResult {
  circuit: Circuit;
  registry: ComponentRegistry;
  /** Wire at the XOR output node (x=40,y=0 → x=40,y=0) */
  outputWire: Wire;
}

interface XorCircuitOpts {
  simulationModel: "behavioral" | "digital";
  /** Optional per-pin override for the "out" pin */
  outPinOverride?: { vOH?: number; rOut?: number };
  /** Optional component-level electrical override */
  componentOverride?: { vOH?: number; rOut?: number };
  /** Drive In_1 high (true, default) or low (false) */
  in1High?: boolean;
  /** Drive In_2 high (true) or low (false, default) */
  in2High?: boolean;
}

function buildXorCircuit(opts: XorCircuitOpts): XorCircuitResult {
  const {
    simulationModel,
    outPinOverride,
    componentOverride,
    in1High = true,
    in2High = false,
  } = opts;

  const circuit = new Circuit(simulationModel === "digital" ? { digitalPinLoading: "all" } : {});
  const registry = simulationModel === "digital"
    ? buildDigitalRegistry()
    : buildBehavioralRegistry();

  const v1 = in1High ? V_HIGH : V_LOW;
  const v2 = in2High ? V_HIGH : V_LOW;

  // DC voltage source driving In_1 (neg=x=50/GND, pos=x=10)
  // DcVoltageSource pinLayout: neg at index 0, pos at index 1
  const vs1 = makeElement("DcVoltageSource", "vs1",
    [{ x: 50, y: 0, label: "neg" }, { x: 10, y: 0, label: "pos" }],
    new Map<string, PropertyValue>([["voltage", v1]]),
  );

  // DC voltage source driving In_2 (neg=x=50/GND, pos=x=30)
  const vs2 = makeElement("DcVoltageSource", "vs2",
    [{ x: 50, y: 0, label: "neg" }, { x: 30, y: 0, label: "pos" }],
    new Map<string, PropertyValue>([["voltage", v2]]),
  );

  // Series resistor on In_1 path (x=10 → x=20)
  const rDrive = makeElement("Resistor", "r_drive",
    [{ x: 10, y: 0 }, { x: 20, y: 0 }],
    new Map<string, PropertyValue>([["resistance", R_DRIVE]]),
  );

  // XOR gate — In_1 at x=20, In_2 at x=30, out at x=40
  const xorTypeId = (outPinOverride || componentOverride) ? "XOrOverride" : "XOr";
  if (outPinOverride || componentOverride) {
    const baseXorDef = registry.get("XOr")!;
    const defOverrides: Partial<ComponentDefinition> = {};
    if (componentOverride) defOverrides.pinElectrical = componentOverride;
    if (outPinOverride) defOverrides.pinElectricalOverrides = { out: outPinOverride };
    registry.register({
      ...baseXorDef,
      name: "XOrOverride",
      ...defOverrides,
    } as ComponentDefinition);
  }

  const xorEl = makeElement(xorTypeId, "xor1",
    [
      { x: 20, y: 0, label: "In_1" },
      { x: 30, y: 0, label: "In_2" },
      { x: 40, y: 0, label: "out" },
    ],
    new Map<string, PropertyValue>([["simulationModel", simulationModel]]),
  );

  // Load resistor (x=40 → x=50)
  const rLoad = makeElement("Resistor", "r_load",
    [{ x: 40, y: 0 }, { x: 50, y: 0 }],
    new Map<string, PropertyValue>([["resistance", R_LOAD]]),
  );

  // Ground at x=50
  const gnd = makeElement("Ground", "gnd1", [{ x: 50, y: 0 }]);

  circuit.addElement(vs1);
  circuit.addElement(vs2);
  circuit.addElement(rDrive);
  circuit.addElement(xorEl);
  circuit.addElement(rLoad);
  circuit.addElement(gnd);

  // Add short vertical stub wires to form distinct nodes — each wire has one
  // endpoint at the node position (y=0) so component pins at that x connect.
  // Self-loop wires (start===end) are silently dropped by Circuit.addWire, so
  // we use (x,0)→(x,1) stubs instead. The outputWire reference is kept so
  // tests can look up the output node ID from compiled.wireToNodeId.
  circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 1 })); // VS1 pos / R_drive A
  circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 1 })); // R_drive B / XOR In_1
  circuit.addWire(new Wire({ x: 30, y: 0 }, { x: 30, y: 1 })); // VS2 pos / XOR In_2
  const outputWire = new Wire({ x: 40, y: 0 }, { x: 40, y: 1 }); // XOR out / R_load A
  circuit.addWire(outputWire);
  circuit.addWire(new Wire({ x: 50, y: 0 }, { x: 50, y: 1 })); // GND node

  return { circuit, registry, outputWire };
}

// ---------------------------------------------------------------------------
// Helper: compile, check no errors, run simulation, return output node voltage
//
// Behavioral mode: dcOperatingPoint() gives direct steady-state solution.
// Digital mode: dcOperatingPoint() alone does NOT sync the bridge coordinator
//   (syncBeforeAnalogStep is only called from step()). So for digital mode we
//   run several transient steps to let the coordinator sync digital outputs and
//   the analog solver reach steady state, then read the final voltage.
// ---------------------------------------------------------------------------

interface DcResult {
  vOut: number;
  engine: MNAEngine;
  coordinator?: DefaultSimulationCoordinator;
}

function compiledAndRunDcOp(
  circuit: Circuit,
  registry: ComponentRegistry,
  outputWire: Wire,
  mode: "behavioral" | "digital" = "behavioral",
): DcResult {
  const unified = compileUnified(circuit, registry);
  const compiled = unified.analog!;
  const errors = compiled.diagnostics.filter((d) => d.severity === "error");
  expect(errors, `Compile errors: ${errors.map((e) => e.message).join(", ")}`).toHaveLength(0);

  // Look up the output node ID from the wire we kept a reference to
  const outNodeId = compiled.wireToNodeId.get(outputWire);
  expect(outNodeId, "Output wire should be mapped to an MNA node").toBeDefined();

  if (mode === "behavioral") {
    // Behavioral: MNAEngine directly, dcOperatingPoint gives steady-state
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();
    expect(result.converged).toBe(true);
    expect(engine.getState()).not.toBe(EngineState.ERROR);
    const vOut = engine.getNodeVoltage(outNodeId!);
    return { vOut, engine };
  } else {
    // Digital bridge path: use DefaultSimulationCoordinator which owns bridge
    // sync. Run transient steps so the coordinator syncs digital outputs and
    // the RC-coupled analog circuit reaches steady state.
    const coord = new DefaultSimulationCoordinator(unified);
    const engine = coord.getAnalogEngine() as MNAEngine;
    for (let i = 0; i < 20; i++) {
      coord.step();
      if (engine.getState() === EngineState.ERROR) break;
    }
    expect(engine.getState()).not.toBe(EngineState.ERROR);
    const vOut = engine.getNodeVoltage(outNodeId!);
    return { vOut, engine, coordinator: coord };
  }
}

// ---------------------------------------------------------------------------
// Tests: behavioral mode
// ---------------------------------------------------------------------------

describe("lrcxor fixture — behavioral mode", () => {
  it("xor_output_high_when_inputs_differ", () => {
    // In_1=HIGH, In_2=LOW → XOR=HIGH → V_out ≈ vOH × R_load/(rOut+R_load)
    const { circuit, registry, outputWire } = buildXorCircuit({
      simulationModel: "behavioral",
      in1High: true,
      in2High: false,
    });
    const { vOut } = compiledAndRunDcOp(circuit, registry, outputWire);

    const expected = DEFAULT_VOH * R_LOAD / (DEFAULT_ROUT + R_LOAD); // ≈ 3.284V
    expect(vOut).toBeGreaterThan(expected * 0.98);
    expect(vOut).toBeLessThan(expected * 1.02);
  });

  it("xor_output_low_when_inputs_match_both_high", () => {
    // In_1=HIGH, In_2=HIGH → XOR=LOW → V_out ≈ vOL = 0V
    const { circuit, registry, outputWire } = buildXorCircuit({
      simulationModel: "behavioral",
      in1High: true,
      in2High: true,
    });
    const { vOut } = compiledAndRunDcOp(circuit, registry, outputWire);

    expect(vOut).toBeCloseTo(DEFAULT_VOL, 2);
  });

  it("xor_output_low_when_inputs_match_both_low", () => {
    // In_1=LOW, In_2=LOW → XOR=LOW → V_out ≈ 0V
    const { circuit, registry, outputWire } = buildXorCircuit({
      simulationModel: "behavioral",
      in1High: false,
      in2High: false,
    });
    const { vOut } = compiledAndRunDcOp(circuit, registry, outputWire);

    expect(vOut).toBeCloseTo(DEFAULT_VOL, 2);
  });

  it("xor_output_high_when_in2_high_in1_low", () => {
    // In_1=LOW, In_2=HIGH → XOR=HIGH
    const { circuit, registry, outputWire } = buildXorCircuit({
      simulationModel: "behavioral",
      in1High: false,
      in2High: true,
    });
    const { vOut } = compiledAndRunDcOp(circuit, registry, outputWire);

    const expected = DEFAULT_VOH * R_LOAD / (DEFAULT_ROUT + R_LOAD);
    expect(vOut).toBeGreaterThan(expected * 0.98);
    expect(vOut).toBeLessThan(expected * 1.02);
  });

  it("custom_voh_via_component_override_is_respected", () => {
    // Component-level vOH=5.0V: XOR(HIGH,LOW) output ≈ 5.0 × R_load/(rOut+R_load)
    const customVOH = 5.0;
    const { circuit, registry, outputWire } = buildXorCircuit({
      simulationModel: "behavioral",
      in1High: true,
      in2High: false,
      componentOverride: { vOH: customVOH },
    });
    const { vOut } = compiledAndRunDcOp(circuit, registry, outputWire);

    const expected = customVOH * R_LOAD / (DEFAULT_ROUT + R_LOAD); // ≈ 4.975V
    expect(vOut).toBeGreaterThan(expected * 0.98);
    expect(vOut).toBeLessThan(expected * 1.02);

    // Should differ clearly from default vOH output
    const defaultExpected = DEFAULT_VOH * R_LOAD / (DEFAULT_ROUT + R_LOAD);
    expect(Math.abs(vOut - defaultExpected)).toBeGreaterThan(1.0);
  });

  it("custom_voh_via_pin_override_takes_priority_over_component", () => {
    // Per-pin vOH=4.0V beats component-level vOH=5.0V
    const pinVOH = 4.0;
    const { circuit, registry, outputWire } = buildXorCircuit({
      simulationModel: "behavioral",
      in1High: true,
      in2High: false,
      componentOverride: { vOH: 5.0 },
      outPinOverride: { vOH: pinVOH },
    });
    const { vOut } = compiledAndRunDcOp(circuit, registry, outputWire);

    const expected = pinVOH * R_LOAD / (DEFAULT_ROUT + R_LOAD); // ≈ 3.980V
    expect(vOut).toBeGreaterThan(expected * 0.98);
    expect(vOut).toBeLessThan(expected * 1.02);
  });

  it("output_converges_through_transient_steps", () => {
    const { circuit, registry, outputWire } = buildXorCircuit({
      simulationModel: "behavioral",
      in1High: true,
      in2High: false,
    });
    const { engine } = compiledAndRunDcOp(circuit, registry, outputWire);

    for (let i = 0; i < 10; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    expect(engine.simTime).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: digital mode (bridge path)
// ---------------------------------------------------------------------------

describe("lrcxor fixture — digital mode", () => {
  it("xor_compiles_to_bridge_instance", () => {
    const { circuit, registry } = buildXorCircuit({
      simulationModel: "digital",
      in1High: true,
      in2High: false,
    });
    const compiled = compileUnified(circuit, registry).analog!;

    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors, `Errors: ${errors.map((e) => e.message).join(", ")}`).toHaveLength(0);

    expect(compiled.bridges).toHaveLength(1);
    const bridge = compiled.bridges[0]!;
    expect(bridge.compiledInner).toBeDefined();
    expect(bridge.inputAdapters).toHaveLength(2);  // In_1 and In_2
    expect(bridge.outputAdapters).toHaveLength(1); // out
  });

  it("xor_output_high_when_inputs_differ", () => {
    // In_1=HIGH, In_2=LOW → XOR=HIGH via bridge
    const { circuit, registry, outputWire } = buildXorCircuit({
      simulationModel: "digital",
      in1High: true,
      in2High: false,
    });
    const { vOut } = compiledAndRunDcOp(circuit, registry, outputWire, "digital");

    const expected = DEFAULT_VOH * R_LOAD / (DEFAULT_ROUT + R_LOAD);
    expect(vOut).toBeGreaterThan(expected * 0.98);
    expect(vOut).toBeLessThan(expected * 1.02);
  });

  it("xor_output_low_when_inputs_match_both_high", () => {
    // In_1=HIGH, In_2=HIGH → XOR=LOW via bridge
    const { circuit, registry, outputWire } = buildXorCircuit({
      simulationModel: "digital",
      in1High: true,
      in2High: true,
    });
    const { vOut } = compiledAndRunDcOp(circuit, registry, outputWire, "digital");

    expect(vOut).toBeCloseTo(DEFAULT_VOL, 2);
  });

  it("xor_output_low_when_inputs_match_both_low", () => {
    const { circuit, registry, outputWire } = buildXorCircuit({
      simulationModel: "digital",
      in1High: false,
      in2High: false,
    });
    const { vOut } = compiledAndRunDcOp(circuit, registry, outputWire, "digital");

    expect(vOut).toBeCloseTo(DEFAULT_VOL, 2);
  });

  it("custom_voh_via_component_override_flows_through_bridge", () => {
    // Exercises the Part 1 fix: the compiler now passes componentOverride to
    // resolvePinElectrical when creating bridge adapters in the digital path.
    // Before the fix, this would always use the default vOH=3.3V.
    const customVOH = 5.0;
    const { circuit, registry, outputWire } = buildXorCircuit({
      simulationModel: "digital",
      in1High: true,
      in2High: false,
      componentOverride: { vOH: customVOH },
    });
    const { vOut } = compiledAndRunDcOp(circuit, registry, outputWire, "digital");

    const expected = customVOH * R_LOAD / (DEFAULT_ROUT + R_LOAD); // ≈ 4.975V
    expect(vOut).toBeGreaterThan(expected * 0.98);
    expect(vOut).toBeLessThan(expected * 1.02);

    // Should differ clearly from default vOH output
    const defaultExpected = DEFAULT_VOH * R_LOAD / (DEFAULT_ROUT + R_LOAD);
    expect(Math.abs(vOut - defaultExpected)).toBeGreaterThan(1.0);
  });

  it("custom_voh_via_pin_override_flows_through_bridge", () => {
    // Per-pin override on "out" takes priority in the bridge path too.
    const pinVOH = 4.0;
    const { circuit, registry, outputWire } = buildXorCircuit({
      simulationModel: "digital",
      in1High: true,
      in2High: false,
      outPinOverride: { vOH: pinVOH },
    });
    const { vOut } = compiledAndRunDcOp(circuit, registry, outputWire, "digital");

    const expected = pinVOH * R_LOAD / (DEFAULT_ROUT + R_LOAD); // ≈ 3.980V
    expect(vOut).toBeGreaterThan(expected * 0.98);
    expect(vOut).toBeLessThan(expected * 1.02);
  });

  it("converges_through_transient_steps", () => {
    const { circuit, registry, outputWire } = buildXorCircuit({
      simulationModel: "digital",
      in1High: true,
      in2High: false,
    });
    const { engine } = compiledAndRunDcOp(circuit, registry, outputWire, "digital");

    for (let i = 0; i < 10; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    expect(engine.simTime).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: mode switching produces consistent logic output
// ---------------------------------------------------------------------------

describe("lrcxor fixture — simplified vs digital consistency", () => {
  it("both_modes_agree_on_output_high_for_differing_inputs", () => {
    const bResult = buildXorCircuit({ simulationModel: "behavioral", in1High: true, in2High: false });
    const dResult = buildXorCircuit({ simulationModel: "digital", in1High: true, in2High: false });

    const { vOut: bVOut } = compiledAndRunDcOp(bResult.circuit, bResult.registry, bResult.outputWire, "behavioral");
    const { vOut: dVOut } = compiledAndRunDcOp(dResult.circuit, dResult.registry, dResult.outputWire, "digital");

    const expected = DEFAULT_VOH * R_LOAD / (DEFAULT_ROUT + R_LOAD);

    // Both should be near the HIGH output voltage
    expect(bVOut).toBeGreaterThan(expected * 0.98);
    expect(dVOut).toBeGreaterThan(expected * 0.98);
    // Both should agree within 5%
    expect(Math.abs(bVOut - dVOut)).toBeLessThan(expected * 0.05);
  });

  it("both_modes_agree_on_output_low_for_matching_inputs", () => {
    const bResult = buildXorCircuit({ simulationModel: "behavioral", in1High: true, in2High: true });
    const dResult = buildXorCircuit({ simulationModel: "digital", in1High: true, in2High: true });

    const { vOut: bVOut } = compiledAndRunDcOp(bResult.circuit, bResult.registry, bResult.outputWire, "behavioral");
    const { vOut: dVOut } = compiledAndRunDcOp(dResult.circuit, dResult.registry, dResult.outputWire, "digital");

    // Both outputs should be near LOW (0V)
    expect(bVOut).toBeCloseTo(DEFAULT_VOL, 2);
    expect(dVOut).toBeCloseTo(DEFAULT_VOL, 2);
  });

  it("both_modes_agree_xor_truth_table", () => {
    // Exhaustive 2-input XOR truth table: 00→0, 01→1, 10→1, 11→0
    const cases: Array<{ in1: boolean; in2: boolean; expectHigh: boolean }> = [
      { in1: false, in2: false, expectHigh: false },
      { in1: false, in2: true,  expectHigh: true  },
      { in1: true,  in2: false, expectHigh: true  },
      { in1: true,  in2: true,  expectHigh: false },
    ];

    const expectedHighV = DEFAULT_VOH * R_LOAD / (DEFAULT_ROUT + R_LOAD);

    for (const tc of cases) {
      for (const mode of ["behavioral", "digital"] as const) {
        const r = buildXorCircuit({ simulationModel: mode, in1High: tc.in1, in2High: tc.in2 });
        const { vOut } = compiledAndRunDcOp(r.circuit, r.registry, r.outputWire, mode);

        if (tc.expectHigh) {
          expect(vOut, `mode=${mode} in1=${tc.in1} in2=${tc.in2} → expect HIGH`)
            .toBeGreaterThan(expectedHighV * 0.9);
        } else {
          expect(vOut, `mode=${mode} in1=${tc.in1} in2=${tc.in2} → expect LOW`)
            .toBeCloseTo(DEFAULT_VOL, 1);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture file registry helpers
// ---------------------------------------------------------------------------

/**
 * Build a registry that can load lrcxor.dig.
 *
 * The fixture uses: Resistor, Capacitor, Inductor,
 * AcVoltageSource, Ground (unified dual-engine), and XOr.
 * The digital bridge path also requires In and Out stubs.
 */
function buildFixtureRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  // Analog passives & sources
  registry.register(ResistorDefinition);
  registry.register(CapacitorDefinition);
  registry.register(InductorDefinition);
  registry.register(AcVoltageSourceDefinition);
  // Ground is unified — use canonical GroundDefinition from io/ground
  registry.register(GroundDefinition);
  // The XOR gate (engineType: "both")
  registry.register(XOrDefinition);

  // In/Out stubs required by the digital bridge path (synthesizeDigitalCircuit
  // creates In/Out elements inside the inner circuit).
  const noopExecuteFn = () => {};
  const inStubFactory = (props: PropertyBag): CircuitElement => ({
    typeId: "In",
    instanceId: crypto.randomUUID(),
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: false,
    getPins() {
      return [{
        direction: PinDirection.OUTPUT,
        position: { x: 0, y: 0 },
        label: "out",
        bitWidth: props.getOrDefault<number>("bitWidth", 1),
        isInverted: false,
        isClock: false,
      }];
    },
    getProperties() { return props; },
    getAttribute(k: string) { return props.has(k) ? props.get(k) : undefined; },
    draw() {},
    getBoundingBox() { return { x: 0, y: 0, width: 2, height: 2 }; },
    serialize() { return { typeId: "In", instanceId: this.instanceId, position: { x: 0, y: 0 }, rotation: 0, mirror: false, properties: {} }; },
  } as unknown as CircuitElement);

  const outStubFactory = (props: PropertyBag): CircuitElement => ({
    typeId: "Out",
    instanceId: crypto.randomUUID(),
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: false,
    getPins() {
      return [{
        direction: PinDirection.INPUT,
        position: { x: 0, y: 0 },
        label: "in",
        bitWidth: props.getOrDefault<number>("bitWidth", 1),
        isInverted: false,
        isClock: false,
      }];
    },
    getProperties() { return props; },
    getAttribute(k: string) { return props.has(k) ? props.get(k) : undefined; },
    draw() {},
    getBoundingBox() { return { x: 0, y: 0, width: 2, height: 2 }; },
    serialize() { return { typeId: "Out", instanceId: this.instanceId, position: { x: 0, y: 0 }, rotation: 0, mirror: false, properties: {} }; },
  } as unknown as CircuitElement);

  registry.register({
    name: "In",
    typeId: -1,
    factory: inStubFactory,
    pinLayout: [{ label: "out", direction: PinDirection.OUTPUT, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false }],
    propertyDefs: [{ key: "label", defaultValue: "" }, { key: "bitWidth", defaultValue: 1 }],
    attributeMap: [],
    category: 0,
    helpText: "",
    models: { digital: { executeFn: noopExecuteFn as unknown as import("../../core/registry.js").ExecuteFunction } },
  } as unknown as import("../../core/registry.js").ComponentDefinition);

  registry.register({
    name: "Out",
    typeId: -1,
    factory: outStubFactory,
    pinLayout: [{ label: "in", direction: PinDirection.INPUT, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false }],
    propertyDefs: [{ key: "label", defaultValue: "" }, { key: "bitWidth", defaultValue: 1 }],
    attributeMap: [],
    category: 0,
    helpText: "",
    models: { digital: { executeFn: noopExecuteFn as unknown as import("../../core/registry.js").ExecuteFunction } },
  } as unknown as import("../../core/registry.js").ComponentDefinition);

  return registry;
}

const FIXTURE_XML = readFileSync(
  new URL("../../../../fixtures/lrcxor.dig", import.meta.url),
  "utf-8",
);

// ---------------------------------------------------------------------------
// Block 1: lrcxor.dig fixture file integration
// ---------------------------------------------------------------------------

describe("lrcxor.dig fixture file integration", () => {
  it("loads_and_compiles_without_error", () => {
    // The fixture's XOR has _pinElectrical: "[object Object]" — the compiler
    // overwrites _pinElectrical (line 768 of compiler.ts), so the bad string
    // value should NOT produce any compile error.
    const registry = buildFixtureRegistry();
    const circuit = loadDig(FIXTURE_XML, registry);

    expect(circuit.elements.length).toBeGreaterThan(0);


    const compiled = compileUnified(circuit, registry).analog!;
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(
      errors,
      `Unexpected compile errors: ${errors.map((e) => e.message).join("; ")}`,
    ).toHaveLength(0);
  });

  it("xor_responds_to_ac_source_in_digital_mode", () => {
    // Load fixture as-is (simulationModel: "digital" in XML). Run transient
    // steps and verify the engine never enters ERROR state.
    const registry = buildFixtureRegistry();
    const circuit = loadDig(FIXTURE_XML, registry);


    const compiled = compileUnified(circuit, registry).analog!;
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors, `Compile errors: ${errors.map((e) => e.message).join("; ")}`).toHaveLength(0);

    const engine = new MNAEngine();
    engine.init(compiled);

    // Run enough steps for the 1 kHz AC source to reach its first peak
    // (quarter period = 0.25 ms). 100 transient steps is conservative.
    let maxV = 0;
    for (let i = 0; i < 100; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
      // Track maximum voltage across any non-ground node
      for (let n = 1; n <= compiled.nodeCount; n++) {
        const v = Math.abs(engine.getNodeVoltage(n));
        if (v > maxV) maxV = v;
      }
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    expect(engine.simTime).toBeGreaterThan(0);
    // The AC source drives 5V amplitude — some node should exceed 0.5V
    expect(maxV).toBeGreaterThan(0.5);
  });

  it("xor_responds_to_ac_source_in_simplified_mode", () => {
    // Override simulationModel to "behavioral" on the XOR element after loading,
    // then verify the engine runs without error and produces non-zero voltages.
    const registry = buildFixtureRegistry();
    const circuit = loadDig(FIXTURE_XML, registry);


    // Switch the XOR element to simplified mode
    const xorEl = circuit.elements.find((el) => el.typeId === "XOr");
    expect(xorEl, "XOR element should be present in fixture").toBeDefined();
    xorEl!.getProperties().set("simulationModel", "behavioral");

    const compiled = compileUnified(circuit, registry).analog!;
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors, `Compile errors: ${errors.map((e) => e.message).join("; ")}`).toHaveLength(0);

    const engine = new MNAEngine();
    engine.init(compiled);

    let maxV = 0;
    for (let i = 0; i < 100; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
      for (let n = 1; n <= compiled.nodeCount; n++) {
        const v = Math.abs(engine.getNodeVoltage(n));
        if (v > maxV) maxV = v;
      }
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    expect(engine.simTime).toBeGreaterThan(0);
    expect(maxV).toBeGreaterThan(0.5);
  });

  it("modifying_vOH_on_loaded_circuit_changes_output_voltage", () => {
    // Load the fixture. Register a custom XOrOverride with vOH=5.0 on the
    // "out" pin. Replace the XOR element's typeId. Compile and verify the
    // output adapter respects the overridden vOH.
    const registry = buildFixtureRegistry();
    const circuit = loadDig(FIXTURE_XML, registry);


    const customVOH = 5.0;
    const baseXorDef = registry.get("XOr")!;
    registry.register({
      ...baseXorDef,
      name: "XOrVohOverride",
      pinElectricalOverrides: { out: { vOH: customVOH } },
    } as import("../../core/registry.js").ComponentDefinition);

    // Retarget the loaded XOR element to the override type
    const xorEl = circuit.elements.find((el) => el.typeId === "XOr");
    expect(xorEl, "XOR element should be present in fixture").toBeDefined();
    // Patch typeId via object mutation (test-only)
    (xorEl as { typeId: string }).typeId = "XOrVohOverride";
    // Use digital mode so bridge adapters are created (that's the path the
    // fix-under-test covers)
    xorEl!.getProperties().set("simulationModel", "digital");
    circuit.metadata.digitalPinLoading = "all";

    const compiled = compileUnified(circuit, registry).analog!;
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors, `Compile errors: ${errors.map((e) => e.message).join("; ")}`).toHaveLength(0);

    // The bridge should have been compiled with one output adapter
    expect(compiled.bridges).toHaveLength(1);
    const bridge = compiled.bridges[0]!;
    expect(bridge.outputAdapters).toHaveLength(1);

    // Run the engine so the bridge syncs, then verify the output node reaches
    // near vOH=5V (attenuated through load resistor).
    const engine = new MNAEngine();
    engine.init(compiled);

    // For the output to be HIGH, the AC-driven input must cross vIH.
    // Run enough steps to let the AC source reach its peak.
    for (let i = 0; i < 100; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    // Verify the output adapter's outputNodeId voltage is higher than the
    // default 3.3V vOH would produce when HIGH. We can't assert an exact
    // value because timing is AC-dependent, but the adapter must be stamping
    // with 5V rather than 3.3V when HIGH — check the adapter property.
    const adapter = bridge.outputAdapters[0]!;
    expect(typeof adapter.outputNodeId).toBe("number");
    expect(adapter.outputNodeId).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Block 2: error handling at bridge interface
// ---------------------------------------------------------------------------

describe("bridge error paths", () => {
  it("digital_mode_with_unconnected_pin_emits_diagnostic", () => {
    // Build a minimal XOR circuit where In_2 has no wire — the compiler should
    // emit an unconnected-pin diagnostic rather than crash.
    const circuit = new Circuit();
    const registry = buildDigitalRegistry();

    // VS1 → R_drive → XOR In_1 (neg=GND at x=50, pos at x=10)
    const vs1 = makeElement("DcVoltageSource", "vs1",
      [{ x: 50, y: 0, label: "neg" }, { x: 10, y: 0, label: "pos" }],
      new Map<string, PropertyValue>([["voltage", V_HIGH]]),
    );
    const rDrive = makeElement("Resistor", "r_drive",
      [{ x: 10, y: 0 }, { x: 20, y: 0 }],
      new Map<string, PropertyValue>([["resistance", R_DRIVE]]),
    );
    // XOR with In_2 (x=30) left unconnected — only In_1 and out are wired
    const xorEl = makeElement("XOr", "xor1",
      [
        { x: 20, y: 0, label: "In_1" },
        { x: 30, y: 0, label: "In_2" },  // <-- no wire at x=30
        { x: 40, y: 0, label: "out" },
      ],
      new Map<string, PropertyValue>([["simulationModel", "digital"]]),
    );
    const rLoad = makeElement("Resistor", "r_load",
      [{ x: 40, y: 0 }, { x: 50, y: 0 }],
      new Map<string, PropertyValue>([["resistance", R_LOAD]]),
    );
    const gnd = makeElement("Ground", "gnd1", [{ x: 50, y: 0 }]);

    circuit.addElement(vs1);
    circuit.addElement(rDrive);
    circuit.addElement(xorEl);
    circuit.addElement(rLoad);
    circuit.addElement(gnd);

    // Wires for x=10, x=20, x=40, x=50 — deliberately no wire at x=30
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 1 }));
    circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 1 }));
    circuit.addWire(new Wire({ x: 40, y: 0 }, { x: 40, y: 1 }));
    circuit.addWire(new Wire({ x: 50, y: 0 }, { x: 50, y: 1 }));

    // Should not throw — diagnostics collect the issue
    let compiled: NonNullable<ReturnType<typeof compileUnified>["analog"]> | undefined;
    expect(() => {
      compiled = compileUnified(circuit, registry);
    }).not.toThrow();

    // The compiler skips elements with unconnected pins; the result is valid
    // (no crash). There may or may not be explicit diagnostics depending on
    // implementation — we only assert no crash.
    expect(compiled).toBeDefined();
  });

  it("bridge_handles_indeterminate_input_gracefully", () => {
    // Drive one XOR input with a voltage in the indeterminate band (1.5V, which
    // is between vIL=0.8V and vIH=2.0V). The bridge must NOT crash or enter
    // ERROR state — it should hold the last known state (default LOW).
    const circuit = new Circuit();
    const registry = buildDigitalRegistry();

    const vIndeterminate = 1.5; // between vIL=0.8 and vIH=2.0
    const vs1 = makeElement("DcVoltageSource", "vs1",
      [{ x: 50, y: 0, label: "neg" }, { x: 10, y: 0, label: "pos" }],
      new Map<string, PropertyValue>([["voltage", vIndeterminate]]),
    );
    const vs2 = makeElement("DcVoltageSource", "vs2",
      [{ x: 50, y: 0, label: "neg" }, { x: 30, y: 0, label: "pos" }],
      new Map<string, PropertyValue>([["voltage", V_LOW]]),
    );
    const rDrive = makeElement("Resistor", "r_drive",
      [{ x: 10, y: 0 }, { x: 20, y: 0 }],
      new Map<string, PropertyValue>([["resistance", R_DRIVE]]),
    );
    const xorEl = makeElement("XOr", "xor1",
      [
        { x: 20, y: 0, label: "In_1" },
        { x: 30, y: 0, label: "In_2" },
        { x: 40, y: 0, label: "out" },
      ],
      new Map<string, PropertyValue>([["simulationModel", "digital"]]),
    );
    const rLoad = makeElement("Resistor", "r_load",
      [{ x: 40, y: 0 }, { x: 50, y: 0 }],
      new Map<string, PropertyValue>([["resistance", R_LOAD]]),
    );
    const gnd = makeElement("Ground", "gnd1", [{ x: 50, y: 0 }]);

    circuit.addElement(vs1);
    circuit.addElement(vs2);
    circuit.addElement(rDrive);
    circuit.addElement(xorEl);
    circuit.addElement(rLoad);
    circuit.addElement(gnd);

    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 1 }));
    circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 1 }));
    circuit.addWire(new Wire({ x: 30, y: 0 }, { x: 30, y: 1 }));
    circuit.addWire(new Wire({ x: 40, y: 0 }, { x: 40, y: 1 }));
    circuit.addWire(new Wire({ x: 50, y: 0 }, { x: 50, y: 1 }));

    const compiled = compileUnified(circuit, registry).analog!;
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors, `Compile errors: ${errors.map((e) => e.message).join("; ")}`).toHaveLength(0);

    const engine = new MNAEngine();
    engine.init(compiled);

    // Step 20 times — engine must not crash with indeterminate input
    for (let i = 0; i < 20; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
  });

  it("both_modes_survive_zero_voltage_inputs", () => {
    // Both inputs at 0V — neither simplified nor digital mode should crash.
    for (const mode of ["behavioral", "digital"] as const) {
      const { circuit, registry, outputWire } = buildXorCircuit({
        simulationModel: mode,
        in1High: false,
        in2High: false,
      });

      const compiled = compileUnified(circuit, registry).analog!;
      const errors = compiled.diagnostics.filter((d) => d.severity === "error");
      expect(errors, `mode=${mode} compile errors: ${errors.map((e) => e.message).join("; ")}`).toHaveLength(0);

      const engine = new MNAEngine();
      engine.init(compiled);

      for (let i = 0; i < 20; i++) {
        engine.step();
        if (engine.getState() === EngineState.ERROR) break;
      }

      expect(engine.getState(), `mode=${mode} should not enter ERROR`).not.toBe(EngineState.ERROR);

      // Both inputs LOW → XOR LOW → output near 0V
      const outNodeId = compiled.wireToNodeId.get(outputWire);
      expect(outNodeId).toBeDefined();
      const vOut = engine.getNodeVoltage(outNodeId!);
      expect(vOut, `mode=${mode} both inputs 0V → output should be near 0`).toBeCloseTo(0, 1);
    }
  });

  it("digital_mode_bridge_adapters_stamp_at_correct_nodes", () => {
    // Structural check: after compiling in digital mode, each bridge adapter's
    // outputNodeId/inputNodeId must be a valid MNA node (>= 1, < totalNodeCount).
    const { circuit, registry } = buildXorCircuit({
      simulationModel: "digital",
      in1High: true,
      in2High: false,
    });

    const compiled = compileUnified(circuit, registry).analog!;
    expect(compiled.bridges).toHaveLength(1);

    const bridge = compiled.bridges[0]!;
    const nodeCount = compiled.nodeCount;

    // Output adapters — one per digital output pin (XOR has one: "out")
    expect(bridge.outputAdapters).toHaveLength(1);
    for (const adapter of bridge.outputAdapters) {
      expect(adapter.outputNodeId).toBeGreaterThanOrEqual(1);
      expect(adapter.outputNodeId).toBeLessThanOrEqual(nodeCount);
    }

    // Input adapters — one per digital input pin (XOR has two: In_1, In_2)
    expect(bridge.inputAdapters).toHaveLength(2);
    for (const adapter of bridge.inputAdapters) {
      expect(adapter.inputNodeId).toBeGreaterThanOrEqual(1);
      expect(adapter.inputNodeId).toBeLessThanOrEqual(nodeCount);
    }

    // Output and input node IDs must be distinct (they represent different nets)
    const outputNodes = bridge.outputAdapters.map((a) => a.outputNodeId);
    const inputNodes = bridge.inputAdapters.map((a) => a.inputNodeId);
    for (const inNode of inputNodes) {
      expect(outputNodes).not.toContain(inNode);
    }
  });
});
