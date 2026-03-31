/**
 * Tests for Task 4.2: Switch Network Integration.
 *
 * Verifies:
 * - NFET forwards drain→source when gate is high (unidirectional)
 * - NFET sets highZ on source when gate is low (unidirectional)
 * - TransGate closes when S!=~S and S=1
 * - TransGate burn when S==~S (non-highZ) — treated as open in current implementation
 * - TransGate open when control is highZ
 * - Bidirectional switch triggers bus reconfiguration
 * - Unidirectional NFET not in switchComponentIndices
 * - Bidirectional switch registered with bus resolver
 * - Switch feedback converges
 */

import { describe, it, expect } from "vitest";
import type { ComponentLayout, ExecuteFunction } from "@/core/registry";
import { executeNFET } from "../../../components/switching/nfet.js";
import { executePFET as _executePFET } from "../../../components/switching/pfet.js";
import { executeTransGate } from "../../../components/switching/trans-gate.js";
import { compileUnified } from "@/compile/compile.js";
import { DigitalEngine } from "../digital-engine.js";
import { BusResolver } from "../bus-resolution.js";
import { Circuit, Wire } from "@/core/circuit";
import { ComponentRegistry, ComponentCategory } from "@/core/registry";
import type { ComponentDefinition, DigitalModel } from "@/core/registry";
import type { PinDeclaration } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import type { } from "@/core/renderer-interface";
import { PropertyBag } from "@/core/properties";
import { createTestElementFromDecls } from '@/test-fixtures/test-element.js';
import { noopExecFn } from '@/test-fixtures/execute-stubs.js';

// ---------------------------------------------------------------------------
// Helpers: mock layout for unit tests
// ---------------------------------------------------------------------------

function makeLayout(opts: {
  inputOffset: number;
  outputOffset: number;
  stateOffset: number;
  wiringTable: Int32Array;
  switchClassification?: number;
}): ComponentLayout {
  return {
    wiringTable: opts.wiringTable,
    inputCount: () => 1,
    inputOffset: () => opts.inputOffset,
    outputCount: () => 2,
    outputOffset: () => opts.outputOffset,
    stateOffset: () => opts.stateOffset,
    getSwitchClassification: () => opts.switchClassification ?? 1,
    getProperty: () => undefined,
  };
}

