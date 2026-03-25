/**
 * End-to-end MNA engine tests.
 *
 * These tests exercise the FULL pipeline:
 *   real ComponentDefinitions → compileUnified() → MNAEngine → verify
 *
 * They close the critical test gap where existing tests either:
 *   (a) use hand-built ConcreteCompiledAnalogCircuit (bypass compiler), or
 *   (b) test the compiler without running the engine.
 *
 * Coverage:
 *   1. Full-pipeline DC operating point (resistor divider via real definitions)
 *   2. Tight-tolerance transient verification (RC/RL steady-state <0.1%)
 *   3. Multi-nonlinear convergence (series diodes, parallel diodes, diode clamp)
 *   4. Analytical verification (divider ratio, Shockley consistency, superposition)
 */

import { describe, it, expect } from "vitest";
import { Circuit, Wire } from "../../core/circuit.js";
import type { CircuitElement } from "../../core/element.js";
import type { Pin } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { PropertyValue } from "../../core/properties.js";
import type { Rect, RenderContext } from "../../core/renderer-interface.js";
import type { SerializedElement } from "../../core/element.js";
import { ComponentRegistry } from "../../core/registry.js";
import { compileUnified } from "@/compile/compile.js";
import { MNAEngine } from "../analog-engine.js";
import { ConcreteCompiledAnalogCircuit } from "../compiled-analog-circuit.js";
import { EngineState } from "../../core/engine-interface.js";
import {
  makeResistor,
  makeVoltageSource,
  makeCapacitor,
  makeDiode,
  makeInductor,
} from "../test-elements.js";

// Import real component definitions
import { ResistorDefinition } from "../../components/passives/resistor.js";
import { DcVoltageSourceDefinition } from "../../components/sources/dc-voltage-source.js";
import { GroundDefinition } from "../../components/io/ground.js";
import { CapacitorDefinition } from "../../components/passives/capacitor.js";
import { DiodeDefinition } from "../../components/semiconductors/diode.js";
import { NmosfetDefinition, PmosfetDefinition } from "../../components/semiconductors/mosfet.js";

// ---------------------------------------------------------------------------
// Minimal CircuitElement factory — same pattern as analog-compiler.test.ts
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
// Registry builder — registers real analog component definitions
// ---------------------------------------------------------------------------

function buildAnalogRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register(GroundDefinition);
  registry.register(ResistorDefinition);
  registry.register(DcVoltageSourceDefinition);
  registry.register(CapacitorDefinition);
  registry.register(DiodeDefinition);
  return registry;
}

// ---------------------------------------------------------------------------
// Wire helper
// ---------------------------------------------------------------------------

function addWire(circuit: Circuit, x1: number, y1: number, x2: number, y2: number): void {
  circuit.addWire(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }));
}

// ---------------------------------------------------------------------------
// Hand-built circuit helper
// ---------------------------------------------------------------------------

function buildHandCircuit(opts: {
  nodeCount: number;
  branchCount: number;
  elements: import("../element.js").AnalogElement[];
}): ConcreteCompiledAnalogCircuit {
  return new ConcreteCompiledAnalogCircuit({
    nodeCount: opts.nodeCount,
    branchCount: opts.branchCount,
    elements: opts.elements,
    labelToNodeId: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    elementToCircuitElement: new Map(),
  });
}

// ===========================================================================
// 1. Full-pipeline DC operating point (compiler → engine)
// ===========================================================================

