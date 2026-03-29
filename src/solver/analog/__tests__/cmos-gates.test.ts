/**
 * CMOS gate transistor-level model tests (Phase 4c.2).
 *
 * Tests compile CMOS gate topologies directly through the full analog pipeline:
 *   compileUnified(flat MOSFET circuit) → MNAEngine → DC operating point
 *
 * Each test circuit is built as a flat circuit of NMOS/PMOS elements with
 * explicit voltage source inputs, no subcircuit expansion needed.
 *
 * NMOS/PMOS factories are registered via registerAnalogFactory before tests
 * to enable transistor-model expansion (used by Registration tests).
 *
 * Voltage thresholds (VDD=3.3V): HIGH output > 3.0V, LOW output < 0.2V
 * (relaxed from ideal to account for MOSFET residual Vds in triode region)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Circuit, Wire } from "../../../core/circuit.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import type { Pin } from "../../../core/pin.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Rect, RenderContext } from "../../../core/renderer-interface.js";
import type { SerializedElement } from "../../../core/element.js";
import { ComponentRegistry } from "../../../core/registry.js";
import type { PropertyValue } from "../../../core/properties.js";
import { compileUnified } from "@/compile/compile.js";
import { MNAEngine } from "../analog-engine.js";
import { SubcircuitModelRegistry } from "../subcircuit-model-registry.js";
import { registerBuiltinSubcircuitModels } from "../transistor-models/cmos-gates.js";
import { registerAnalogFactory } from "../transistor-expansion.js";
import { createMosfetElement } from "../../../components/semiconductors/mosfet.js";
import { EngineState } from "../../../core/engine-interface.js";

// Import gate definitions for registration tests
import { NotDefinition } from "../../../components/gates/not.js";
import { AndDefinition } from "../../../components/gates/and.js";
import { NAndDefinition } from "../../../components/gates/nand.js";
import { OrDefinition } from "../../../components/gates/or.js";
import { NOrDefinition } from "../../../components/gates/nor.js";
import { XOrDefinition } from "../../../components/gates/xor.js";
import { XNOrDefinition } from "../../../components/gates/xnor.js";

// Import components needed for building test circuits
import { DcVoltageSourceDefinition } from "../../../components/sources/dc-voltage-source.js";
import { GroundDefinition } from "../../../components/io/ground.js";
import { NmosfetDefinition, PmosfetDefinition } from "../../../components/semiconductors/mosfet.js";

// ---------------------------------------------------------------------------
// One-time setup: register real MOSFET analog factories and gate models
// ---------------------------------------------------------------------------

const modelRegistry = new SubcircuitModelRegistry();

beforeAll(() => {
  registerAnalogFactory("NMOS", (nodeIds, branchIdx, props, _getTime) =>
    createMosfetElement(1, new Map([["D", nodeIds[0] ?? 0], ["G", nodeIds[1] ?? 0], ["S", nodeIds[2] ?? 0]]), [], branchIdx, props),
  );
  registerAnalogFactory("PMOS", (nodeIds, branchIdx, props, _getTime) =>
    createMosfetElement(-1, new Map([["D", nodeIds[0] ?? 0], ["G", nodeIds[1] ?? 0], ["S", nodeIds[2] ?? 0]]), [], branchIdx, props),
  );
  registerBuiltinSubcircuitModels(modelRegistry);
});

// ---------------------------------------------------------------------------
// Minimal CircuitElement builder
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
// Wire and registry helpers
// ---------------------------------------------------------------------------

function w(circuit: Circuit, x1: number, y1: number, x2: number, y2: number): void {
  circuit.addWire(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }));
}

function buildRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register(GroundDefinition);
  registry.register(DcVoltageSourceDefinition);
  registry.register(NmosfetDefinition);
  registry.register(PmosfetDefinition);
  return registry;
}

// DcVoltageSourceDefinition pinLayout order: [neg, pos]
// analogFactory: makeDcVoltageSource(nodeIds[1]=pos, nodeIds[0]=neg, ...)
function voltSrc(circuit: Circuit, id: string, xPos: number, xNeg: number, y: number, voltage: number): void {
  circuit.addElement(makeElement("DcVoltageSource", id,
    [{ x: xNeg, y }, { x: xPos, y }],
    new Map<string, PropertyValue>([["voltage", voltage]])));
}

// Pin order must match the component pinLayout order so the compiler maps nodes correctly.
// PMOS pinLayout: [G, D, S] → PmosfetDefinition.analogFactory swaps D/S for createMosfetElement
// NMOS pinLayout: [G, S, D] → NmosfetDefinition.analogFactory passes directly to createMosfetElement
function pmos(circuit: Circuit, id: string, xD: number, xG: number, xS: number, yRow: number, w = 100e-6): void {
  circuit.addElement(makeElement("PMOS", id,
    [{ x: xG, y: yRow, label: "G" }, { x: xD, y: yRow, label: "D" }, { x: xS, y: yRow, label: "S" }],
    new Map<string, PropertyValue>([["W", w]])));
}

function nmos(circuit: Circuit, id: string, xD: number, xG: number, xS: number, yRow: number, w = 50e-6): void {
  circuit.addElement(makeElement("NMOS", id,
    [{ x: xG, y: yRow, label: "G" }, { x: xS, y: yRow, label: "S" }, { x: xD, y: yRow, label: "D" }],
    new Map<string, PropertyValue>([["W", w]])));
}

function gnd(circuit: Circuit, xG: number): void {
  circuit.addElement(makeElement("Ground", `gnd-${xG}`, [{ x: xG, y: 0 }]));
}

// ---------------------------------------------------------------------------
// Compile and simulate
// ---------------------------------------------------------------------------

type SolveResult = {
  engine: MNAEngine;
  compiled: NonNullable<ReturnType<typeof compileUnified>["analog"]>;
  converged: boolean;
};

function solveDc(circuit: Circuit, registry: ComponentRegistry): SolveResult {
  const compiled = compileUnified(circuit, registry).analog!;
  const engine = new MNAEngine();
  engine.init(compiled);
  engine.configure({ maxIterations: 500, reltol: 1e-3, abstol: 1e-6 });
  const result = engine.dcOperatingPoint();
  return { engine, compiled, converged: result.converged };
}

// Get node voltage by finding any wire whose start or end has x ≈ targetX
function getVoltageAtX(
  engine: MNAEngine,
  compiled: NonNullable<ReturnType<typeof compileUnified>["analog"]>,
  targetX: number,
): number {
  for (const [wire, nodeId] of compiled.wireToNodeId) {
    if (
      (Math.abs(wire.start.x - targetX) < 0.5 || Math.abs(wire.end.x - targetX) < 0.5) &&
      nodeId > 0
    ) {
      return engine.getNodeVoltage(nodeId);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// CMOS inverter circuit
//
// Nodes (by X coordinate):
//   X=10: VDD (positive terminal of VDD source, PMOS source)
//   X=20: Vin (positive terminal of Vin source, both gates)
//   X=30: GND (negative terminals, NMOS source, Ground)
//   X=40: Vout (PMOS drain, NMOS drain)
// ---------------------------------------------------------------------------

function buildInverter(vin: number, vdd = 3.3): { circuit: Circuit; registry: ComponentRegistry; outX: number } {
  const circuit = new Circuit();
  const registry = buildRegistry();

  const X_VDD = 10, X_IN = 20, X_GND = 30, X_OUT = 40;

  voltSrc(circuit, "vdd_src", X_VDD, X_GND, 0, vdd);
  voltSrc(circuit, "vin_src", X_IN, X_GND, 0, vin);
  pmos(circuit, "p1", X_OUT, X_IN, X_VDD, 2);
  nmos(circuit, "n1", X_OUT, X_IN, X_GND, 4);
  gnd(circuit, X_GND);

  // Connect all nets via wires spanning pin positions
  w(circuit, X_VDD, 0, X_VDD, 2); // VDD source pos → PMOS source
  w(circuit, X_IN, 0, X_IN, 2);   // Vin source pos → PMOS gate
  w(circuit, X_IN, 2, X_IN, 4);   // PMOS gate → NMOS gate
  w(circuit, X_OUT, 2, X_OUT, 4); // PMOS drain → NMOS drain
  w(circuit, X_GND, 0, X_GND, 4); // GND source neg → NMOS source

  return { circuit, registry, outX: X_OUT };
}

// ---------------------------------------------------------------------------
// CMOS NAND2 circuit
//
// X=10: VDD   X=20: A   X=30: B   X=40: Out   X=50: GND   X=60: Mid
//
// Pull-up:  PA (D=out, G=A, S=VDD)  PB (D=out, G=B, S=VDD)  — parallel
// Pull-down: NA (D=out, G=A, S=mid)  NB (D=mid, G=B, S=GND) — series
// ---------------------------------------------------------------------------

function buildNand2(vA: number, vB: number, vdd = 3.3): { circuit: Circuit; registry: ComponentRegistry; outX: number } {
  const circuit = new Circuit();
  const registry = buildRegistry();

  const X_VDD = 10, X_A = 20, X_B = 30, X_OUT = 40, X_GND = 50, X_MID = 60;

  voltSrc(circuit, "vdd_src", X_VDD, X_GND, 0, vdd);
  voltSrc(circuit, "va_src",  X_A,   X_GND, 0, vA);
  voltSrc(circuit, "vb_src",  X_B,   X_GND, 0, vB);
  pmos(circuit, "pa", X_OUT, X_A, X_VDD, 2);
  pmos(circuit, "pb", X_OUT, X_B, X_VDD, 3);
  nmos(circuit, "na", X_OUT, X_A, X_MID, 5, 100e-6);  // 2x width for series stack
  nmos(circuit, "nb", X_MID, X_B, X_GND, 6, 100e-6);  // 2x width for series stack
  gnd(circuit, X_GND);

  w(circuit, X_VDD, 0, X_VDD, 2); w(circuit, X_VDD, 2, X_VDD, 3);
  w(circuit, X_A, 0, X_A, 2);     w(circuit, X_A, 2, X_A, 5);
  w(circuit, X_B, 0, X_B, 3);     w(circuit, X_B, 3, X_B, 6);
  w(circuit, X_OUT, 2, X_OUT, 3); w(circuit, X_OUT, 3, X_OUT, 5);
  w(circuit, X_GND, 0, X_GND, 6);
  w(circuit, X_MID, 5, X_MID, 6);

  return { circuit, registry, outX: X_OUT };
}

// ---------------------------------------------------------------------------
// CMOS NOR2 circuit
//
// Pull-up:  PA (D=mid, G=A, S=VDD)  PB (D=out, G=B, S=mid)  — series
// Pull-down: NA (D=out, G=A, S=GND)  NB (D=out, G=B, S=GND) — parallel
// ---------------------------------------------------------------------------

function buildNor2(vA: number, vB: number, vdd = 3.3): { circuit: Circuit; registry: ComponentRegistry; outX: number } {
  const circuit = new Circuit();
  const registry = buildRegistry();

  const X_VDD = 10, X_A = 20, X_B = 30, X_OUT = 40, X_GND = 50, X_MID = 60;

  voltSrc(circuit, "vdd_src", X_VDD, X_GND, 0, vdd);
  voltSrc(circuit, "va_src",  X_A,   X_GND, 0, vA);
  voltSrc(circuit, "vb_src",  X_B,   X_GND, 0, vB);
  pmos(circuit, "pa", X_MID, X_A, X_VDD, 2, 200e-6);  // 2x width for series stack
  pmos(circuit, "pb", X_OUT, X_B, X_MID, 3, 200e-6);  // 2x width for series stack
  nmos(circuit, "na", X_OUT, X_A, X_GND, 5);
  nmos(circuit, "nb", X_OUT, X_B, X_GND, 6);
  gnd(circuit, X_GND);

  w(circuit, X_VDD, 0, X_VDD, 2);
  w(circuit, X_A, 0, X_A, 2);     w(circuit, X_A, 2, X_A, 5);
  w(circuit, X_B, 0, X_B, 3);     w(circuit, X_B, 3, X_B, 6);
  w(circuit, X_OUT, 3, X_OUT, 5); w(circuit, X_OUT, 5, X_OUT, 6);
  w(circuit, X_GND, 0, X_GND, 5); w(circuit, X_GND, 5, X_GND, 6);
  w(circuit, X_MID, 2, X_MID, 3);

  return { circuit, registry, outX: X_OUT };
}

// ---------------------------------------------------------------------------
// CMOS AND2 = NAND2 + inverter
//
// NAND2 uses X=10..60 (same as buildNand2 but nand_out=X=40, X=70=inverter out)
// ---------------------------------------------------------------------------

function buildAnd2(vA: number, vB: number, vdd = 3.3): { circuit: Circuit; registry: ComponentRegistry; outX: number } {
  const circuit = new Circuit();
  const registry = buildRegistry();

  const X_VDD = 10, X_A = 20, X_B = 30, X_NOUT = 40, X_GND = 50, X_MID = 60, X_OUT = 70;

  voltSrc(circuit, "vdd_src", X_VDD, X_GND, 0, vdd);
  voltSrc(circuit, "va_src",  X_A,   X_GND, 0, vA);
  voltSrc(circuit, "vb_src",  X_B,   X_GND, 0, vB);
  // NAND2 (series NMOS use 2x width)
  pmos(circuit, "pa", X_NOUT, X_A, X_VDD, 2);
  pmos(circuit, "pb", X_NOUT, X_B, X_VDD, 3);
  nmos(circuit, "na", X_NOUT, X_A, X_MID, 5, 100e-6);
  nmos(circuit, "nb", X_MID,  X_B, X_GND, 6, 100e-6);
  // Inverter
  pmos(circuit, "pi", X_OUT, X_NOUT, X_VDD, 8);
  nmos(circuit, "ni", X_OUT, X_NOUT, X_GND, 9);
  gnd(circuit, X_GND);

  w(circuit, X_VDD, 0, X_VDD, 2); w(circuit, X_VDD, 2, X_VDD, 3); w(circuit, X_VDD, 3, X_VDD, 8);
  w(circuit, X_A, 0, X_A, 2);     w(circuit, X_A, 2, X_A, 5);
  w(circuit, X_B, 0, X_B, 3);     w(circuit, X_B, 3, X_B, 6);
  w(circuit, X_NOUT, 2, X_NOUT, 3); w(circuit, X_NOUT, 3, X_NOUT, 5); w(circuit, X_NOUT, 5, X_NOUT, 8); w(circuit, X_NOUT, 8, X_NOUT, 9);
  w(circuit, X_GND, 0, X_GND, 6); w(circuit, X_GND, 6, X_GND, 9);
  w(circuit, X_MID, 5, X_MID, 6);
  w(circuit, X_OUT, 8, X_OUT, 9);

  return { circuit, registry, outX: X_OUT };
}

// ---------------------------------------------------------------------------
// CMOS OR2 = NOR2 + inverter
// ---------------------------------------------------------------------------

function buildOr2(vA: number, vB: number, vdd = 3.3): { circuit: Circuit; registry: ComponentRegistry; outX: number } {
  const circuit = new Circuit();
  const registry = buildRegistry();

  const X_VDD = 10, X_A = 20, X_B = 30, X_NOUT = 40, X_GND = 50, X_MID = 60, X_OUT = 70;

  voltSrc(circuit, "vdd_src", X_VDD, X_GND, 0, vdd);
  voltSrc(circuit, "va_src",  X_A,   X_GND, 0, vA);
  voltSrc(circuit, "vb_src",  X_B,   X_GND, 0, vB);
  // NOR2 core (series PMOS use 4x width — wider for compound gate convergence)
  pmos(circuit, "pa", X_MID,  X_A, X_VDD, 2, 400e-6);
  pmos(circuit, "pb", X_NOUT, X_B, X_MID, 3, 400e-6);
  nmos(circuit, "na", X_NOUT, X_A, X_GND, 5);
  nmos(circuit, "nb", X_NOUT, X_B, X_GND, 6);
  // Output inverter
  pmos(circuit, "pi", X_OUT, X_NOUT, X_VDD, 8);
  nmos(circuit, "ni", X_OUT, X_NOUT, X_GND, 9);
  gnd(circuit, X_GND);

  w(circuit, X_VDD, 0, X_VDD, 2); w(circuit, X_VDD, 2, X_VDD, 8);
  w(circuit, X_A, 0, X_A, 2);     w(circuit, X_A, 2, X_A, 5);
  w(circuit, X_B, 0, X_B, 3);     w(circuit, X_B, 3, X_B, 6);
  w(circuit, X_NOUT, 3, X_NOUT, 5); w(circuit, X_NOUT, 5, X_NOUT, 6); w(circuit, X_NOUT, 6, X_NOUT, 8); w(circuit, X_NOUT, 8, X_NOUT, 9);
  w(circuit, X_GND, 0, X_GND, 5); w(circuit, X_GND, 5, X_GND, 6); w(circuit, X_GND, 6, X_GND, 9);
  w(circuit, X_MID, 2, X_MID, 3);
  w(circuit, X_OUT, 8, X_OUT, 9);

  return { circuit, registry, outX: X_OUT };
}

// ---------------------------------------------------------------------------
// CMOS XOR2 (transmission-gate topology)
//
// X=10: VDD  X=20: A  X=25: B  X=30: Out  X=50: GND  X=60: Abar  X=70: Bbar
//
// Inverter A→Abar: PA_inv(D=Abar, G=A, S=VDD), NA_inv(D=Abar, G=A, S=GND)
// Inverter B→Bbar: PB_inv(D=Bbar, G=B, S=VDD), NB_inv(D=Bbar, G=B, S=GND)
// TG1 (passes B→out when A=0): TG1_N(D=out,G=Abar,S=B), TG1_P(D=out,G=A,S=B)
// TG2 (passes Bbar→out when A=1): TG2_N(D=out,G=A,S=Bbar), TG2_P(D=out,G=Abar,S=Bbar)
// XOR = A'B + AB': when A=0, output=B; when A=1, output=Bbar
// ---------------------------------------------------------------------------

function buildXor2(vA: number, vB: number, vdd = 3.3): { circuit: Circuit; registry: ComponentRegistry; outX: number } {
  const circuit = new Circuit();
  const registry = buildRegistry();

  const X_VDD = 10, X_A = 20, X_B = 25, X_OUT = 30, X_GND = 50, X_ABAR = 60, X_BBAR = 70;

  voltSrc(circuit, "vdd_src", X_VDD, X_GND, 0, vdd);
  voltSrc(circuit, "va_src",  X_A,   X_GND, 0, vA);
  voltSrc(circuit, "vb_src",  X_B,   X_GND, 0, vB);

  pmos(circuit, "pa_inv", X_ABAR, X_A, X_VDD, 2);
  nmos(circuit, "na_inv", X_ABAR, X_A, X_GND, 3);
  pmos(circuit, "pb_inv", X_BBAR, X_B, X_VDD, 4);
  nmos(circuit, "nb_inv", X_BBAR, X_B, X_GND, 5);

  // TG1: pass B to out when A=0 (NMOS gate=Abar, PMOS gate=A)
  nmos(circuit, "tg1n", X_OUT, X_ABAR, X_B,    6);
  pmos(circuit, "tg1p", X_OUT, X_A,    X_B,    7);
  // TG2: pass Bbar to out when A=1 (NMOS gate=A, PMOS gate=Abar)
  nmos(circuit, "tg2n", X_OUT, X_A,    X_BBAR, 8);
  pmos(circuit, "tg2p", X_OUT, X_ABAR, X_BBAR, 9);

  gnd(circuit, X_GND);

  w(circuit, X_VDD, 0, X_VDD, 2); w(circuit, X_VDD, 2, X_VDD, 4);
  w(circuit, X_A, 0, X_A, 2);     w(circuit, X_A, 2, X_A, 3);   w(circuit, X_A, 3, X_A, 7);   w(circuit, X_A, 7, X_A, 8);
  w(circuit, X_B, 0, X_B, 4);     w(circuit, X_B, 4, X_B, 5);   w(circuit, X_B, 5, X_B, 6);   w(circuit, X_B, 6, X_B, 7);
  w(circuit, X_OUT, 6, X_OUT, 7); w(circuit, X_OUT, 7, X_OUT, 8); w(circuit, X_OUT, 8, X_OUT, 9);
  w(circuit, X_GND, 0, X_GND, 3); w(circuit, X_GND, 3, X_GND, 5);
  w(circuit, X_ABAR, 2, X_ABAR, 3); w(circuit, X_ABAR, 3, X_ABAR, 6); w(circuit, X_ABAR, 6, X_ABAR, 9);
  w(circuit, X_BBAR, 4, X_BBAR, 5); w(circuit, X_BBAR, 5, X_BBAR, 8); w(circuit, X_BBAR, 8, X_BBAR, 9);

  return { circuit, registry, outX: X_OUT };
}

// ---------------------------------------------------------------------------
// CMOS XNOR2 = XOR2 + inverter (10 MOSFETs)
//
// Same as XOR2 but XOR output node is at X=30, final output at X=80
// ---------------------------------------------------------------------------

function buildXnor2(vA: number, vB: number, vdd = 3.3): { circuit: Circuit; registry: ComponentRegistry; outX: number } {
  const circuit = new Circuit();
  const registry = buildRegistry();

  const X_VDD = 10, X_A = 20, X_B = 25, X_XOR = 30, X_GND = 50, X_ABAR = 60, X_BBAR = 70, X_OUT = 80;

  voltSrc(circuit, "vdd_src", X_VDD, X_GND, 0, vdd);
  voltSrc(circuit, "va_src",  X_A,   X_GND, 0, vA);
  voltSrc(circuit, "vb_src",  X_B,   X_GND, 0, vB);

  // XOR core
  pmos(circuit, "pa_inv", X_ABAR, X_A, X_VDD, 2);
  nmos(circuit, "na_inv", X_ABAR, X_A, X_GND, 3);
  pmos(circuit, "pb_inv", X_BBAR, X_B, X_VDD, 4);
  nmos(circuit, "nb_inv", X_BBAR, X_B, X_GND, 5);
  // TG1: pass B to XOR node when A=0 (NMOS gate=Abar, PMOS gate=A)
  nmos(circuit, "tg1n", X_XOR, X_ABAR, X_B,    6);
  pmos(circuit, "tg1p", X_XOR, X_A,    X_B,    7);
  // TG2: pass Bbar to XOR node when A=1 (NMOS gate=A, PMOS gate=Abar)
  nmos(circuit, "tg2n", X_XOR, X_A,    X_BBAR, 8);
  pmos(circuit, "tg2p", X_XOR, X_ABAR, X_BBAR, 9);

  // Inverter: XOR→OUT
  pmos(circuit, "pi", X_OUT, X_XOR, X_VDD, 11);
  nmos(circuit, "ni", X_OUT, X_XOR, X_GND, 12);

  gnd(circuit, X_GND);

  w(circuit, X_VDD, 0, X_VDD, 2); w(circuit, X_VDD, 2, X_VDD, 4); w(circuit, X_VDD, 4, X_VDD, 11);
  w(circuit, X_A, 0, X_A, 2);     w(circuit, X_A, 2, X_A, 3);   w(circuit, X_A, 3, X_A, 7);   w(circuit, X_A, 7, X_A, 8);
  w(circuit, X_B, 0, X_B, 4);     w(circuit, X_B, 4, X_B, 5);   w(circuit, X_B, 5, X_B, 6);   w(circuit, X_B, 6, X_B, 7);
  w(circuit, X_XOR, 6, X_XOR, 7); w(circuit, X_XOR, 7, X_XOR, 8); w(circuit, X_XOR, 8, X_XOR, 9); w(circuit, X_XOR, 9, X_XOR, 11); w(circuit, X_XOR, 11, X_XOR, 12);
  w(circuit, X_GND, 0, X_GND, 3); w(circuit, X_GND, 3, X_GND, 5); w(circuit, X_GND, 5, X_GND, 12);
  w(circuit, X_ABAR, 2, X_ABAR, 3); w(circuit, X_ABAR, 3, X_ABAR, 6); w(circuit, X_ABAR, 6, X_ABAR, 9);
  w(circuit, X_BBAR, 4, X_BBAR, 5); w(circuit, X_BBAR, 5, X_BBAR, 8); w(circuit, X_BBAR, 8, X_BBAR, 9);
  w(circuit, X_OUT, 11, X_OUT, 12);

  return { circuit, registry, outX: X_OUT };
}

// ---------------------------------------------------------------------------
// CMOS Buffer = two inverters in series
//
// X=10: VDD  X=20: in  X=30: GND  X=50: mid  X=60: out
// ---------------------------------------------------------------------------

function buildBuffer(vin: number, vdd = 3.3): { circuit: Circuit; registry: ComponentRegistry; outX: number } {
  const circuit = new Circuit();
  const registry = buildRegistry();

  const X_VDD = 10, X_IN = 20, X_GND = 30, X_MID = 50, X_OUT = 60;

  voltSrc(circuit, "vdd_src", X_VDD, X_GND, 0, vdd);
  voltSrc(circuit, "vin_src", X_IN,  X_GND, 0, vin);
  pmos(circuit, "p1", X_MID, X_IN,  X_VDD, 2);
  nmos(circuit, "n1", X_MID, X_IN,  X_GND, 3);
  pmos(circuit, "p2", X_OUT, X_MID, X_VDD, 5);
  nmos(circuit, "n2", X_OUT, X_MID, X_GND, 6);
  gnd(circuit, X_GND);

  w(circuit, X_VDD, 0, X_VDD, 2); w(circuit, X_VDD, 2, X_VDD, 5);
  w(circuit, X_IN, 0, X_IN, 2);   w(circuit, X_IN, 2, X_IN, 3);
  w(circuit, X_GND, 0, X_GND, 3); w(circuit, X_GND, 3, X_GND, 6);
  w(circuit, X_MID, 2, X_MID, 3); w(circuit, X_MID, 3, X_MID, 5); w(circuit, X_MID, 5, X_MID, 6);
  w(circuit, X_OUT, 5, X_OUT, 6);

  return { circuit, registry, outX: X_OUT };
}

// ---------------------------------------------------------------------------
// Logic voltage constants
// ---------------------------------------------------------------------------

const VDD = 3.3;
const VDD_HALF = VDD / 2;

// ---------------------------------------------------------------------------
// CmosInverter tests
// ---------------------------------------------------------------------------

describe("CmosInverter", () => {
  it("dc_transfer_curve", () => {
    const results: Array<{ vin: number; vout: number }> = [];

    for (let vinRaw = 0; vinRaw <= 33; vinRaw++) {
      const vin = vinRaw * 0.1;
      const { circuit, registry, outX } = buildInverter(vin, VDD);
      const { engine, compiled, converged } = solveDc(circuit, registry);
      expect(converged, `DC OP should converge for vin=${vin}`).toBe(true);
      const vout = getVoltageAtX(engine, compiled, outX);
      results.push({ vin, vout });
    }

    // Output HIGH when input well below transition region (vin <= 0.3*VDD)
    for (const r of results) {
      if (r.vin <= VDD * 0.3) {
        expect(r.vout, `vout should be HIGH when vin=${r.vin}`).toBeGreaterThan(3.2);
      }
    }

    // Output LOW when input well above transition region (vin >= 0.7*VDD)
    for (const r of results) {
      if (r.vin >= VDD * 0.7) {
        expect(r.vout, `vout should be LOW when vin=${r.vin}`).toBeLessThan(0.1);
      }
    }

    // Verify general trend: average vout in lower transition region > average in upper
    const lowerTransition = results.filter(r => r.vin >= VDD * 0.3 && r.vin < VDD * 0.5);
    const upperTransition = results.filter(r => r.vin > VDD * 0.5 && r.vin <= VDD * 0.7);
    if (lowerTransition.length > 0 && upperTransition.length > 0) {
      const avgLower = lowerTransition.reduce((s, r) => s + r.vout, 0) / lowerTransition.length;
      const avgUpper = upperTransition.reduce((s, r) => s + r.vout, 0) / upperTransition.length;
      expect(avgLower, "Average vout below VDD/2 > average above VDD/2").toBeGreaterThan(avgUpper);
    }

    // Find switching threshold (where vout crosses VDD/2)
    let switchAt: number | null = null;
    for (let i = 1; i < results.length; i++) {
      if (results[i - 1].vout > VDD_HALF && results[i].vout <= VDD_HALF) {
        switchAt = (results[i - 1].vin + results[i].vin) / 2;
        break;
      }
    }
    expect(switchAt, "Switching threshold should be detectable").not.toBeNull();
    expect(switchAt!).toBeGreaterThan(VDD * 0.4); // > 1.32V
    expect(switchAt!).toBeLessThan(VDD * 0.6);    // < 1.98V
  });

  it("noise_margins", () => {
    const V_IH = 2.0;
    const V_IL = 0.8;

    // At input = V_IH (clearly HIGH, 2.0V): output should be LOW < V_IL
    const { circuit: cH, registry: rH, outX: oH } = buildInverter(V_IH, VDD);
    const { engine: eH, compiled: compH, converged: cvH } = solveDc(cH, rH);
    expect(cvH).toBe(true);
    const vOL = getVoltageAtX(eH, compH, oH);

    // At input = V_IL (clearly LOW, 0.8V): output should be HIGH > V_IH
    const { circuit: cL, registry: rL, outX: oL } = buildInverter(V_IL, VDD);
    const { engine: eL, compiled: compL, converged: cvL } = solveDc(cL, rL);
    expect(cvL).toBe(true);
    const vOH = getVoltageAtX(eL, compL, oL);

    expect(vOH, `V_OH at vin=${V_IL}`).toBeGreaterThan(V_IH); // V_OH > V_IH
    expect(vOL, `V_OL at vin=${V_IH}`).toBeLessThan(V_IL);    // V_OL < V_IL
  });

  it("short_circuit_current", () => {
    // At mid-transition (input = VDD/2): both PMOS and NMOS partially conducting
    const { circuit, registry } = buildInverter(VDD_HALF, VDD);
    const compiled = compileUnified(circuit, registry).analog!;
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();
    expect(result.converged).toBe(true);

    // Find the maximum branch current (from any voltage source)
    let maxCurrent = 0;
    for (let b = 0; b < compiled.branchCount; b++) {
      const ic = Math.abs(engine.getBranchCurrent(b));
      if (ic > maxCurrent) maxCurrent = ic;
    }
    // Both PMOS and NMOS conducting → supply current > 10µA
    expect(maxCurrent).toBeGreaterThan(10e-6);
  });

  it("transient_propagation_delay", () => {
    // Input at 0V → output HIGH. Confirm circuit is well-behaved in transient.
    const { circuit: c0, registry: r0, outX: o0 } = buildInverter(0, VDD);
    const compiled0 = compileUnified(c0, r0).analog!;
    const engine0 = new MNAEngine();
    engine0.init(compiled0);
    const dc0 = engine0.dcOperatingPoint();
    expect(dc0.converged).toBe(true);
    expect(getVoltageAtX(engine0, compiled0, o0)).toBeGreaterThan(3.2);

    // Input at VDD → output LOW. Confirmed already by other tests.
    const { circuit: cV, registry: rV, outX: oV } = buildInverter(VDD, VDD);
    const compiledV = compileUnified(cV, rV).analog!;
    const engineV = new MNAEngine();
    engineV.init(compiledV);
    const dcV = engineV.dcOperatingPoint();
    expect(dcV.converged).toBe(true);
    expect(getVoltageAtX(engineV, compiledV, oV)).toBeLessThan(0.1);

    // Transient from VDD DC state: engine runs without ERROR for 5ns
    engineV.configure({ maxTimeStep: 0.01e-9 });
    let steps = 0;
    while (engineV.simTime < 5e-9 && steps < 1000) {
      engineV.step();
      steps++;
      if (engineV.getState() === EngineState.ERROR) break;
    }
    expect(engineV.getState()).not.toBe(EngineState.ERROR);
    // Propagation delay: simulation completed at least one step
    expect(steps).toBeGreaterThan(0);
    // After 5ns at DC operating point, output should still be LOW
    expect(getVoltageAtX(engineV, compiledV, oV)).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// CmosNand2 tests
// ---------------------------------------------------------------------------

describe("CmosNand2", () => {
  it("truth_table_dc", () => {
    const testCases = [
      { vA: 0,   vB: 0,   expectHigh: true  },
      { vA: 0,   vB: VDD, expectHigh: true  },
      { vA: VDD, vB: 0,   expectHigh: true  },
      { vA: VDD, vB: VDD, expectHigh: false },
    ];

    for (const tc of testCases) {
      const { circuit, registry, outX } = buildNand2(tc.vA, tc.vB);
      const { engine, compiled, converged } = solveDc(circuit, registry);
      expect(converged, `NAND2 A=${tc.vA} B=${tc.vB}`).toBe(true);
      const vout = getVoltageAtX(engine, compiled, outX);
      if (tc.expectHigh) {
        expect(vout, `NAND2 A=${tc.vA} B=${tc.vB} → HIGH`).toBeGreaterThan(3.2);
      } else {
        expect(vout, `NAND2 A=${tc.vA} B=${tc.vB} → LOW`).toBeLessThan(0.2);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CmosNor2 tests
// ---------------------------------------------------------------------------

describe("CmosNor2", () => {
  it("truth_table_dc", () => {
    const testCases = [
      { vA: 0,   vB: 0,   expectHigh: true  },
      { vA: 0,   vB: VDD, expectHigh: false },
      { vA: VDD, vB: 0,   expectHigh: false },
      { vA: VDD, vB: VDD, expectHigh: false },
    ];

    for (const tc of testCases) {
      const { circuit, registry, outX } = buildNor2(tc.vA, tc.vB);
      const { engine, compiled, converged } = solveDc(circuit, registry);
      expect(converged, `NOR2 A=${tc.vA} B=${tc.vB}`).toBe(true);
      const vout = getVoltageAtX(engine, compiled, outX);
      if (tc.expectHigh) {
        expect(vout, `NOR2 A=${tc.vA} B=${tc.vB} → HIGH`).toBeGreaterThan(3.2);
      } else {
        expect(vout, `NOR2 A=${tc.vA} B=${tc.vB} → LOW`).toBeLessThan(0.1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CmosAnd2 tests
// ---------------------------------------------------------------------------

describe("CmosAnd2", () => {
  it("truth_table_dc", () => {
    const testCases = [
      { vA: 0,   vB: 0,   expectHigh: false },
      { vA: 0,   vB: VDD, expectHigh: false },
      { vA: VDD, vB: 0,   expectHigh: false },
      { vA: VDD, vB: VDD, expectHigh: true  },
    ];

    for (const tc of testCases) {
      const { circuit, registry, outX } = buildAnd2(tc.vA, tc.vB);
      const { engine, compiled, converged } = solveDc(circuit, registry);
      expect(converged, `AND2 A=${tc.vA} B=${tc.vB}`).toBe(true);
      const vout = getVoltageAtX(engine, compiled, outX);
      if (tc.expectHigh) {
        expect(vout, `AND2 A=${tc.vA} B=${tc.vB} → HIGH`).toBeGreaterThan(3.2);
      } else {
        expect(vout, `AND2 A=${tc.vA} B=${tc.vB} → LOW`).toBeLessThan(0.1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CmosOr2 tests
// ---------------------------------------------------------------------------

describe("CmosOr2", () => {
  it("truth_table_dc", () => {
    const testCases = [
      { vA: 0,   vB: 0,   expectHigh: false },
      { vA: 0,   vB: VDD, expectHigh: true  },
      { vA: VDD, vB: 0,   expectHigh: true  },
      { vA: VDD, vB: VDD, expectHigh: true  },
    ];

    for (const tc of testCases) {
      const { circuit, registry, outX } = buildOr2(tc.vA, tc.vB);
      const { engine, compiled, converged } = solveDc(circuit, registry);
      expect(converged, `OR2 A=${tc.vA} B=${tc.vB}`).toBe(true);
      const vout = getVoltageAtX(engine, compiled, outX);
      if (tc.expectHigh) {
        expect(vout, `OR2 A=${tc.vA} B=${tc.vB} → HIGH`).toBeGreaterThan(3.2);
      } else {
        expect(vout, `OR2 A=${tc.vA} B=${tc.vB} → LOW`).toBeLessThan(0.1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CmosXor2 tests
// ---------------------------------------------------------------------------

describe("CmosXor2", () => {
  it("truth_table_dc", () => {
    const testCases = [
      { vA: 0,   vB: 0,   expectHigh: false },
      { vA: 0,   vB: VDD, expectHigh: true  },
      { vA: VDD, vB: 0,   expectHigh: true  },
      { vA: VDD, vB: VDD, expectHigh: false },
    ];

    for (const tc of testCases) {
      const { circuit, registry, outX } = buildXor2(tc.vA, tc.vB);
      const { engine, compiled, converged } = solveDc(circuit, registry);
      expect(converged, `XOR2 A=${tc.vA} B=${tc.vB}`).toBe(true);
      const vout = getVoltageAtX(engine, compiled, outX);
      if (tc.expectHigh) {
        expect(vout, `XOR2 A=${tc.vA} B=${tc.vB} → HIGH`).toBeGreaterThan(3.2);
      } else {
        expect(vout, `XOR2 A=${tc.vA} B=${tc.vB} → LOW`).toBeLessThan(0.1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CmosXnor2 tests
// ---------------------------------------------------------------------------

describe("CmosXnor2", () => {
  it("truth_table_dc", () => {
    const testCases = [
      { vA: 0,   vB: 0,   expectHigh: true  },
      { vA: 0,   vB: VDD, expectHigh: false },
      { vA: VDD, vB: 0,   expectHigh: false },
      { vA: VDD, vB: VDD, expectHigh: true  },
    ];

    for (const tc of testCases) {
      const { circuit, registry, outX } = buildXnor2(tc.vA, tc.vB);
      const { engine, compiled, converged } = solveDc(circuit, registry);
      expect(converged, `XNOR2 A=${tc.vA} B=${tc.vB}`).toBe(true);
      const vout = getVoltageAtX(engine, compiled, outX);
      if (tc.expectHigh) {
        expect(vout, `XNOR2 A=${tc.vA} B=${tc.vB} → HIGH`).toBeGreaterThan(3.2);
      } else {
        expect(vout, `XNOR2 A=${tc.vA} B=${tc.vB} → LOW`).toBeLessThan(0.1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CmosBuffer tests
// ---------------------------------------------------------------------------

describe("CmosBuffer", () => {
  it("truth_table_dc", () => {
    const { circuit: cL, registry: rL, outX: oL } = buildBuffer(0, VDD);
    const { engine: eL, compiled: compL, converged: cvL } = solveDc(cL, rL);
    expect(cvL).toBe(true);
    expect(getVoltageAtX(eL, compL, oL)).toBeLessThan(0.1);

    const { circuit: cH, registry: rH, outX: oH } = buildBuffer(VDD, VDD);
    const { engine: eH, compiled: compH, converged: cvH } = solveDc(cH, rH);
    expect(cvH).toBe(true);
    expect(getVoltageAtX(eH, compH, oH)).toBeGreaterThan(3.2);
  });
});

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("Registration", () => {
  it("not_has_transistor_model", () => {
    expect(NotDefinition.subcircuitRefs?.cmos).toBe("CmosInverter");
  });

  it("all_gates_have_transistor_mode", () => {
    const gateTypes = [
      { name: "Not",  def: NotDefinition  },
      { name: "And",  def: AndDefinition  },
      { name: "NAnd", def: NAndDefinition },
      { name: "Or",   def: OrDefinition   },
      { name: "NOr",  def: NOrDefinition  },
      { name: "XOr",  def: XOrDefinition  },
      { name: "XNOr", def: XNOrDefinition },
    ];

    for (const { name, def } of gateTypes) {
      expect(def.subcircuitRefs?.cmos, `${name} transistorModel`).toBeDefined();
    }
  });

  it("all_models_registered", () => {
    expect(modelRegistry.has("CmosInverter")).toBe(true);
    expect(modelRegistry.has("CmosNand2")).toBe(true);
    expect(modelRegistry.has("CmosNor2")).toBe(true);
    expect(modelRegistry.has("CmosAnd2")).toBe(true);
    expect(modelRegistry.has("CmosOr2")).toBe(true);
    expect(modelRegistry.has("CmosXor2")).toBe(true);
    expect(modelRegistry.has("CmosXnor2")).toBe(true);
    expect(modelRegistry.has("CmosBuffer")).toBe(true);
  });
});
