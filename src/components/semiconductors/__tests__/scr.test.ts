/**
 * Tests for the SCR (Silicon Controlled Rectifier) component.
 *
 * Covers:
 *   - blocks_without_gate: V_AK = 50V, no gate — only leakage
 *   - triggers_with_gate_current: gate current > I_GT latches device
 *   - holds_after_gate_removed: SCR stays conducting after gate removed
 *   - turns_off_below_holding_current: unlatch when I_AK < I_hold
 *   - blocks_reverse: V_AK = -50V — only reverse leakage
 *   - breakover_voltage: V_AK > V_breakover triggers without gate
 */

import { describe, it, expect } from "vitest";
import { createScrElement, ScrDefinition, SCR_PARAM_DEFAULTS } from "../scr.js";
import { PropertyBag } from "../../../core/properties.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { DiagnosticCollector } from "../../../solver/analog/diagnostics.js";
import { solveDcOperatingPoint } from "../../../solver/analog/dc-operating-point.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Default SCR parameters (matching spec defaults)
// ---------------------------------------------------------------------------

const SCR_DEFAULTS = {
  vOn: 1.5,
  iH: 5e-3,
  rOn: 0.01,
  vBreakover: 100,
  iS: 1e-12,
  alpha1: 0.5,
  alpha2_0: 0.3,
  i_ref: 1e-3,
  n: 1,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScrElement(overrides: Partial<typeof SCR_DEFAULTS> = {}): AnalogElement {
  const params = { ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS, ...overrides };
  const props = createTestPropertyBag();
  props.replaceModelParams(params);
  // nodeA=1, nodeK=2, nodeG=3
  return createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, props);
}

function makeResistorElement(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(solver: SparseSolver): void {
      if (nodeA !== 0) solver.stamp(nodeA - 1, nodeA - 1, G);
      if (nodeB !== 0) solver.stamp(nodeB - 1, nodeB - 1, G);
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stamp(nodeA - 1, nodeB - 1, -G);
        solver.stamp(nodeB - 1, nodeA - 1, -G);
      }
    },
  };
}

/**
 * Drive SCR to a steady operating point by iterating updateOperatingPoint.
 * nodeA=1 (index 0), nodeK=2 (index 1), nodeG=3 (index 2)
 */
function driveToOp(
  element: AnalogElement,
  vAnode: number,
  vCathode: number,
  vGate: number,
  iterations = 100,
): Float64Array {
  const voltages = new Float64Array(3);
  voltages[0] = vAnode;
  voltages[1] = vCathode;
  voltages[2] = vGate;
  for (let i = 0; i < iterations; i++) {
    element.updateOperatingPoint!(voltages);
    voltages[0] = vAnode;
    voltages[1] = vCathode;
    voltages[2] = vGate;
  }
  return voltages;
}

// ---------------------------------------------------------------------------
// SCR unit tests
// ---------------------------------------------------------------------------

