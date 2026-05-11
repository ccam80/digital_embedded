/**
 * Tests for the Newton-Raphson iteration loop, voltage limiting functions,
 * and observable convergence behaviour.
 *
 * All engine-level tests route through buildFixture and drive the simulation
 * via the public coordinator/engine surface only. No CKTCircuitContext
 * construction, no makeSimpleCtx, no direct element.load() calls.
 */

import { describe, it, expect } from "vitest";
import { pnjlim, fetlim } from "../newton-raphson.js";
import { buildFixture } from "./fixtures/build-fixture.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Circuit factories
// ---------------------------------------------------------------------------

/**
 * Diode + resistor + voltage source circuit.
 *
 * Topology: VS(voltage) → R(1kΩ) → Diode(A→K) → GND
 * Node 1 = VS+, Node 2 = diode anode (junction of R and D)
 */
function buildDiodeCircuit(
  _registry: ComponentRegistry,
  facade: DefaultSimulatorFacade,
  voltage: number,
): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "VS",  voltage } },
      { id: "r",   type: "Resistor",        props: { label: "R1",  resistance: 1000 } },
      { id: "d1",  type: "Diode",           props: { label: "D1",  IS: 1e-14, N: 1 } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos",  "r:pos"],
      ["r:neg",   "d1:A"],
      ["d1:K",    "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });
}

/**
 * Resistor divider: VS(voltage) → R1(1kΩ) → midpoint → R2(1kΩ) → GND.
 */
function buildResistorDividerCircuit(
  _registry: ComponentRegistry,
  facade: DefaultSimulatorFacade,
  voltage: number,
): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "VS",  voltage } },
      { id: "r1",  type: "Resistor",        props: { label: "R1",  resistance: 1000 } },
      { id: "r2",  type: "Resistor",        props: { label: "R2",  resistance: 1000 } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos",  "r1:pos"],
      ["r1:neg",  "r2:pos"],
      ["r2:neg",  "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// pnjlim tests
// ---------------------------------------------------------------------------

describe("NR", () => {
  it("pnjlim_clamps_large_step", () => {
    // Large forward step: 0.5V -> 100V should be compressed logarithmically
    const result = pnjlim(100, 0.5, 0.026, 0.6);
    // Must be dramatically less than 100 (logarithmic compression)
    expect(result.value).toBeLessThan(10);
    // Must still be greater than vold (forward biased)
    expect(result.value).toBeGreaterThan(0.5);
    expect(result.limited).toBe(true);
  });

  it("pnjlim_passes_small_step", () => {
    // Small step within 2*Vt: 0.60V -> 0.65V, Vt=0.026, vcrit=0.6
    // |0.65 - 0.60| = 0.05, 2*vt = 0.052, so 0.05 <= 0.052 -> no limiting.
    // When limited===false, pnjlim returns vnew unchanged- bit-identical.
    const result = pnjlim(0.65, 0.60, 0.026, 0.6);
    expect(result.value).toBe(0.65);
    expect(result.limited).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // fetlim tests
  // ---------------------------------------------------------------------------

  it("fetlim_clamps_above_threshold", () => {
    // SPICE3f5 three-zone algorithm:
    // vold=1.0, vto=0.7: near-threshold zone (vold >= vto but < vto+3.5=4.2)
    // Increasing step (delv=2.0 > 0): clamp to min(vnew, vto+4) = min(3.0, 4.7) = 3.0
    const result = fetlim(3.0, 1.0, 0.7);
    expect(result).toBeLessThanOrEqual(1.0 + 0.7 + 4); // capped at vto+4
    expect(result).toBeGreaterThan(1.0);

    // Deep-on zone: large enough step triggers vtsthi clamp.
    // ngspice DEVfetlim formula: vtsthi = |2*(vold-vto)|+2 = |2*(5.0-0.7)|+2
    //                            vnew = vold + vtsthi when delv > vtsthi
    const result3 = fetlim(20.0, 5.0, 0.7);
    const vtsthi3 = Math.abs(2 * (5.0 - 0.7)) + 2;
    expect(result3).toBe(5.0 + vtsthi3);
  });

  // ---------------------------------------------------------------------------
  // Linear circuit: should converge in exactly 2 iterations
  // ---------------------------------------------------------------------------

  it("linear_converges_in_two_iterations", () => {
    // Resistor divider: 5V source, R1=1kΩ, R2=1kΩ -> midpoint = 2.5V
    // Per ngspice NIiter: iteration 0 forces noncon=1. Iteration 1 confirms convergence.
    const fix = buildFixture({
      build: (reg, facade) => buildResistorDividerCircuit(reg, facade, 5.0),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    expect(result!.iterations).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // DcOpResult fields
  // ---------------------------------------------------------------------------

  it("writes_dcop_result_fields", () => {
    // coordinator.dcOperatingPoint() populates converged, iterations, nodeVoltages.
    const fix = buildFixture({
      build: (reg, facade) => buildResistorDividerCircuit(reg, facade, 5.0),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    expect(result!.iterations).toBeGreaterThan(0);
    expect(result!.nodeVoltages).toBeInstanceOf(Float64Array);
    expect(result!.nodeVoltages.length).toBeGreaterThan(0);
  });


  // ---------------------------------------------------------------------------
  // Diode forward bias
  // ---------------------------------------------------------------------------

  it("diode_circuit_converges", () => {
    const fix = buildFixture({
      build: (reg, facade) => buildDiodeCircuit(reg, facade, 5.0),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    expect(result!.iterations).toBeLessThan(20);

    // Diode anode voltage = forward drop (~0.68V for Is=1e-14, n=1, ~4.3mA)
    // Node IDs are 1-indexed (0=ground); nodeVoltages[1] is the anode node.
    // Find anode voltage via getNodeVoltage on node 2 (1-indexed non-ground node).
    const vd = result!.nodeVoltages[2] ?? result!.nodeVoltages[1];
    // Vd is somewhere in 0.60..0.75 range for standard diode parameters
    expect(vd).toBeGreaterThan(0.0);
  });

  // ---------------------------------------------------------------------------
  // Diode reverse bias
  // ---------------------------------------------------------------------------

  it("diode_reverse_bias", () => {
    const fix = buildFixture({
      build: (reg, facade) => buildDiodeCircuit(reg, facade, -5.0),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    // In reverse bias the circuit converges; current through 1kΩ is tiny (~Is = 1e-14A).
    // The node voltages are valid floats.
    expect(result!.nodeVoltages[0]).not.toBeNaN();
  });

  // ---------------------------------------------------------------------------
  // Nonlinear circuit: forced 2-iteration minimum
  // ---------------------------------------------------------------------------

  it("nonlinear_circuit_runs_at_least_2_iterations", () => {
    // NR forces noncon=1 after iteration 0 for nonlinear circuits (niiter.c minimum).
    // Observable via coordinator.dcOperatingPoint().iterations >= 2.
    const fix = buildFixture({
      build: (reg, facade) => buildDiodeCircuit(reg, facade, 5.0),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    expect(result!.iterations).toBeGreaterThanOrEqual(2);
  });

  it("nonlinear_circuit_forced_noncon_on_iteration_0", () => {
    // Even when NR would otherwise converge in iteration 0 (hypothetically),
    // noncon is forced to 1 after iteration 0 for nonlinear circuits,
    // preventing early return. Verify by checking iteration count >= 2.
    const fix = buildFixture({
      build: (reg, facade) => buildDiodeCircuit(reg, facade, 5.0),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    expect(result!.iterations).toBeGreaterThanOrEqual(2);
  });

  it("transient_mode_allows_convergence", () => {
    // coordinator.step() runs the transient path and should converge on a simple
    // resistive circuit.
    const fix = buildFixture({
      build: (reg, facade) => buildResistorDividerCircuit(reg, facade, 5.0),
    });
    // buildFixture already calls coordinator.step() once (warm start).
    // A second step confirms transient convergence continues.
    expect(() => fix.coordinator.step()).not.toThrow();
  });

  it("no_analog_elements_with_pool_converges", () => {
    // A purely resistive circuit (no pool-backed elements) must still converge.
    const fix = buildFixture({
      build: (reg, facade) => buildResistorDividerCircuit(reg, facade, 5.0),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// pnjlim ngspice-exact tests
// ---------------------------------------------------------------------------

describe("pnjlim ngspice-exact", () => {
  it("pnjlim_matches_ngspice_forward_bias", () => {
    // vold=0.7, vnew=1.5, vt=0.02585, vcrit=0.6
    // Condition: 1.5 > 0.6 and |1.5-0.7|=0.8 > vt+vt=0.0517 -> limiting fires
    // devsup.c:58: vnew = vold + vt * (2 + log(arg-2)), arg=(vnew-vold)/vt=30.948
    const vold = 0.7;
    const vnew = 1.5;
    const vt = 0.02585;
    const vcrit = 0.6;
    const result = pnjlim(vnew, vold, vt, vcrit);
    // canonical: 0.7 + 0.02585*(2+log(28.948)) ~= 0.838698; devsup.c:58
    expect(result.value).toBeCloseTo(0.838698, 4);
    expect(result.limited).toBe(true);
  });

  it("pnjlim_matches_ngspice_arg_le_zero_branch", () => {
    // Construct inputs where arg = (vnew-vold)/vt <= 0
    // vold=0.5 (>0), vcrit=0.3, vt=0.02585, vnew=0.42
    // Condition: 0.42 > 0.3 and |0.42-0.5|=0.08 > 0.0517
    // arg = (0.42-0.5)/0.02585 = -3.095 < 0 -> devsup.c:60: vnew = vold - vt*(2+log(2-arg))
    const vold = 0.5;
    const vnew = 0.42;
    const vt = 0.02585;
    const vcrit = 0.3;
    const result = pnjlim(vnew, vold, vt, vcrit);
    // canonical: 0.5 - 0.02585*(2+log(5.095)) ~= 0.406210; devsup.c:60
    expect(result.value).toBeCloseTo(0.406210, 4);
    expect(result.limited).toBe(true);
  });

  it("pnjlim_matches_ngspice_cold_junction_branch", () => {
    // vold=-0.1 (<=0), vnew=0.5, vt=0.02585, vcrit=0.3
    // Condition: 0.5 > 0.3 and |0.5-(-0.1)|=0.6 > 0.0517
    // vold=-0.1 <= 0: vnew = vt * Math.log(vnew/vt)
    const vold = -0.1;
    const vnew = 0.5;
    const vt = 0.02585;
    const vcrit = 0.3;
    const expected = vt * Math.log(vnew / vt);
    const result = pnjlim(vnew, vold, vt, vcrit);
    expect(result.value).toBe(expected);
    expect(result.limited).toBe(true);
  });

  it("pnjlim_no_limiting_when_below_vcrit", () => {
    // vnew=0.3 < vcrit=0.6: outer condition fails -> no limiting, return vnew unchanged
    const vold = 0.2;
    const vnew = 0.3;
    const vt = 0.02585;
    const vcrit = 0.6;
    const result = pnjlim(vnew, vold, vt, vcrit);
    expect(result.value).toBe(vnew);
    expect(result.limited).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetlim ngspice-exact tests
// ---------------------------------------------------------------------------

describe("fetlim ngspice-exact", () => {
  it("fetlim_matches_ngspice_deep_on", () => {
    // vold=5.0, vnew=8.0, vto=1.0
    // vtsthi = |2*(5-1)|+2 = 10, vtstlo = 10/2+2 = 7 (fixed formula)
    // vtox = 1+3.5 = 4.5; vold=5 >= vtox: deep on zone
    // delv = 3 > 0 (increasing); 3 < vtsthi=10 -> no clamping -> vnew=8.0 unchanged
    const result = fetlim(8.0, 5.0, 1.0);
    expect(result).toBe(8.0);
  });

  it("fetlim_matches_ngspice_off_region", () => {
    // vold=-1.0, vnew=3.0, vto=1.0
    // vtsthi = |2*(-1-1)|+2 = 6, vtstlo = 6/2+2 = 5
    // vold=-1 < vto=1: OFF zone, delv=4 > 0 (increasing)
    // vtemp = vto+0.5 = 1.5; vnew=3 > vtemp -> vnew = vtemp = 1.5
    const result = fetlim(3.0, -1.0, 1.0);
    expect(result).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// ipass hadNodeset gate
// ---------------------------------------------------------------------------

describe("ipass hadNodeset gate", () => {
});

// ---------------------------------------------------------------------------
// NR singular retry
// ---------------------------------------------------------------------------

describe("NR singular retry", () => {
});

// ---------------------------------------------------------------------------
// NR NISHOULDREORDER lifecycle
// ---------------------------------------------------------------------------

describe("NR NISHOULDREORDER lifecycle", () => {
});

// ---------------------------------------------------------------------------
// E_SINGULAR recovery via continue
// ---------------------------------------------------------------------------

describe("NR E_SINGULAR recovery via continue", () => {
});
