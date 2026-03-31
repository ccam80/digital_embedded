/**
 * Tests for the Triac (bidirectional thyristor) component.
 *
 * Covers:
 *   - conducts_positive_when_triggered: positive V, gate pulse → conduction
 *   - conducts_negative_when_triggered: negative V, gate pulse → reverse conduction
 *   - turns_off_at_zero_crossing: triac turns off when current drops below I_hold
 *   - phase_control: trigger at 90° of sine → chopped output starting at 90°
 */

import { describe, it, expect } from "vitest";
import { createTriacElement, TriacDefinition, TRIAC_PARAM_DEFAULTS } from "../triac.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
import { withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Default Triac parameters
// ---------------------------------------------------------------------------

const TRIAC_DEFAULTS = {
  vOn: 1.5,
  iH: 10e-3, // 10mA holding current
  rOn: 0.01,
  iS: 1e-12,
  alpha1: 0.5,
  alpha2_0: 0.3,
  i_ref: 1e-3,
  n: 1,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTriac(overrides: Partial<typeof TRIAC_DEFAULTS> = {}): AnalogElement {
  const params = { ...TRIAC_PARAM_DEFAULTS, ...TRIAC_DEFAULTS, ...overrides };
  const props = createTestPropertyBag();
  props.replaceModelParams(params);
  // nodeMT1=1, nodeMT2=2, nodeG=3
  return withNodeIds(createTriacElement(new Map([["MT1", 1], ["MT2", 2], ["G", 3]]), [], -1, props), [1, 2, 3]);
}

/**
 * Drive triac to a steady operating point by calling updateOperatingPoint
 * repeatedly with fixed node voltages.
 * nodeMT1=1 (index 0), nodeMT2=2 (index 1), nodeG=3 (index 2)
 */
function driveToOp(
  element: AnalogElement,
  vMT1: number,
  vMT2: number,
  vGate: number,
  iterations = 150,
): Float64Array {
  const voltages = new Float64Array(3);
  voltages[0] = vMT1;
  voltages[1] = vMT2;
  voltages[2] = vGate;
  for (let i = 0; i < iterations; i++) {
    element.updateOperatingPoint!(voltages);
    voltages[0] = vMT1;
    voltages[1] = vMT2;
    voltages[2] = vGate;
  }
  return voltages;
}

/**
 * Returns the peak diagonal conductance for the MT1-MT2 path
 * (solver indices 0 and 1 for nodes 1 and 2).
 */
function getMainPathConductance(element: AnalogElement): number {
  const calls: Array<[number, number, number]> = [];
  const solver = {
    stamp: (r: number, c: number, v: number) => calls.push([r, c, v]),
    stampRHS: (_r: number, _v: number) => {},
  } as unknown as SparseSolverType;
  element.stampNonlinear!(solver);
  // MT1 diagonal is at (0,0), MT2 diagonal is at (1,1) for nodes 1,2
  const diag = calls.filter((c) => c[0] === c[1] && c[0] < 2);
  return Math.max(...diag.map((c) => Math.abs(c[2])));
}

const G_ON = 1 / TRIAC_DEFAULTS.rOn; // 100 S

// ---------------------------------------------------------------------------
// Triac unit tests
// ---------------------------------------------------------------------------

describe("Triac", () => {
  it("conducts_positive_when_triggered", () => {
    // Positive V_MT2-MT1 = 50V, gate forward-biased (0.65V above MT1)
    // Expected: forward path latches, high conductance
    const triac = makeTriac();

    // Gate at 0.65V above MT1 (forward-biased junction) → large α₂ → trigger
    driveToOp(triac, 0, 50, 0.65, 200);

    const g = getMainPathConductance(triac);
    expect(g).toBeGreaterThan(1.0);      // confirms on-state (>> GMIN)
    expect(g).toBeCloseTo(G_ON, 0);      // ≈ 100 S
  });

  it("conducts_negative_when_triggered", () => {
    // Negative V_MT2-MT1 = -50V (reverse polarity), gate forward-biased
    // Expected: reverse path latches, high conductance in reverse direction
    const triac = makeTriac();

    // MT2 negative relative to MT1: V_MT2-MT1 = -50V
    // Gate at 0.65V above MT1 → triggers reverse path
    driveToOp(triac, 50, 0, 50.65, 200); // MT1=50, MT2=0, G=50.65 → vg1=0.65V

    const g = getMainPathConductance(triac);
    expect(g).toBeGreaterThan(1.0);      // on-state in reverse direction
    expect(g).toBeCloseTo(G_ON, 0);      // ≈ 100 S
  });

  it("turns_off_at_zero_crossing", () => {
    // AC 60Hz source (peak 100V), 100Ω load, I_hold = 10mA.
    // Trigger triac at a positive phase, then simulate through zero-crossing.
    // At zero crossing, I_MT = V/(R+R_on) ≈ 0, which drops below I_hold.
    //
    // Strategy: trigger at peak positive voltage, then step to near-zero voltage.
    // At V_MT≈0, I_MT = (0 - V_on)/R_on < 0 < I_hold → unlatch.

    const triac = makeTriac({ iH: 10e-3 });

    // Step 1: trigger at positive peak (100V)
    driveToOp(triac, 0, 100, 0.65, 200);

    // Verify it's latched
    const gBefore = getMainPathConductance(triac);
    expect(gBefore).toBeGreaterThan(1.0);

    // Step 2: reduce to near zero voltage (simulate zero-crossing)
    // At V_MT = 0.001V (near zero), current = (0.001 - 1.5) / 0.01 = -149.9A < I_hold
    // This drives I_MT below I_hold → unlatch
    driveToOp(triac, 0, 0.001, 0, 100);

    // Verify it unlatched (blocking state — very low conductance)
    const gAfter = getMainPathConductance(triac);
    expect(gAfter).toBeLessThan(0.1); // << 100 S, confirms blocking state
  });

  it("phase_control", () => {
    // Simulate phase-angle control: trigger at 90° of a 60Hz AC sine.
    // At 90°: V(t) = 100*sin(π/2) = 100V (peak).
    // Before 90° (e.g. at 0°): V(t)=0, no trigger → blocking.
    // After trigger at 90°: conducting for rest of half-cycle.

    const triac = makeTriac();

    // Before 90° — no gate, low voltage: blocking
    driveToOp(triac, 0, 0.5, 0, 100); // tiny voltage, no gate
    const gBefore90 = getMainPathConductance(triac);
    expect(gBefore90).toBeLessThan(0.1); // blocking

    // At 90° — apply gate trigger while at peak voltage
    driveToOp(triac, 0, 100, 0.65, 200);
    const gAt90 = getMainPathConductance(triac);
    expect(gAt90).toBeGreaterThan(1.0); // conducting

    // At 120° (V still positive, ~86.6V): still conducting (latched)
    driveToOp(triac, 0, 86.6, 0, 50); // gate removed, still conducting
    const gAt120 = getMainPathConductance(triac);
    expect(gAt120).toBeGreaterThan(1.0); // stays latched

    // At 180°+ (near zero crossing): unlatch
    driveToOp(triac, 0, 0.001, 0, 100);
    const gAtZero = getMainPathConductance(triac);
    expect(gAtZero).toBeLessThan(0.1); // back to blocking after zero-crossing
  });

  it("definition_has_correct_fields", () => {
    expect(TriacDefinition.name).toBe("Triac");
    expect(TriacDefinition.modelRegistry?.["behavioral"]).toBeDefined();
    expect(TriacDefinition.modelRegistry?.["behavioral"]?.kind).toBe("inline");
    expect((TriacDefinition.modelRegistry?.["behavioral"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
    expect(TriacDefinition.category).toBe("SEMICONDUCTORS");
  });
});