describe("SCR", () => {
  it("blocks_without_gate", () => {
    // V_AK = 50V, I_G = 0 — SCR should block (only leakage current in µA range)
    // Use a DC circuit: 50V source + 10kΩ load + SCR (A=node1, K=gnd)
    // With no gate drive, SCR in blocking state: I_AK << 1mA

    // Circuit nodes: node1=anode, node2=positive source terminal
    // Branch row for voltage source = row index 2 (0-based = matrix row 2)
    // matrixSize = 3 nodes + 1 branch = 4... but node2 is shared via 10kΩ
    // Layout: VS(node2→gnd) + R(node2→node1) + SCR(A=node1, K=gnd, G=gnd)
    //   node1=anode, node2=source+, gnd=0; SCR gate tied to gnd
    //   branchRow index = 2 (third row, after 2 node rows)

    const matrixSize = 3; // node1, node2, branch
    const scr = withNodeIds(createScrElement(new Map([["A", 1], ["K", 0], ["G", 0]]), [], -1, new PropertyBag(Object.entries(SCR_DEFAULTS))), [1, 0, 0]);
    const vs = withNodeIds(makeDcVoltageSource(2, 0, 2, 50), [2, 0]);
    const rLoad = makeResistorElement(2, 1, 10000); // 10kΩ

    const solver = new SparseSolver();
    const diag = new DiagnosticCollector();

    const result = solveDcOperatingPoint({
      solver,
      elements: [vs, rLoad, scr],
      matrixSize,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics: diag,
    });

    expect(result.converged).toBe(true);

    // V(node2) = 50V enforced by source
    expect(result.nodeVoltages[1]).toBeCloseTo(50, 1);

    // With SCR blocking, most voltage drops across it
    // Current = V(node2 - node1) / R = very small since V(node1) ≈ 50V * (blocking R / (R + blocking R))
    // In blocking state, SCR presents very high impedance — current in µA range
    const iAk = (result.nodeVoltages[1] - result.nodeVoltages[0]) / 10000;
    expect(Math.abs(iAk)).toBeLessThan(1e-3); // less than 1mA (leakage only)
  });

  it("triggers_with_gate_current", () => {
    // V_AK = 50V, inject gate current well above I_GT (200µA).
    // Expected: SCR latches and presents low on-state conductance.
    //
    // Tested by direct NR iteration: drive the element with updateOperatingPoint
    // at V_AK=50V and V_GK=0.65V (well forward-biased gate junction, which
    // drives substantial gate current well above I_GT=200µA).
    //
    // At V_GK=0.65V: I_G = IS*(exp(0.65/nVt) - 1) >> I_ref=1mA
    // → α₂ → ALPHA_MAX = 0.95; α₁+α₂ = 0.5+0.95 = 1.45 > 0.95 → triggers.

    // nodeA=1, nodeK=2, nodeG=3
    const scr = createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, new PropertyBag(Object.entries(SCR_DEFAULTS)));

    // Drive to operating point: 50V anode, 0V cathode, 0.65V gate
    const voltages = new Float64Array(3);
    voltages[0] = 50;   // anode (node1 → index 0)
    voltages[1] = 0;    // cathode (node2 → index 1)
    voltages[2] = 0.65; // gate (node3 → index 2) — forward-biased

    for (let i = 0; i < 200; i++) {
      scr.updateOperatingPoint!(voltages);
      voltages[0] = 50;
      voltages[1] = 0;
      voltages[2] = 0.65;
    }

    // Verify SCR is in on-state by checking high conductance (≈ 1/R_on = 100 S)
    const mockCalls: Array<[number, number, number]> = [];
    const mockSolver = {
      stamp: (r: number, c: number, v: number) => mockCalls.push([r, c, v]),
      stampRHS: (_r: number, _v: number) => {},
    } as unknown as SparseSolver;

    scr.stampNonlinear!(mockSolver);

    // On-state: A-K diagonal conductance ≈ 1/R_on
    // nodeA=1→index 0, nodeK=2→index 1 — A-K diagonal is at (0,0) and (1,1)
    const gOn = 1 / SCR_DEFAULTS.rOn; // 100 S
    const diagAK = mockCalls.filter((c) => c[0] === c[1] && c[0] < 2);
    const maxG = Math.max(...diagAK.map((c) => Math.abs(c[2])));
    expect(maxG).toBeGreaterThan(1.0); // >> GMIN, confirms on-state
    expect(maxG).toBeCloseTo(gOn, 0);  // ≈ 100 S

    // Verify effective current: I_AK = (50 - V_on) / R_on (after convergence)
    // At V_AK=50V (saturated pnjlim), Norton current: I = geq*vak + ieq
    // = (1/rOn + GMIN)*vak + (iOn - geq*vak) = iOn = (vak - vOn)/rOn
    // With _vak converged toward 50V: iOn ≈ (50-1.5)/0.01 = 4850A
    // Just check the element is latched (high conductance confirmed above)
    expect(maxG).toBeGreaterThan(1.0);
  });

  it("holds_after_gate_removed", () => {
    // Trigger SCR first (α₁ + α₂ > 0.95 with gate current)
    // Then drive to steady state at vak=50V, vgate=0 (gate removed)
    // SCR should remain latched because current is above I_hold
    const scr = makeScrElement();

    // First, trigger by driving with gate current to latch it
    driveToOp(scr, 50, 0, 0.7, 200); // gate at 0.7V drives significant gate current

    // Now remove gate (gate = cathode = 0V), keep high anode voltage
    const voltages = new Float64Array(3);
    voltages[0] = 50; // anode
    voltages[1] = 0;  // cathode
    voltages[2] = 0;  // gate = cathode (no gate drive)

    for (let i = 0; i < 50; i++) {
      scr.updateOperatingPoint!(voltages);
      voltages[0] = 50;
      voltages[1] = 0;
      voltages[2] = 0;
    }

    // Check latch state via mock stamp: in on-state, conductance = 1/R_on (high)
    // vs. blocking state, conductance ≈ GMIN (tiny)
    const mockCalls: Array<[number, number, number]> = [];
    const mockSolver = {
      stamp: (r: number, c: number, v: number) => mockCalls.push([r, c, v]),
      stampRHS: (_r: number, _v: number) => {},
    } as unknown as SparseSolver;

    scr.stampNonlinear!(mockSolver);

    // In on-state: conductance should be 1/R_on = 100 S
    const gOn = 1 / SCR_DEFAULTS.rOn;
    const diagCalls = mockCalls.filter((c) => c[0] === c[1]); // diagonal entries
    const maxG = Math.max(...diagCalls.map((c) => Math.abs(c[2])));
    // In on-state, diagonal conductance >> GMIN (blocking) — should be near 1/rOn
    expect(maxG).toBeGreaterThan(1.0); // >> GMIN=1e-12, confirms on-state (1/0.01 = 100)
    expect(maxG).toBeCloseTo(gOn, 0); // approximately 100 S
  });

  it("turns_off_below_holding_current", () => {
    // Trigger SCR, then reduce V_AK until I_AK < I_hold
    // With I_hold = 5mA and R_on = 0.01Ω, V_AK_min ≈ V_on + I_hold * R_on ≈ 1.5V + 0.05mV ≈ 1.5V
    // To get I < 5mA through on-state SCR: I = (V_AK - V_on) / R_on < I_hold
    // → V_AK < V_on + I_hold * R_on = 1.5 + 0.05e-3 = 1.500050V
    // So to turn off, we need V_AK ≈ V_on (near turn-on voltage)

    const scr = makeScrElement({ iH: 5e-3, rOn: 0.01, vOn: 1.5 });

    // Trigger the SCR first
    driveToOp(scr, 50, 0, 0.7, 100);

    // Verify it's latched by checking conductance in on-state
    const mockCalls1: Array<[number, number, number]> = [];
    const solver1 = {
      stamp: (r: number, c: number, v: number) => mockCalls1.push([r, c, v]),
      stampRHS: (_r: number, _v: number) => {},
    } as unknown as SparseSolver;
    scr.stampNonlinear!(solver1);
    const diagBefore = mockCalls1.filter((c) => c[0] === c[1] && c[0] < 2);
    const gBefore = Math.max(...diagBefore.map((c) => Math.abs(c[2])));
    expect(gBefore).toBeGreaterThan(1.0); // on-state

    // Now reduce V_AK to 0.1V — current = (0.1 - 1.5) / 0.01 = -140A (negative → below I_hold)
    // This will cause the SCR to unlatch
    const voltages = new Float64Array(3);
    voltages[0] = 0.1; // very low anode voltage
    voltages[1] = 0;
    voltages[2] = 0;

    for (let i = 0; i < 100; i++) {
      scr.updateOperatingPoint!(voltages);
      voltages[0] = 0.1;
      voltages[1] = 0;
      voltages[2] = 0;
    }

    // After unlatching, conductance should be very small (blocking state)
    const mockCalls2: Array<[number, number, number]> = [];
    const solver2 = {
      stamp: (r: number, c: number, v: number) => mockCalls2.push([r, c, v]),
      stampRHS: (_r: number, _v: number) => {},
    } as unknown as SparseSolver;
    scr.stampNonlinear!(solver2);

    const diagAfter = mockCalls2.filter((c) => c[0] === c[1] && c[0] < 2);
    const gAfter = Math.max(...diagAfter.map((c) => Math.abs(c[2])));
    // In blocking state: conductance should be << 1 S
    expect(gAfter).toBeLessThan(0.1); // very small — blocking state restored
  });

  it("blocks_reverse", () => {
    // V_AK = -50V — reverse blocking, I_AK ≈ -I_S (small reverse leakage)
    const scr = makeScrElement();
    const voltages = driveToOp(scr, -50, 0, 0, 100);

    const mockCalls: Array<[number, number, number]> = [];
    const mockRhs: Array<[number, number]> = [];
    const mockSolver = {
      stamp: (r: number, c: number, v: number) => mockCalls.push([r, c, v]),
      stampRHS: (r: number, v: number) => mockRhs.push([r, v]),
    } as unknown as SparseSolver;

    scr.stampNonlinear!(mockSolver);

    // In reverse blocking, geq ≈ GMIN (≈ 1e-12)
    // The diagonal A-K conductance stamps should be very small
    // nodeA=1→index 0, nodeK=2→index 1
    const aaDiag = mockCalls.find((c) => c[0] === 0 && c[1] === 0);
    expect(aaDiag).toBeDefined();
    // geq << 1e-3 (tiny reverse leakage conductance)
    expect(Math.abs(aaDiag![2])).toBeLessThan(1e-3);

    // Norton current at reverse bias: I ≈ -I_S (tiny)
    // RHS at node A (index 0): -ieq
    const rhsA = mockRhs.find((r) => r[0] === 0);
    expect(rhsA).toBeDefined();
    // |ieq| << 1mA confirms reverse blocking
    expect(Math.abs(rhsA![1])).toBeLessThan(1e-3);
  });

  it("breakover_voltage", () => {
    // V_AK > V_breakover (100V) should trigger SCR even without gate current
    const scr = makeScrElement({ vBreakover: 100 });

    // Drive anode to 110V > V_breakover, gate and cathode at 0V
    const voltages = driveToOp(scr, 110, 0, 0, 100);

    // After breakover, SCR should be in on-state (high conductance)
    const mockCalls: Array<[number, number, number]> = [];
    const mockSolver = {
      stamp: (r: number, c: number, v: number) => mockCalls.push([r, c, v]),
      stampRHS: (_r: number, _v: number) => {},
    } as unknown as SparseSolver;

    scr.stampNonlinear!(mockSolver);

    // On-state: diagonal conductance ≈ 1/R_on = 100 S
    const gOn = 1 / SCR_DEFAULTS.rOn;
    const diagCalls = mockCalls.filter((c) => c[0] === c[1] && c[0] < 2);
    const maxG = Math.max(...diagCalls.map((c) => Math.abs(c[2])));
    expect(maxG).toBeGreaterThan(1.0); // significantly above blocking conductance
    expect(maxG).toBeCloseTo(gOn, 0); // approximately 100 S (on-state)
  });

  it("definition_has_correct_fields", () => {
    expect(ScrDefinition.name).toBe("SCR");
    expect(ScrDefinition.modelRegistry?.["behavioral"]).toBeDefined();
    expect(ScrDefinition.modelRegistry?.["behavioral"]?.kind).toBe("inline");
    expect((ScrDefinition.modelRegistry?.["behavioral"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
    expect(ScrDefinition.category).toBe("SEMICONDUCTORS");
  });
});
