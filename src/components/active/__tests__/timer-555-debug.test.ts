/**
 * Diagnostic test for timer-555 transient failure.
 * DELETE after fixing.
 */
import { describe, it } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import type { ComponentRegistry } from "../../../core/registry.js";

function buildTimer555DebugCircuit(registry: ComponentRegistry) {
  const R1 = 1000;
  const R2 = 10000;
  const C  = 10e-6;
  const VCC = 5;

  const facade = new DefaultSimulatorFacade(registry);
  return facade.build({
    components: [
      { id: "vcc",  type: "DcVoltageSource", props: { voltage: VCC, label: "vcc" } },
      { id: "t",    type: "Timer555",        props: { label: "t", vDrop: 1.5 } },
      { id: "r1",   type: "Resistor",        props: { resistance: R1 } },
      { id: "r2",   type: "Resistor",        props: { resistance: R2 } },
      { id: "cap",  type: "Capacitor",       props: { capacitance: C, label: "cap" } },
      { id: "rout", type: "Resistor",        props: { resistance: 1e6 } },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vcc:pos", "t:VCC"],
      ["vcc:neg", "gnd:out"],
      ["t:GND",   "gnd:out"],
      ["t:RST",   "t:VCC"],
      ["t:VCC",   "r1:A"],
      ["r1:B",    "t:DIS"],
      ["t:DIS",   "r2:A"],
      ["r2:B",    "t:THR"],
      ["t:THR",   "t:TRIG"],
      ["t:THR",   "cap:pos"],
      ["cap:neg", "gnd:out"],
      ["t:OUT",   "rout:A"],
      ["rout:B",  "gnd:out"],
    ],
  });
}

describe("Timer555Debug", () => {
  it("diagnose_first_transient_step", async () => {
    const R1 = 1000;
    const R2 = 10000;
    const C  = 10e-6;

    const fExpected = 1.44 / ((R1 + 2 * R2) * C);
    const periodExpected = 1 / fExpected;
    const maxDt = periodExpected * 0.002;
    const tStop = periodExpected * 0.04; // 20 steps worth

    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildTimer555DebugCircuit,
      analysis: "tran",
      tStop,
      maxStep: maxDt,
    });

    const stepCount = session.sessionMap().ours.length;
    console.log(`Total steps captured: ${stepCount}`);

    // DC-OP step (stepIndex 0): log convergence and cap state.
    const dcAttempt = session.getAttempt({ stepIndex: 0, phase: "dcopDirect", phaseAttemptIndex: 0 });
    const dcLastIter = dcAttempt.iterations[dcAttempt.iterations.length - 1];
    const dcConverged = dcLastIter?.ours?.globalConverged ?? false;
    console.log("DC converged:", dcConverged, "iters:", dcAttempt.iterations.length);

    const capStatesAfterDc = dcLastIter?.ours?.elementStates["cap"];
    const capStates1AfterDc = dcLastIter?.ours?.elementStates1Slots["cap"];
    console.log(`After DC-OP: cap state0.Q=${capStatesAfterDc?.["Q"]}, cap state1.Q=${capStates1AfterDc?.["Q"]}`);

    // Transient steps: log cap state for each of the first few steps.
    const maxLogSteps = Math.min(20, stepCount - 1);
    for (let s = 1; s <= maxLogSteps; s++) {
      const attempt = session.getAttempt({ stepIndex: s, phase: "tran", phaseAttemptIndex: 0 });
      const lastIter = attempt.iterations[attempt.iterations.length - 1];
      const q0 = lastIter?.ours?.elementStates["cap"]?.["Q"];
      const q1 = lastIter?.ours?.elementStates1Slots["cap"]?.["Q"];
      const stepEnd = session.getStepEnd(s);
      const lteRejected = stepEnd.lteRejected?.ours ?? false;
      console.log(`Step ${s}: q0=${q0 != null ? (q0 as number).toExponential(4) : "n/a"} q1=${q1 != null ? (q1 as number).toExponential(4) : "n/a"} lteRejected=${lteRejected}`);
    }

    const shape = session.getStepShape();
    console.log(`\nTotal log records: ${shape.steps.length}, final converged: ${session.getStepEnd(stepCount - 1).converged.ours}`);
  });
});