describe("End-to-end: full pipeline", () => {
  it("resistor_divider_dc_op_via_compiler", () => {
    // Vs=5V → R1=1kΩ → midpoint → R2=1kΩ → GND
    // node_top (x=10): Vs.pos, R1.A
    // node_mid (x=20): R1.B, R2.A
    // node_gnd (x=30): R2.B, Vs.neg, GND

    const circuit = new Circuit({  });
    const registry = buildAnalogRegistry();

    // DcVoltageSource pin order: [neg, pos]
    const vs = makeElement("DcVoltageSource", "vs1",
      [{ x: 30, y: 0 }, { x: 10, y: 0 }],
      new Map<string, PropertyValue>([["voltage", 5]]),
    );
    const r1 = makeElement("Resistor", "r1",
      [{ x: 10, y: 0 }, { x: 20, y: 0 }],
      new Map<string, PropertyValue>([["resistance", 1000]]),
    );
    const r2 = makeElement("Resistor", "r2",
      [{ x: 20, y: 0 }, { x: 30, y: 0 }],
      new Map<string, PropertyValue>([["resistance", 1000]]),
    );
    const gnd = makeElement("Ground", "gnd1", [{ x: 30, y: 0 }]);

    circuit.addElement(vs);
    circuit.addElement(r1);
    circuit.addElement(r2);
    circuit.addElement(gnd);

    addWire(circuit, 10, 0, 10, 0);
    addWire(circuit, 20, 0, 20, 0);
    addWire(circuit, 30, 0, 30, 0);

    const compiled = compileUnified(circuit, registry).analog!;
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
    // Vs + R1 + R2 (ground is structural, skipped by compiler)
    expect(compiled.elements.length).toBe(3);

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.nodeVoltages.length).toBe(compiled.matrixSize);

    // We don't know exact node assignment order, so check all node voltages
    const voltages = Array.from(result.nodeVoltages).slice(0, compiled.nodeCount);
    const sorted = [...voltages].sort((a, b) => a - b);

    // Midpoint = 2.5V, top = 5.0V
    expect(sorted[0]).toBeCloseTo(2.5, 2);
    expect(sorted[1]).toBeCloseTo(5.0, 2);
  });

  it("diode_circuit_dc_op_via_compiler", () => {
    // Vs=5V → R=1kΩ → Diode(anode→cathode) → GND
    const circuit = new Circuit({  });
    const registry = buildAnalogRegistry();

    // DcVoltageSource pin order: [neg, pos]
    const vs = makeElement("DcVoltageSource", "vs1",
      [{ x: 30, y: 0 }, { x: 10, y: 0 }],
      new Map<string, PropertyValue>([["voltage", 5]]),
    );
    const r = makeElement("Resistor", "r1",
      [{ x: 10, y: 0 }, { x: 20, y: 0 }],
      new Map<string, PropertyValue>([["resistance", 1000]]),
    );
    const diode = makeElement("Diode", "d1",
      [{ x: 20, y: 0 }, { x: 30, y: 0 }],
    );
    const gnd = makeElement("Ground", "gnd1", [{ x: 30, y: 0 }]);

    circuit.addElement(vs);
    circuit.addElement(r);
    circuit.addElement(diode);
    circuit.addElement(gnd);

    addWire(circuit, 10, 0, 10, 0);
    addWire(circuit, 20, 0, 20, 0);
    addWire(circuit, 30, 0, 30, 0);

    const compiled = compileUnified(circuit, registry).analog!;
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    const voltages = Array.from(result.nodeVoltages).slice(0, compiled.nodeCount);
    const sorted = [...voltages].sort((a, b) => a - b);

    // Lower voltage = diode anode ≈ 0.6–0.75V
    expect(sorted[0]).toBeGreaterThan(0.55);
    expect(sorted[0]).toBeLessThan(0.80);
    // Higher voltage = supply = 5V
    expect(sorted[1]).toBeCloseTo(5.0, 1);
  });
});

// ===========================================================================
// 2. Tight-tolerance transient tests
// ===========================================================================

