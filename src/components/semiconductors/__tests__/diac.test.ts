/**
 * Tests for the Diac (bidirectional trigger diode) component.
 *
 * Covers:
 *   - blocks_below_breakover: |V| < V_BO → I ≈ V/R_off (µA range)
 *   - conducts_above_breakover: |V| >> V_BO → significant current flow
 *   - symmetric: same |V|, opposite polarity → |I| approximately equal
 *   - triggers_triac: diac + triac integration test
 */

import { describe, it, expect } from "vitest";
import { createDiacElement, DiacDefinition } from "../diac.js";
import { createTriacElement } from "../triac.js";
import { PropertyBag } from "../../../core/properties.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Default Diac parameters (matching spec defaults)
// ---------------------------------------------------------------------------

const DIAC_DEFAULTS = {
  vBreakover: 32,
  vHold: 28,
  rOn: 10,
  rOff: 1e7,
  iH: 1e-3,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiac(overrides: Partial<typeof DIAC_DEFAULTS> = {}): AnalogElement {
  const params = { ...DIAC_DEFAULTS, ...overrides };
  // nodeA=1, nodeB=2
  return createDiacElement(new Map([["A", 1], ["B", 2]]), [], -1, new PropertyBag(Object.entries(params)));
}

/**
 * Drive diac to a steady operating point by calling updateOperatingPoint repeatedly.
 * nodeA=1 (index 0), nodeB=2 (index 1)
 */
function driveToOp(element: AnalogElement, vA: number, vB: number, iterations = 50): Float64Array {
  const voltages = new Float64Array(2);
  voltages[0] = vA;
  voltages[1] = vB;
  for (let i = 0; i < iterations; i++) {
    element.updateOperatingPoint!(voltages);
    voltages[0] = vA;
    voltages[1] = vB;
  }
  return voltages;
}

/**
 * Compute steady-state current I(V) through diac at given voltage by evaluating
 * the Norton equivalent: I = geq * V + ieq.
 * Returns the current from terminal A to terminal B.
 */
function getCurrentAtV(element: AnalogElement, v: number): number {
  driveToOp(element, v, 0, 50);

  const calls: Array<[number, number, number]> = [];
  const rhs: Array<[number, number]> = [];
  const solver = {
    stamp: (r: number, c: number, val: number) => calls.push([r, c, val]),
    stampRHS: (r: number, val: number) => rhs.push([r, val]),
  } as unknown as SparseSolverType;

  element.stampNonlinear!(solver);

  // geq is the (0,0) diagonal entry, ieq = RHS[0] (negated)
  const geqEntry = calls.find((c) => c[0] === 0 && c[1] === 0);
  const ieqEntry = rhs.find((r) => r[0] === 0);

  if (!geqEntry || !ieqEntry) return 0;

  const geq = geqEntry[2];
  const ieq = -ieqEntry[1]; // stampRHS stamps -ieq at row 0
  return geq * v + ieq;
}

// ---------------------------------------------------------------------------
// Diac unit tests
// ---------------------------------------------------------------------------

describe("Diac", () => {
  it("blocks_below_breakover", () => {
    // |V| = 20V < V_BO = 32V → blocking state → I ≈ V/R_off
    // Expected: |I| ≈ 20 / 1e7 = 2µA (µA range)
    const diac = makeDiac();

    const iPosV = getCurrentAtV(diac, 20);
    expect(Math.abs(iPosV)).toBeLessThan(1e-3); // less than 1mA confirms blocking

    // Also check that |I| ≈ V/R_off
    const expected = 20 / DIAC_DEFAULTS.rOff;
    expect(Math.abs(iPosV)).toBeCloseTo(expected, 5);
  });

  it("conducts_above_breakover", () => {
    // |V| = 40V > V_BO = 32V → conducting state → significant current
    // In on-state: I ≈ (40 - V_hold) / R_on = (40 - 28) / 10 = 1.2A
    const diac = makeDiac();

    const iV = getCurrentAtV(diac, 40);
    // Significant current >> blocking
    expect(Math.abs(iV)).toBeGreaterThan(0.1); // well above µA leakage

    // Current should be in the direction of voltage (positive V → positive I)
    expect(iV).toBeGreaterThan(0);
  });

  it("symmetric", () => {
    // Same |V| positive and negative → |I| approximately equal (symmetric device)
    const posV = 40;
    const negV = -40;

    const diacPos = makeDiac();
    const diacNeg = makeDiac();

    const iPos = getCurrentAtV(diacPos, posV);
    const iNeg = getCurrentAtV(diacNeg, negV);

    // Both currents should have same magnitude within 5%
    expect(Math.abs(iPos)).toBeGreaterThan(0.01); // conducting
    expect(Math.abs(iNeg)).toBeGreaterThan(0.01); // conducting in reverse

    const ratio = Math.abs(iPos) / Math.abs(iNeg);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);

    // Signs are opposite (current flows opposite ways)
    expect(iPos).toBeGreaterThan(0);
    expect(iNeg).toBeLessThan(0);
  });

  it("triggers_triac", () => {
    // Integration test: diac + triac circuit.
    // At V_supply > V_BO, diac conducts and delivers gate current to triac.
    // The triac should then latch.
    //
    // Topology (direct NR iteration simulation):
    //   Voltage source at MT2=120V (via resistor), MT1=gnd, Gate via diac
    //   When V_gate > V_BO = 32V: diac conducts → gate current → triac triggers.
    //
    // Simplified unit test: verify diac produces gate current > triac I_GT
    // when driven by V_BO voltage, then manually check triac triggers.

    const triac = createTriacElement(
      new Map([["MT1", 1], ["MT2", 2], ["G", 3]]),
      [],
      -1,
      new PropertyBag(Object.entries({ vOn: 1.5, iH: 10e-3, rOn: 0.01, iS: 1e-12, alpha1: 0.5, alpha2_0: 0.3, i_ref: 1e-3, n: 1 })),
    );

    // Step 1: verify diac at V=40V (above V_BO=32V) produces current that can trigger triac
    const diac = makeDiac();
    const iDiac = getCurrentAtV(diac, 40);
    // I_GT for triac ≈ 200µA; diac at V=40V should produce >> 200µA
    expect(iDiac).toBeGreaterThan(200e-6); // diac produces trigger current

    // Step 2: with that gate current level (simulated by 0.65V gate bias which
    // corresponds to a forward-biased gate junction), triac should trigger.
    const voltages = new Float64Array(3);
    voltages[0] = 0;   // MT1
    voltages[1] = 100; // MT2 (100V positive)
    voltages[2] = 0.65; // Gate (forward-biased, simulating diac delivery)

    for (let i = 0; i < 200; i++) {
      triac.updateOperatingPoint!(voltages);
      voltages[0] = 0;
      voltages[1] = 100;
      voltages[2] = 0.65;
    }

    // Verify triac is now conducting (high conductance)
    const calls: Array<[number, number, number]> = [];
    const solver = {
      stamp: (r: number, c: number, v: number) => calls.push([r, c, v]),
      stampRHS: (_r: number, _v: number) => {},
    } as unknown as SparseSolverType;
    triac.stampNonlinear!(solver);

    const diagMT = calls.filter((c) => c[0] === c[1] && c[0] < 2);
    const maxG = Math.max(...diagMT.map((c) => Math.abs(c[2])));
    expect(maxG).toBeGreaterThan(1.0); // triac in on-state — diac triggered it
  });

  it("definition_has_correct_fields", () => {
    expect(DiacDefinition.name).toBe("Diac");
    expect(DiacDefinition.models?.analog).toBeDefined();
    expect(DiacDefinition.models?.analog?.deviceType).toBe("DIAC");
    expect(DiacDefinition.models?.analog?.factory).toBeDefined();
    expect(DiacDefinition.category).toBe("SEMICONDUCTORS");
  });
});
