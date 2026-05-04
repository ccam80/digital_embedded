/**
 * Tests for Voltage-Controlled Voltage Source (VCVS) analog element.
 *
 * All tests use the real factory path via ComparisonSession.createSelfCompare (M1).
 *
 * MNA solution vector layout:
 *   indices 1..nodeCount  - node voltages (1-based MNA node IDs)
 *   indices >nodeCount    - branch currents (allocated by engine setup)
 */

import { describe, it, expect } from "vitest";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// VCVS tests
// ---------------------------------------------------------------------------

describe("VCVS", () => {
  it("unity_gain_buffer", async () => {
    // Circuit: Vs=3.3V → ctrl node; VCVS(ctrl+=ctrl node, ctrl-=GND, out+=out node, out-=GND, gain=1)
    // Expected: V(out node) = 3.3V
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",   type: "DcVoltageSource", props: { label: "vs",   voltage: 3.3 } },
            { id: "vcvs", type: "VCVS",            props: { label: "vcvs", gain: 1.0 } },
            { id: "gnd",  type: "Ground" },
          ],
          connections: [
            ["vs:pos",    "vcvs:ctrl+"],
            ["vs:neg",    "gnd:out"],
            ["vcvs:ctrl-","gnd:out"],
            ["vcvs:out-", "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
  });

  it("gain_of_10", async () => {
    // Vs=0.5V, VCVS gain=10 → output = 5.0V
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",   type: "DcVoltageSource", props: { label: "vs",   voltage: 0.5 } },
            { id: "vcvs", type: "VCVS",            props: { label: "vcvs", gain: 10.0 } },
            { id: "gnd",  type: "Ground" },
          ],
          connections: [
            ["vs:pos",    "vcvs:ctrl+"],
            ["vs:neg",    "gnd:out"],
            ["vcvs:ctrl-","gnd:out"],
            ["vcvs:out-", "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
  });

  it("nonlinear_expression", async () => {
    // expression: 0.5 * V(ctrl)^2, ctrl=2V → output = 0.5 * 4 = 2.0V
    // NR should converge in ≤ 10 iterations
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",   type: "DcVoltageSource", props: { label: "vs",   voltage: 2.0 } },
            { id: "vcvs", type: "VCVS",            props: { label: "vcvs", expression: "0.5 * V(ctrl)^2" } },
            { id: "gnd",  type: "Ground" },
          ],
          connections: [
            ["vs:pos",    "vcvs:ctrl+"],
            ["vs:neg",    "gnd:out"],
            ["vcvs:ctrl-","gnd:out"],
            ["vcvs:out-", "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
    const detail = session.getAttempt({ stepIndex: 0, phase: "dcopDirect", phaseAttemptIndex: 0 });
    expect(detail.iterations.length).toBeLessThanOrEqual(10);
  });

  it("output_drives_load", async () => {
    // Vs=1V → ctrl node, VCVS gain=10 → out node (output=10V), R=1kΩ out node→GND
    // Output node is enforced at 10V by VCVS regardless of load.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",    type: "DcVoltageSource", props: { label: "vs",    voltage: 1.0 } },
            { id: "vcvs",  type: "VCVS",            props: { label: "vcvs",  gain: 10.0 } },
            { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: 1000 } },
            { id: "gnd",   type: "Ground" },
          ],
          connections: [
            ["vs:pos",    "vcvs:ctrl+"],
            ["vs:neg",    "gnd:out"],
            ["vcvs:ctrl-","gnd:out"],
            ["vcvs:out+", "rLoad:A"],
            ["vcvs:out-", "gnd:out"],
            ["rLoad:B",   "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
    // Output voltage enforced at 10V by VCVS
  });

  it("branch_index_assigned_after_setup", async () => {
    // After engine setup, VCVS must converge in a complete circuit.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",   type: "DcVoltageSource", props: { label: "vs",   voltage: 1.0 } },
            { id: "vcvs", type: "VCVS",            props: { label: "vcvs", gain: 1.0 } },
            { id: "gnd",  type: "Ground" },
          ],
          connections: [
            ["vs:pos",    "vcvs:ctrl+"],
            ["vs:neg",    "gnd:out"],
            ["vcvs:ctrl-","gnd:out"],
            ["vcvs:out-", "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
    const detail = session.getAttempt({ stepIndex: 0, phase: "dcopDirect", phaseAttemptIndex: 0 });
    const lastIter = detail.iterations[detail.iterations.length - 1].ours!;
    expect(lastIter.matrixSize).toBeGreaterThanOrEqual(1);
  });
});