describe("End-to-end: tight transient tolerances", () => {
  it("rc_steady_state_no_drift", () => {
    // Vs=5V, R=1kΩ, C=1µF. After DC OP capacitor is at 5V.
    // Run 2ms transient — voltage must not drift from 5V.
    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const cap = makeCapacitor(2, 0, 1e-6);

    const compiled = buildHandCircuit({
      nodeCount: 2, branchCount: 1, elements: [vs, r, cap],
    });

    const engine = new MNAEngine();
    engine.init(compiled);

    const dcResult = engine.dcOperatingPoint();
    expect(dcResult.converged).toBe(true);
    expect(engine.getNodeVoltage(2)).toBeCloseTo(5.0, 3);

    const RC = 1e-3;
    let steps = 0;
    while (engine.simTime < 2 * RC && steps < 10000) {
      engine.step();
      steps++;
      if (engine.getState() === EngineState.ERROR) break;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    // Voltage must remain at 5V with <0.1% drift
    const vCapFinal = engine.getNodeVoltage(2);
    const driftPct = Math.abs(vCapFinal - 5.0) / 5.0 * 100;
    expect(driftPct).toBeLessThan(0.1);
  });

  it("rc_steady_state_current_zero", () => {
    // At steady state with C fully charged, current through R should be ~0.
    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const cap = makeCapacitor(2, 0, 1e-6);

    const compiled = buildHandCircuit({
      nodeCount: 2, branchCount: 1, elements: [vs, r, cap],
    });

    const engine = new MNAEngine();
    engine.init(compiled);
    engine.configure({ maxTimeStep: 1e-6 });

    const dcResult = engine.dcOperatingPoint();
    expect(dcResult.converged).toBe(true);
    expect(engine.getNodeVoltage(1)).toBeCloseTo(5.0, 4);
    expect(engine.getNodeVoltage(2)).toBeCloseTo(5.0, 4);

    // Run 200 steps
    for (let i = 0; i < 200; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);

    // Steady-state accuracy: <0.01% voltage deviation
    const vNode2 = engine.getNodeVoltage(2);
    const errorPct = Math.abs(vNode2 - 5.0) / 5.0 * 100;
    expect(errorPct).toBeLessThan(0.01);

    // Branch current should be ~0A at steady state
    const iVs = engine.getBranchCurrent(0);
    expect(Math.abs(iVs)).toBeLessThan(1e-6); // < 1µA
  });

  it("rl_dc_steady_state_tight_tolerance", () => {
    // Vs=5V, R=100Ω, L=10mH → τ=L/R=0.1ms
    // At DC: inductor is short, I = 5V/100Ω = 50mA
    // Vs branch=2, L branch=3
    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 100);
    const ind = makeInductor(2, 0, 3, 10e-3);

    const compiled = buildHandCircuit({
      nodeCount: 2, branchCount: 2, elements: [vs, r, ind],
    });

    const engine = new MNAEngine();
    engine.init(compiled);

    const dcResult = engine.dcOperatingPoint();
    expect(dcResult.converged).toBe(true);

    // node1=5V, node2=0V (inductor short to ground)
    expect(engine.getNodeVoltage(1)).toBeCloseTo(5.0, 4);
    expect(engine.getNodeVoltage(2)).toBeCloseTo(0.0, 4);

    // Inductor current = 50mA
    const iL = engine.getBranchCurrent(1);
    expect(Math.abs(iL)).toBeCloseTo(0.05, 4);

    // Run transient for 1ms (10× τ) — should stay at steady state
    engine.configure({ maxTimeStep: 5e-6 });
    let steps = 0;
    while (engine.simTime < 1e-3 && steps < 5000) {
      engine.step();
      steps++;
      if (engine.getState() === EngineState.ERROR) break;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);

    // Steady-state current: <0.1% deviation
    const iLFinal = engine.getBranchCurrent(1);
    const errorPct = Math.abs(Math.abs(iLFinal) - 0.05) / 0.05 * 100;
    expect(errorPct).toBeLessThan(0.1);
  });
});

// ===========================================================================
// 3. Multi-nonlinear convergence
// ===========================================================================