function makeTransGateLayout(opts: {
  inputOffset: number;
  outputOffset: number;
  stateOffset: number;
  wiringTable: Int32Array;
  switchClassification?: number;
}): ComponentLayout {
  return {
    wiringTable: opts.wiringTable,
    inputCount: () => 2,
    inputOffset: () => opts.inputOffset,
    outputCount: () => 2,
    outputOffset: () => opts.outputOffset,
    stateOffset: () => opts.stateOffset,
    getSwitchClassification: () => opts.switchClassification ?? 1,
    getProperty: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Integration test helpers
// ---------------------------------------------------------------------------




function outputOnlyPin(position: { x: number; y: number }): PinDeclaration[] {
  return [
    { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

function nfetPins(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "G", defaultBitWidth: 1, position: { x: 0, y: 1.5 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.BIDIRECTIONAL, label: "D", defaultBitWidth: 1, position: { x: 3, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.BIDIRECTIONAL, label: "S", defaultBitWidth: 1, position: { x: 3, y: 3 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

type ExtraDefFields = Partial<ComponentDefinition> & Pick<DigitalModel, 'stateSlotCount' | 'switchPins' | 'defaultDelay'>;

function makeDefinition(
  name: string,
  pins: PinDeclaration[],
  executeFn: ExecuteFunction = noopExecFn,
  extra?: ExtraDefFields,
): ComponentDefinition {
  const { stateSlotCount, switchPins, defaultDelay, ...restExtra } = extra ?? {};
  return {
    name,
    typeId: -1,
    factory: (props: PropertyBag) =>
      createTestElementFromDecls(name, crypto.randomUUID(), pins, props),
    pinLayout: pins,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.SWITCHING,
    helpText: "",
    models: {
      digital: {
        executeFn,
        ...(stateSlotCount !== undefined ? { stateSlotCount } : {}),
        ...(switchPins !== undefined ? { switchPins } : {}),
        ...(defaultDelay !== undefined ? { defaultDelay } : {}),
      },
    },
    ...restExtra,
  };
}

function makeRegistry(...defs: ComponentDefinition[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const def of defs) {
    registry.register(def);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// SwitchNetwork tests
// ---------------------------------------------------------------------------

describe("SwitchNetwork", () => {
  it("nfet_forwards_when_gate_high", () => {
    // NFET with gate=1 should forward drain value to source (unidirectional)
    // Layout: G=net0, D=net1(output0), S=net2(output1), state at slot 3
    const wt = Int32Array.from([0, 1, 2]);
    const state = new Uint32Array(5);
    const highZs = new Uint32Array(5);

    state[0] = 1; // G = 1
    state[1] = 1; // D = 1
    highZs[2] = 0xffffffff; // S starts highZ

    const layout = makeLayout({
      inputOffset: 0,
      outputOffset: 1,
      stateOffset: 3,
      wiringTable: wt,
      switchClassification: 1,
    });

    executeNFET(0, state, highZs, layout);

    expect(state[3]).toBe(1); // closedFlag = 1
    expect(state[2]).toBe(1); // source = drain value
    expect(highZs[2]).toBe(0); // source not highZ
  });

  it("nfet_highz_when_gate_low", () => {
    // NFET with gate=0 should set source to highZ (unidirectional)
    const wt = Int32Array.from([0, 1, 2]);
    const state = new Uint32Array(5);
    const highZs = new Uint32Array(5);

    state[0] = 0; // G = 0
    state[1] = 1; // D = 1
    state[2] = 1; // S has some value

    const layout = makeLayout({
      inputOffset: 0,
      outputOffset: 1,
      stateOffset: 3,
      wiringTable: wt,
      switchClassification: 1,
    });

    executeNFET(0, state, highZs, layout);

    expect(state[3]).toBe(0); // closedFlag = 0
    expect(highZs[2]).toBe(0xffffffff); // source is highZ
  });

  it("transgate_closed_when_s_neq_ns", () => {
    // TransGate with S=1, ~S=0 should be closed
    // Layout: S=net0, ~S=net1 (inputs), A=net2, B=net3 (outputs), state at slot 4
    const wt = Int32Array.from([0, 1, 2, 3]);
    const state = new Uint32Array(6);
    const highZs = new Uint32Array(6);

    state[0] = 1; // S = 1
    state[1] = 0; // ~S = 0
    state[2] = 1; // A = 1

    const layout = makeTransGateLayout({
      inputOffset: 0,
      outputOffset: 2,
      stateOffset: 4,
      wiringTable: wt,
      switchClassification: 1,
    });

    executeTransGate(0, state, highZs, layout);

    expect(state[4]).toBe(1); // closedFlag = 1
    expect(state[3]).toBe(1); // B = A value (forwarded)
    expect(highZs[3]).toBe(0); // B not highZ
  });

  it("transgate_open_when_s_eq_ns", () => {
    // TransGate with S=1, ~S=1 (invalid) should be open (closedFlag=0)
    const wt = Int32Array.from([0, 1, 2, 3]);
    const state = new Uint32Array(6);
    const highZs = new Uint32Array(6);

    state[0] = 1; // S = 1
    state[1] = 1; // ~S = 1 (invalid — same as S)
    state[2] = 1; // A = 1

    const layout = makeTransGateLayout({
      inputOffset: 0,
      outputOffset: 2,
      stateOffset: 4,
      wiringTable: wt,
      switchClassification: 1,
    });

    executeTransGate(0, state, highZs, layout);

    expect(state[4]).toBe(0); // closedFlag = 0 (open — S == ~S)
    expect(highZs[3]).toBe(0xffffffff); // B is highZ (disconnected)
  });

  it("transgate_open_when_control_highz", () => {
    // TransGate with S=highZ should be open
    const wt = Int32Array.from([0, 1, 2, 3]);
    const state = new Uint32Array(6);
    const highZs = new Uint32Array(6);

    highZs[0] = 0xffffffff; // S is highZ
    state[1] = 0; // ~S = 0
    state[2] = 1; // A = 1

    const layout = makeTransGateLayout({
      inputOffset: 0,
      outputOffset: 2,
      stateOffset: 4,
      wiringTable: wt,
      switchClassification: 1,
    });

    executeTransGate(0, state, highZs, layout);

    expect(state[4]).toBe(0); // closedFlag = 0 (S is highZ)
    expect(highZs[3]).toBe(0xffffffff); // B is highZ (disconnected)
  });

  it("unidirectional_nfet_no_bus_resolver", () => {
    // Single-driver NFET circuit: both switch-pair pins connect to single-driver nets.
    // Compiler should classify as unidirectional (not in switchComponentIndices).

    // DriverA at (0,0) with output at relative (2,0) => world (2,0)
    // NFET: G input at (0,1.5), D bidir at (3,0), S bidir at (3,3)
    //   placed at (5,0) => G world (5,1.5), D world (8,0), S world (8,3)
    // Wire from DriverA output (2,0) to NFET G (5,1.5) — but positions must match.
    // Let's simplify: use matching pin positions.

    const driverPins = outputOnlyPin({ x: 2, y: 0 });
    const nfetPinDecls = nfetPins();

    const nfetExec: ExecuteFunction = (idx, st, hz, lay) => {
      const wt = lay.wiringTable;
      const inBase = lay.inputOffset(idx);
      const outBase = lay.outputOffset(idx);
      const stBase = lay.stateOffset(idx);
      const gate = st[wt[inBase]!]! & 1;
      st[stBase] = gate;
      const classification = lay.getSwitchClassification?.(idx) ?? 1;
      if (classification !== 2) {
        const drainNet = wt[outBase]!;
        const sourceNet = wt[outBase + 1]!;
        if (gate) {
          st[sourceNet] = st[drainNet]!;
          hz[sourceNet] = 0;
        } else {
          hz[sourceNet] = 0xffffffff;
        }
      }
    };

    const driverDef = makeDefinition("DriverA", driverPins, (idx, st, hz, lay) => {
      const wt = lay.wiringTable;
      st[wt[lay.outputOffset(idx)]!] = 1;
      hz[wt[lay.outputOffset(idx)]!] = 0;
    });
    const nfetDef = makeDefinition("NFET", nfetPinDecls, nfetExec, {
      stateSlotCount: 1,
      switchPins: [1, 2],
    });
    const registry = makeRegistry(driverDef, nfetDef);

    const circuit = new Circuit();
    // DriverA at (0,0), output pin at (2,0) => world (2,0)
    const elA = createTestElementFromDecls("DriverA", "a1", driverPins);
    // NFET at (0,0), G at (0,1.5), D at (3,0), S at (3,3)
    // We need G to be wired to the driver output.
    // Place NFET so G pin world pos matches driver output world pos.
    // G relative (0,1.5) + NFET pos = driver output world (2,0)
    // => NFET pos = (2, -1.5)
    const elN = createTestElementFromDecls("NFET", "n1", nfetPinDecls, undefined, { x: 2, y: -1.5 });
    circuit.addElement(elA);
    circuit.addElement(elN);

    // No extra wires needed since pins overlap

    const compiled = compileUnified(circuit, registry).digital!;

    // NFET should be classified as unidirectional (1) not bidirectional (2)
    // since D and S nets each have only one driver
    expect(compiled.switchComponentIndices.length).toBe(0);

    // Check classification
    let nfetIdx = -1;
    for (const [idx, el] of compiled.componentToElement) {
      if (el.typeId === "NFET") nfetIdx = idx;
    }
    expect(nfetIdx).toBeGreaterThanOrEqual(0);
    expect(compiled.switchClassification[nfetIdx]).toBe(1);
  });

  it("bidirectional_switch_registered_with_bus_resolver", () => {
    // Create NFET where both switch-pair pins connect to multi-driver nets.
    // This requires each side of the NFET to have 2+ drivers.

    const driverPins = outputOnlyPin({ x: 2, y: 0 });
    const nfetPinDecls = nfetPins();

    const nfetExec: ExecuteFunction = (idx, st, _hz, lay) => {
      const inBase = lay.inputOffset(idx);
      const stBase = lay.stateOffset(idx);
      st[stBase] = st[lay.wiringTable[inBase]!]! & 1;
    };

    const driverExec: ExecuteFunction = (idx, st, hz, lay) => {
      const wt = lay.wiringTable;
      const outIdx = wt[lay.outputOffset(idx)]!;
      st[outIdx] = 0;
      hz[outIdx] = 0xffffffff; // highZ so no burn
    };

    const driverADef = makeDefinition("DriverA", driverPins, driverExec);
    const driverBDef = makeDefinition("DriverB", driverPins, driverExec);
    const driverCDef = makeDefinition("DriverC", driverPins, driverExec);
    const driverDDef = makeDefinition("DriverD", driverPins, driverExec);
    const nfetDef = makeDefinition("NFET", nfetPinDecls, nfetExec, {
      stateSlotCount: 1,
      switchPins: [1, 2],
    });
    makeRegistry(driverADef, driverBDef, driverCDef, driverDDef, nfetDef);

    const circuit = new Circuit();

    // NFET at (10, 0): G at (10,1.5), D at (13,0), S at (13,3)
    const elN = createTestElementFromDecls("NFET", "n1", nfetPinDecls, undefined, { x: 10, y: 0 });

    // DriverA at (11,0), output at relative (2,0) => world (13,0) — same as D
    const elA = createTestElementFromDecls("DriverA", "a1", driverPins, undefined, { x: 11, y: 0 });
    // DriverB at (11,-3), output at relative (2,0) => world (13,-3)
    const elB = createTestElementFromDecls("DriverB", "b1", driverPins, undefined, { x: 11, y: -3 });

    // DriverC at (11,3), output at relative (2,0) => world (13,3) — same as S
    const elC = createTestElementFromDecls("DriverC", "c1", driverPins, undefined, { x: 11, y: 3 });
    // DriverD at (11,6), output at relative (2,0) => world (13,6)
    const elD = createTestElementFromDecls("DriverD", "d1", driverPins, undefined, { x: 11, y: 6 });

    // Gate driver: output at (10,1.5)
    const gatePins = outputOnlyPin({ x: 2, y: 0 });
    const gateDriverDef = makeDefinition("GateDriver", gatePins, (idx, st, hz, lay) => {
      const wt = lay.wiringTable;
      st[wt[lay.outputOffset(idx)]!] = 1;
      hz[wt[lay.outputOffset(idx)]!] = 0;
    });
    const registry2 = new ComponentRegistry();
    registry2.register(driverADef);
    registry2.register(driverBDef);
    registry2.register(driverCDef);
    registry2.register(driverDDef);
    registry2.register(nfetDef);
    registry2.register(gateDriverDef as ComponentDefinition);

    const elGate = createTestElementFromDecls("GateDriver", "g1", gatePins, undefined, { x: 8, y: 1.5 });

    circuit.addElement(elN);
    circuit.addElement(elA);
    circuit.addElement(elB);
    circuit.addElement(elC);
    circuit.addElement(elD);
    circuit.addElement(elGate);

    // Wire DriverB output (13,-3) to DriverA/D junction (13,0)
    circuit.addWire(new Wire({ x: 13, y: -3 }, { x: 13, y: 0 }));
    // Wire DriverD output (13,6) to DriverC/S junction (13,3)
    circuit.addWire(new Wire({ x: 13, y: 6 }, { x: 13, y: 3 }));

    const compiled = compileUnified(circuit, registry2).digital!;

    // D net has 2 drivers (DriverA + DriverB), S net has 2 drivers (DriverC + DriverD)
    // NFET should be classified as bidirectional (2)
    let nfetIdx = -1;
    for (const [idx, el] of compiled.componentToElement) {
      if (el.typeId === "NFET") nfetIdx = idx;
    }
    expect(nfetIdx).toBeGreaterThanOrEqual(0);
    expect(compiled.switchClassification[nfetIdx]).toBe(2);
    expect(compiled.switchComponentIndices.length).toBeGreaterThanOrEqual(1);
    expect(Array.from(compiled.switchComponentIndices)).toContain(nfetIdx);
    expect(compiled.busResolver).not.toBeNull();
  });

  it("switch_feedback_converges", () => {
    // Simple NFET circuit with no multi-driver nets. Unidirectional.
    // GateDriver drives gate=1. NFET D and S are each on their own nets
    // (only the NFET itself drives them since its pins are bidirectional=output).
    // After compile + step, execution should converge without oscillation.

    const nfetPinDecls = nfetPins();
    const driverPins = outputOnlyPin({ x: 2, y: 0 });

    const nfetExec: ExecuteFunction = (idx, st, hz, lay) => {
      const wt = lay.wiringTable;
      const inBase = lay.inputOffset(idx);
      const outBase = lay.outputOffset(idx);
      const stBase = lay.stateOffset(idx);
      const gate = st[wt[inBase]!]! & 1;
      st[stBase] = gate;
      const classification = lay.getSwitchClassification?.(idx) ?? 1;
      if (classification !== 2) {
        const drainNet = wt[outBase]!;
        const sourceNet = wt[outBase + 1]!;
        if (gate) {
          st[sourceNet] = st[drainNet]!;
          hz[sourceNet] = 0;
        } else {
          hz[sourceNet] = 0xffffffff;
        }
      }
    };

    const gateDriverExec: ExecuteFunction = (idx, st, hz, lay) => {
      const wt = lay.wiringTable;
      const outNet = wt[lay.outputOffset(idx)]!;
      st[outNet] = 1;
      hz[outNet] = 0;
    };

    const gateDef = makeDefinition("GateDriver", driverPins, gateDriverExec);
    const nfetDef = makeDefinition("NFET", nfetPinDecls, nfetExec, {
      stateSlotCount: 1,
      switchPins: [1, 2],
    });
    const registry = makeRegistry(gateDef, nfetDef);

    const circuit = new Circuit();

    // NFET at (10, 0): G at (10,1.5), D at (13,0), S at (13,3)
    const elN = createTestElementFromDecls("NFET", "n1", nfetPinDecls, undefined, { x: 10, y: 0 });
    // GateDriver output at (10,1.5) — same as G pin
    const elG = createTestElementFromDecls("GateDriver", "g1", driverPins, undefined, { x: 8, y: 1.5 });

    circuit.addElement(elN);
    circuit.addElement(elG);

    const compiled = compileUnified(circuit, registry).digital!;
    const engine = new DigitalEngine("level");
    engine.init(compiled);

    // Should not throw (converges without oscillation)
    engine.step();

    // NFET should be closed (gate=1)
    let nfetIdx = -1;
    for (const [idx, el] of compiled.componentToElement) {
      if (el.typeId === "NFET") nfetIdx = idx;
    }
    const stBase = compiled.layout.stateOffset(nfetIdx);
    expect(engine.getSignalArray()[stBase]).toBe(1);
  });

  it("bidirectional_switch_triggers_bus_reconfiguration", () => {
    // Two drivers on net A (nets 0,1 -> output net 10) and two on net B
    // (nets 2,3 -> output net 11), connected by a bidirectional switch (id=0).
    // Close switch. Assert merged net value reflects all four drivers.

    const state = new Uint32Array(12);
    const highZs = new Uint32Array(12);

    // Net A bus: output net 10, drivers at nets 0 and 1
    // Net B bus: output net 11, drivers at nets 2 and 3
    const resolver = new BusResolver();
    resolver.addBusNet(10, [0, 1], "none");
    resolver.addBusNet(11, [2, 3], "none");

    // Register a switch connecting net A (10) and net B (11)
    resolver.registerSwitch(0, 10, 11);

    // Set driver values: driver 0 drives 1, driver 1 is highZ
    // driver 2 drives 1, driver 3 is highZ
    state[0] = 1;
    highZs[0] = 0;
    state[1] = 0;
    highZs[1] = 0xffffffff; // highZ

    state[2] = 1;
    highZs[2] = 0;
    state[3] = 0;
    highZs[3] = 0xffffffff; // highZ

    // Before switch closes: each bus resolves independently
    resolver.onNetChanged(0, state, highZs);
    resolver.onNetChanged(2, state, highZs);

    expect(state[10]).toBe(1); // net A: driver 0 drives 1
    expect(state[11]).toBe(1); // net B: driver 2 drives 1

    // Close the switch: nets merge
    resolver.reconfigureForSwitch(0, true);

    // After reconfiguring, trigger recalculation via onNetChanged
    // Net 11 is now a driver of bus 10 and net 10 is now a driver of bus 11
    resolver.onNetChanged(0, state, highZs);
    resolver.onNetChanged(2, state, highZs);

    // Both bus outputs should reflect the merged value of all four drivers
    // Drivers 0 and 2 are non-highZ driving 1; drivers 1 and 3 are highZ
    // Merged value: OR of non-highZ drivers = 1
    expect(state[10]).toBe(1);
    expect(state[11]).toBe(1);

    // Verify burn check passes (no conflict: all non-highZ drivers agree on 1)
    const burns = resolver.checkAllBurns();
    expect(burns.length).toBe(0);

    // Open the switch: nets split back
    resolver.reconfigureForSwitch(0, false);

    // Change driver 0 to drive 0 (only affects net A now, not net B)
    state[0] = 0;
    resolver.onNetChanged(0, state, highZs);

    // Net A should now be 0 (only driver 0 is non-highZ, driving 0)
    expect(state[10]).toBe(0);
    // Net B should still be 1 (driver 2 is non-highZ, driving 1) — not affected
    resolver.onNetChanged(2, state, highZs);
    expect(state[11]).toBe(1);
  });
});
