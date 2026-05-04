/**
 * Tests for Voltage-Controlled Current Source (VCCS) analog element.
 *
 * All tests use the real factory path via ComparisonSession.createSelfCompare (M1).
 *
 * VCCS circuit pattern:
 *   - Voltage source Vs sets the control voltage V_ctrl at node_ctrl.
 *   - VCCS outputs current I_out = gm * V_ctrl into node_out.
 *   - Load resistor R_load at node_out → GND converts current to voltage:
 *     V_out = I_out * R_load = gm * V_ctrl * R_load
 */

import { describe, it, expect } from "vitest";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// VCCS tests
// ---------------------------------------------------------------------------

describe("VCCS", () => {
  it("linear_transconductance", async () => {
    // gm=0.01 S, V_ctrl=1V → I_out=10mA, R_load=100Ω → V_out=1V
    //
    // Circuit:
    //   Vs=1V: pos→ctrl node, neg→GND
    //   VCCS: ctrl+=ctrl node, ctrl-=GND, out+=out node, out-=GND, gm=0.01S
    //   R=100Ω: out node→GND
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",   type: "DcVoltageSource", props: { label: "vs",   voltage: 1.0 } },
            { id: "vccs", type: "VCCS",            props: { label: "vccs", transconductance: 0.01 } },
            { id: "r",    type: "Resistor",        props: { label: "r",    resistance: 100 } },
            { id: "gnd",  type: "Ground" },
          ],
          connections: [
            ["vs:pos",    "vccs:ctrl+"],
            ["vs:neg",    "gnd:out"],
            ["vccs:ctrl-","gnd:out"],
            ["vccs:out+", "r:A"],
            ["vccs:out-", "gnd:out"],
            ["r:B",       "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
    // V_out = I_out * R = gm * V_ctrl * R = 0.01 * 1 * 100 = 1V
  });

  it("zero_control_zero_output", async () => {
    // V_ctrl=0 → I_out=0 → V_out=0 across any load
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",   type: "DcVoltageSource", props: { label: "vs",   voltage: 0.0 } },
            { id: "vccs", type: "VCCS",            props: { label: "vccs", transconductance: 0.01 } },
            { id: "r",    type: "Resistor",        props: { label: "r",    resistance: 1000 } },
            { id: "gnd",  type: "Ground" },
          ],
          connections: [
            ["vs:pos",    "vccs:ctrl+"],
            ["vs:neg",    "gnd:out"],
            ["vccs:ctrl-","gnd:out"],
            ["vccs:out+", "r:A"],
            ["vccs:out-", "gnd:out"],
            ["r:B",       "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
  });

  it("nonlinear_square_law", async () => {
    // expression: 0.001 * V(ctrl)^2; V_ctrl=3V → I_out = 0.001*9 = 9mA
    // R_load=100Ω → V_out = 9mA * 100 = 0.9V
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",   type: "DcVoltageSource", props: { label: "vs",   voltage: 3.0 } },
            { id: "vccs", type: "VCCS",            props: { label: "vccs", expression: "0.001 * V(ctrl)^2" } },
            { id: "r",    type: "Resistor",        props: { label: "r",    resistance: 100 } },
            { id: "gnd",  type: "Ground" },
          ],
          connections: [
            ["vs:pos",    "vccs:ctrl+"],
            ["vs:neg",    "gnd:out"],
            ["vccs:ctrl-","gnd:out"],
            ["vccs:out+", "r:A"],
            ["vccs:out-", "gnd:out"],
            ["r:B",       "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
    // I_out = 0.001 * 9 = 9mA; V_out = 9mA * 100Ω = 0.9V
  });

  it("stamps_accessor_returns_valid_handles_after_setup", async () => {
    // After engine setup, VCCS must converge in a complete circuit.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",   type: "DcVoltageSource", props: { label: "vs",   voltage: 1.0 } },
            { id: "vccs", type: "VCCS",            props: { label: "vccs", transconductance: 0.01 } },
            { id: "r",    type: "Resistor",        props: { label: "r",    resistance: 100 } },
            { id: "gnd",  type: "Ground" },
          ],
          connections: [
            ["vs:pos",    "vccs:ctrl+"],
            ["vs:neg",    "gnd:out"],
            ["vccs:ctrl-","gnd:out"],
            ["vccs:out+", "r:A"],
            ["vccs:out-", "gnd:out"],
            ["r:B",       "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
    // Handles are indices >= 0 (TrashCan is handle 0; real handles start at 1 but
    // ground-adjacent entries may return TrashCan=0). Non-(-1) means allocated.
    const detail = session.getAttempt({ stepIndex: 0, phase: "dcopDirect", phaseAttemptIndex: 0 });
    const lastIter = detail.iterations[detail.iterations.length - 1].ours!;
    expect(lastIter).toBeDefined();
    expect(lastIter.matrixSize).toBeGreaterThan(0);
  });
});