describe("End-to-end: multi-nonlinear convergence", () => {
  it("two_diodes_in_series", () => {
    // Vs=5V → R=1kΩ → D1 → D2 → GND
    // node1: Vs+, R.A;  node2: R.B, D1.anode;  node3: D1.cathode, D2.anode
    // Vs branch=3, matrixSize=4
    const vs = makeVoltageSource(1, 0, 3, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d1 = makeDiode(2, 3, 1e-14, 1.0);
    const d2 = makeDiode(3, 0, 1e-14, 1.0);

    const compiled = buildHandCircuit({
      nodeCount: 3, branchCount: 1, elements: [vs, r, d1, d2],
    });

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(engine.getNodeVoltage(1)).toBeCloseTo(5.0, 2);

    // node3 = single diode drop ≈ 0.6–0.75V
    const vNode3 = engine.getNodeVoltage(3);
    expect(vNode3).toBeGreaterThan(0.55);
    expect(vNode3).toBeLessThan(0.80);

    // node2 = two diode drops ≈ 1.2–1.5V
    const vNode2 = engine.getNodeVoltage(2);
    expect(vNode2).toBeGreaterThan(1.1);
    expect(vNode2).toBeLessThan(1.6);

    // Both diode drops should be nearly equal (same Is, n, same current)
    const vD1 = vNode2 - vNode3;
    const vD2 = vNode3;
    expect(Math.abs(vD1 - vD2) / vD2).toBeLessThan(0.05);
  });

  it("parallel_diodes", () => {
    // Vs=5V → R=1kΩ → [D1 || D2] → GND
    // node1: Vs+, R.A;  node2: R.B, D1.anode, D2.anode
    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d1 = makeDiode(2, 0, 1e-14, 1.0);
    const d2 = makeDiode(2, 0, 1e-14, 1.0);

    const compiled = buildHandCircuit({
      nodeCount: 2, branchCount: 1, elements: [vs, r, d1, d2],
    });

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(engine.getNodeVoltage(1)).toBeCloseTo(5.0, 2);

    // Diode forward voltage ≈ 0.6–0.75V
    const vAnode = engine.getNodeVoltage(2);
    expect(vAnode).toBeGreaterThan(0.55);
    expect(vAnode).toBeLessThan(0.80);
  });

  it("diode_clamp_on_resistor_divider", () => {
    // Vs=5V → R1=1kΩ → mid → R2=1kΩ → GND
    //                   mid → D1 → GND
    // Without D1: V_mid = 2.5V. With D1: V_mid ≈ 0.65V (diode clamps)
    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r1 = makeResistor(1, 2, 1000);
    const r2 = makeResistor(2, 0, 1000);
    const d1 = makeDiode(2, 0, 1e-14, 1.0);

    const compiled = buildHandCircuit({
      nodeCount: 2, branchCount: 1, elements: [vs, r1, r2, d1],
    });

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(engine.getNodeVoltage(1)).toBeCloseTo(5.0, 2);

    const vMid = engine.getNodeVoltage(2);
    expect(vMid).toBeGreaterThan(0.55);
    expect(vMid).toBeLessThan(0.80);
    expect(vMid).toBeLessThan(2.5); // must be below no-diode value
  });

  it("anti_parallel_diodes", () => {
    // Vs=5V → R=1kΩ → node2 → D1(forward) → GND
    //                  node2 → D2(reverse: anode=gnd, cathode=node2) → GND
    // D2 reverse leakage is negligible; result ≈ single forward diode
    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r = makeResistor(1, 2, 1000);
    const d1 = makeDiode(2, 0, 1e-14, 1.0);   // forward
    const d2 = makeDiode(0, 2, 1e-14, 1.0);   // reverse

    const compiled = buildHandCircuit({
      nodeCount: 2, branchCount: 1, elements: [vs, r, d1, d2],
    });

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    const vNode2 = engine.getNodeVoltage(2);
    expect(vNode2).toBeGreaterThan(0.55);
    expect(vNode2).toBeLessThan(0.80);
  });
});

// ===========================================================================
// 4. Analytical verification with tight tolerances
// ===========================================================================

describe("End-to-end: analytical verification", () => {
  it("resistor_divider_2_to_1_ratio", () => {
    // R1=2kΩ, R2=1kΩ → V_mid = 5 * 1/3 ≈ 1.6667V
    const vs = makeVoltageSource(1, 0, 2, 5.0);
    const r1 = makeResistor(1, 2, 2000);
    const r2 = makeResistor(2, 0, 1000);

    const compiled = buildHandCircuit({
      nodeCount: 2, branchCount: 1, elements: [vs, r1, r2],
    });

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    const expected = 5.0 * 1000 / 3000;
    expect(engine.getNodeVoltage(2)).toBeCloseTo(expected, 6);

    // Current = 5V / 3kΩ
    const expectedI = 5.0 / 3000;
    expect(Math.abs(engine.getBranchCurrent(0))).toBeCloseTo(expectedI, 8);
  });

  it("diode_shockley_equation_consistency", () => {
    // Vs=5V → R=10kΩ → D(Is=1e-14, n=1) → GND
    // At operating point: Id_ohm = (Vs-Vd)/R must equal Id_shockley = Is*(exp(Vd/Vt)-1)
    const Vs = 5.0;
    const R = 10000;
    const Is = 1e-14;
    const n = 1.0;
    const Vt = 0.02585;

    const vs = makeVoltageSource(1, 0, 2, Vs);
    const r = makeResistor(1, 2, R);
    const d = makeDiode(2, 0, Is, n);

    const compiled = buildHandCircuit({
      nodeCount: 2, branchCount: 1, elements: [vs, r, d],
    });

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    const vd = engine.getNodeVoltage(2);

    const iOhm = (Vs - vd) / R;
    const iShockley = Is * (Math.exp(vd / (n * Vt)) - 1);

    // Both must agree to <0.1%
    const relError = Math.abs(iOhm - iShockley) / iOhm;
    expect(relError).toBeLessThan(0.001);

    expect(vd).toBeGreaterThan(0.55);
    expect(vd).toBeLessThan(0.75);
  });

  it("superposition_two_sources", () => {
    // V1=10V (node1→gnd), V2=5V (node3→gnd)
    // R1=1kΩ (node1→node2), R2=2kΩ (node3→node2), R3=1kΩ (node2→gnd)
    //
    // KCL at node2: (10-Vn2)/1k + (5-Vn2)/2k - Vn2/1k = 0
    //   25 = 5*Vn2 → Vn2 = 5V
    const v1 = makeVoltageSource(1, 0, 3, 10.0);
    const v2 = makeVoltageSource(3, 0, 4, 5.0);
    const r1 = makeResistor(1, 2, 1000);
    const r2 = makeResistor(3, 2, 2000);
    const r3 = makeResistor(2, 0, 1000);

    const compiled = buildHandCircuit({
      nodeCount: 3, branchCount: 2, elements: [v1, v2, r1, r2, r3],
    });

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    expect(engine.getNodeVoltage(1)).toBeCloseTo(10.0, 6);
    expect(engine.getNodeVoltage(3)).toBeCloseTo(5.0, 6);
    expect(engine.getNodeVoltage(2)).toBeCloseTo(5.0, 6);
  });
});

// ===========================================================================
// 5. MOSFET through compiler
// ===========================================================================

describe("MOSFET through compiler", () => {
  // Shared registry builder that includes MOSFET definitions
  function buildMosfetRegistry(): ComponentRegistry {
    const registry = new ComponentRegistry();
    registry.register(GroundDefinition);
    registry.register(ResistorDefinition);
    registry.register(DcVoltageSourceDefinition);
    registry.register(NmosfetDefinition);
    registry.register(PmosfetDefinition);
    return registry;
  }

  it("nmos_common_source_dc_op", () => {
    // VDD=5V → Rd=10kΩ → drain. Gate=2V (Vgs=2V). Source=GND.
    // NMOS default W/L=1, KP=120e-6, VTO=0.7, LAMBDA=0.02
    // Saturation: ids = KP/2*(W/L)*(Vgs-Vth)² = 60e-6*1*1.69 ≈ 0.1014mA
    // Vdrain = 5 - 0.1014e-3 * 10000 ≈ 3.986V
    // Confirm saturation: Vds(≈3.99V) > Vgs-Vth(1.3V) ✓
    //
    // Node layout (coordinate-based wiring):
    //   x=10: VDD+ (vdd.pos), Rd.A
    //   x=20: Rd.B, NMOS D
    //   x=30: vdd.neg, GND, NMOS S
    //   x=40: Vg+ (vg.pos), NMOS G
    //   x=50: vg.neg, GND2

    const circuit = new Circuit({  });
    const registry = buildMosfetRegistry();

    // DcVoltageSource pin order: [neg, pos]
    const vdd = makeElement("DcVoltageSource", "vdd1",
      [{ x: 30, y: 0 }, { x: 10, y: 0 }],
      new Map<string, PropertyValue>([["voltage", 5]]),
    );
    const rd = makeElement("Resistor", "rd1",
      [{ x: 10, y: 0 }, { x: 20, y: 0 }],
      new Map<string, PropertyValue>([["resistance", 10000]]),
    );
    // NMOS pin order: [G, S, D] — G=x40, S=x30, D=x20
    const nmos = makeElement("NMOS", "m1",
      [{ x: 40, y: 0 }, { x: 30, y: 0 }, { x: 20, y: 0 }],
      new Map<string, PropertyValue>(),
    );
    const vg = makeElement("DcVoltageSource", "vg1",
      [{ x: 50, y: 0 }, { x: 40, y: 0 }],
      new Map<string, PropertyValue>([["voltage", 2]]),
    );
    const gnd1 = makeElement("Ground", "gnd1", [{ x: 30, y: 0 }]);
    const gnd2 = makeElement("Ground", "gnd2", [{ x: 50, y: 0 }]);

    circuit.addElement(vdd);
    circuit.addElement(rd);
    circuit.addElement(nmos);
    circuit.addElement(vg);
    circuit.addElement(gnd1);
    circuit.addElement(gnd2);

    addWire(circuit, 10, 0, 10, 0);
    addWire(circuit, 20, 0, 20, 0);
    addWire(circuit, 30, 0, 30, 0);
    addWire(circuit, 40, 0, 40, 0);
    addWire(circuit, 50, 0, 50, 0);

    const compiled = compileUnified(circuit, registry).analog!;
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    // Node voltages (non-ground): VDD top=5V, drain≈3.99V, gate=2V
    // Sort descending: [5V, ≈3.99V, 2V]
    // The drain node is the one between supply and gate voltage
    const voltages = Array.from(result.nodeVoltages)
      .slice(0, compiled.nodeCount)
      .sort((a, b) => b - a);

    // VDD node = 5V
    expect(voltages[0]).toBeCloseTo(5.0, 1);
    // Gate node = 2V (third highest when drain is ~3.99V)
    // Drain node: pulled below VDD by ≈0.1014mA through 10kΩ
    // Expected drain ≈ 3.99V, confirm saturation: Vdrain > Vgs-Vth = 1.3V
    const vDrain = voltages[1]; // second-highest: drain between supply and gate
    expect(vDrain).toBeGreaterThan(1.3);   // saturation condition
    expect(vDrain).toBeLessThan(5.0);      // drain pulled below supply
    expect(vDrain).toBeGreaterThan(3.0);   // significant voltage (not near ground)
  });

  it("nmos_triode_region_dc_op", () => {
    // VDD=5V → Rd=100kΩ → drain. Gate=3V (Vgs=3V). Source=GND.
    // NMOS default W/L=1, KP=120e-6, VTO=0.7 → Vgs-Vth=2.3V
    // Saturation current: ids = 60e-6*1*2.3² ≈ 0.317mA
    // If in saturation: Vdrain = 5 - 0.317e-3*100000 = 5 - 31.7 → clamps below 0 → triode
    // Large Rd forces Vds small → triode (linear) region: Vds < Vgs-Vth = 2.3V
    // In triode: ids = KP*W/L*((Vgs-Vth)*Vds - Vds²/2)
    // KCL: (5-Vdrain)/100k = ids(Vdrain) → Vdrain ≈ small positive value

    const circuit = new Circuit({  });
    const registry = buildMosfetRegistry();

    // DcVoltageSource pin order: [neg, pos]
    const vdd = makeElement("DcVoltageSource", "vdd1",
      [{ x: 30, y: 0 }, { x: 10, y: 0 }],
      new Map<string, PropertyValue>([["voltage", 5]]),
    );
    const rd = makeElement("Resistor", "rd1",
      [{ x: 10, y: 0 }, { x: 20, y: 0 }],
      new Map<string, PropertyValue>([["resistance", 100000]]),
    );
    // NMOS pin order: [G, S, D] — G=x40, S=x30, D=x20
    const nmos = makeElement("NMOS", "m1",
      [{ x: 40, y: 0 }, { x: 30, y: 0 }, { x: 20, y: 0 }],
      new Map<string, PropertyValue>(),
    );
    const vg = makeElement("DcVoltageSource", "vg1",
      [{ x: 50, y: 0 }, { x: 40, y: 0 }],
      new Map<string, PropertyValue>([["voltage", 3]]),
    );
    const gnd1 = makeElement("Ground", "gnd1", [{ x: 30, y: 0 }]);
    const gnd2 = makeElement("Ground", "gnd2", [{ x: 50, y: 0 }]);

    circuit.addElement(vdd);
    circuit.addElement(rd);
    circuit.addElement(nmos);
    circuit.addElement(vg);
    circuit.addElement(gnd1);
    circuit.addElement(gnd2);

    addWire(circuit, 10, 0, 10, 0);
    addWire(circuit, 20, 0, 20, 0);
    addWire(circuit, 30, 0, 30, 0);
    addWire(circuit, 40, 0, 40, 0);
    addWire(circuit, 50, 0, 50, 0);

    const compiled = compileUnified(circuit, registry).analog!;
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    // Sort node voltages descending: [5V(VDD), 3V(gate), drain(small)]
    const voltages = Array.from(result.nodeVoltages)
      .slice(0, compiled.nodeCount)
      .sort((a, b) => b - a);

    // VDD = 5V
    expect(voltages[0]).toBeCloseTo(5.0, 1);
    // Drain node (lowest non-ground voltage): must be in triode → Vds < Vgs-Vth = 2.3V
    const vDrain = voltages[voltages.length - 1];
    expect(vDrain).toBeLessThan(2.3);   // triode condition
    expect(vDrain).toBeGreaterThan(0.0); // conducting (above ground)
  });

  it("pmos_common_source_dc_op", () => {
    // PMOS source=VDD=5V, gate=3V (Vsg=2V), drain through Rd=10kΩ to GND.
    // PMOS default W/L=1, KP=60e-6, VTO=-0.7, LAMBDA=0.02
    // |Vsg|=2V, |Vtp|=0.7V → |Vsg|-|Vtp|=1.3V
    // Saturation: |ids| = KP/2*(W/L)*1.3² = 30e-6*1.69 ≈ 50.7µA
    // Vdrain = ids*Rd = 50.7e-6*10000 ≈ 0.507V
    // Confirm saturation: |Vds|=5-0.507=4.493V > 1.3V ✓
    //
    // Node layout:
    //   x=10: PMOS S (source=VDD), vs.pos
    //   x=20: PMOS D (drain), Rd.A
    //   x=30: vs.neg, Rd.B, GND
    //   x=40: Vg.pos, PMOS G
    //   x=50: Vg.neg, GND2

    const circuit = new Circuit({  });
    const registry = buildMosfetRegistry();

    // DcVoltageSource pin order: [neg, pos]
    const vs = makeElement("DcVoltageSource", "vs1",
      [{ x: 30, y: 0 }, { x: 10, y: 0 }],
      new Map<string, PropertyValue>([["voltage", 5]]),
    );
    const rd = makeElement("Resistor", "rd1",
      [{ x: 20, y: 0 }, { x: 30, y: 0 }],
      new Map<string, PropertyValue>([["resistance", 10000]]),
    );
    // PMOS pin order: [G, D, S] — G=x40, D=x20, S=x10
    const pmos = makeElement("PMOS", "m1",
      [{ x: 40, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 0 }],
      new Map<string, PropertyValue>(),
    );
    const vg = makeElement("DcVoltageSource", "vg1",
      [{ x: 50, y: 0 }, { x: 40, y: 0 }],
      new Map<string, PropertyValue>([["voltage", 3]]),
    );
    const gnd1 = makeElement("Ground", "gnd1", [{ x: 30, y: 0 }]);
    const gnd2 = makeElement("Ground", "gnd2", [{ x: 50, y: 0 }]);

    circuit.addElement(vs);
    circuit.addElement(rd);
    circuit.addElement(pmos);
    circuit.addElement(vg);
    circuit.addElement(gnd1);
    circuit.addElement(gnd2);

    addWire(circuit, 10, 0, 10, 0);
    addWire(circuit, 20, 0, 20, 0);
    addWire(circuit, 30, 0, 30, 0);
    addWire(circuit, 40, 0, 40, 0);
    addWire(circuit, 50, 0, 50, 0);

    const compiled = compileUnified(circuit, registry).analog!;
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);

    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    // Sort node voltages descending: [5V(VDD/source), 3V(gate), drain(~0.5V)]
    const voltages = Array.from(result.nodeVoltages)
      .slice(0, compiled.nodeCount)
      .sort((a, b) => b - a);

    // VDD/source node = 5V
    expect(voltages[0]).toBeCloseTo(5.0, 1);
    // Drain node: pulled up from ground by PMOS current through Rd
    // Expected ≈ 0.5V, must be above ground and confirm saturation: |Vds|>1.3V → Vdrain<3.7V
    const vDrain = voltages[voltages.length - 1];
    expect(vDrain).toBeGreaterThan(0.0);   // PMOS conducting (above ground)
    expect(vDrain).toBeLessThan(3.7);      // saturation: |Vds|=5-Vdrain > 1.3V
  });
});
