/**
 * LTE-rejection rollback test for the Analog Comparator (Component G8).
 *
 * Verifies that when a transient step crossing a switching threshold is
 * rejected by the LTE check, s1[OUTPUT_WEIGHT] is rolled back to the
 * last accepted value.
 * Slot index resolved via COMPARATOR_SCHEMA.indexOf("OUTPUT_WEIGHT").
 */

import { describe, it, expect } from "vitest";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { COMPARATOR_SCHEMA } from "../comparator.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import type { NRPhase } from "../../../solver/analog/__tests__/harness/types.js";

describe("Comparator LTE rollback (Component G8)", () => {
  it("s1[OUTPUT_WEIGHT] rolls back after LTE-rejected switching-threshold step", async () => {
    const OUTPUT_WEIGHT_SLOT = COMPARATOR_SCHEMA.indexOf("OUTPUT_WEIGHT");
    expect(OUTPUT_WEIGHT_SLOT).toBeGreaterThanOrEqual(0);

    const OUTPUT_WEIGHT = "OUTPUT_WEIGHT";

    // Build circuit: comparator with in+ driven above threshold so OUTPUT_WEIGHT
    // ramps rapidly under the response-time RC model. The fast RC transition
    // (responseTime=1e-9 s) causes OUTPUT_WEIGHT to change sharply, which the
    // LTE check flags when maxStep is large relative to responseTime.
    //
    // Circuit:
    //   vsrc_p (in+) = 1V  (above 0.5V mid-rail threshold with vos=0)
    //   vsrc_n (in-) = 0V
    //   vsrc_voh: 3.3V pull-up rail
    //   rload (out pull-up): out → 3.3V via 1kΩ
    //   comparator: open-collector, no hysteresis, fast responseTime
    const buildCircuit = (registry: ComponentRegistry) => {
      const facade = new DefaultSimulatorFacade(registry);
      return facade.build({
        components: [
          {
            id: "vsrc_p",
            type: "DcVoltageSource",
            props: { voltage: 1, label: "vsrc_p" },
          },
          {
            id: "vsrc_n",
            type: "DcVoltageSource",
            props: { voltage: 0, label: "vsrc_n" },
          },
          {
            id: "vsrc_voh",
            type: "DcVoltageSource",
            props: { voltage: 3.3, label: "vsrc_voh" },
          },
          {
            id: "rload",
            type: "Resistor",
            props: { resistance: 1000 },
          },
          {
            id: "cmp",
            type: "VoltageComparator",
            props: {
              label:        "cmp",
              model:        "open-collector",
              hysteresis:   0,
              vos:          0,
              rSat:         50,
              responseTime: 1e-9,
            },
          },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vsrc_p:pos",   "cmp:in+"],
          ["vsrc_p:neg",   "gnd:out"],
          ["vsrc_n:pos",   "cmp:in-"],
          ["vsrc_n:neg",   "gnd:out"],
          ["vsrc_voh:pos", "rload:A"],
          ["vsrc_voh:neg", "gnd:out"],
          ["rload:B",      "cmp:out"],
          ["cmp:out",      "gnd:out"],
        ],
        metadata: {},
      });
    };

    // tStop=20ns, maxStep=10ns. The responseTime=1ns RC is much faster than
    // maxStep, so OUTPUT_WEIGHT changes significantly per step, triggering
    // LTE rejection.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit,
      analysis: "tran",
      tStop:   2e-8,
      maxStep: 1e-8,
    });

    // Locate the first LTE-rejected attempt.
    const map   = session.sessionMap();
    const steps = map.ours.steps;

    let rejectedStepIndex       = -1;
    let rejectedPhase: NRPhase   = "tranNR";
    let rejectedPhaseAttemptIdx  = -1;

    outer: for (const step of steps) {
      for (let ai = 0; ai < step.attempts.length; ai++) {
        const attempt = step.attempts[ai];
        if (attempt.outcome === "lteRejectedRetry") {
          rejectedStepIndex = step.index;
          rejectedPhase     = attempt.phase;
          let phaseCount = 0;
          for (let k = 0; k < ai; k++) {
            if (step.attempts[k].phase === attempt.phase) phaseCount++;
          }
          rejectedPhaseAttemptIdx = phaseCount;
          break outer;
        }
      }
    }

    // If no LTE rejection occurred the rollback path was not exercised.
    expect(rejectedStepIndex).toBeGreaterThanOrEqual(0);

    // s1 at the last iteration of the rejected attempt.
    const rejAttempt = session.getAttempt({
      stepIndex:         rejectedStepIndex,
      phase:             rejectedPhase,
      phaseAttemptIndex: rejectedPhaseAttemptIdx,
    });
    const lastIterRej = rejAttempt.iterations[rejAttempt.iterations.length - 1];
    expect(lastIterRej).toBeDefined();
    expect(lastIterRej.ours).not.toBeNull();
    const s1BeforeReject = lastIterRej.ours!.elementStates1Slots["cmp"];
    expect(s1BeforeReject).toBeDefined();

    // s1 at the first iteration of the next step's first tranNR attempt.
    const nextStepIndex = rejectedStepIndex + 1;
    expect(steps[nextStepIndex]).toBeDefined();

    const nextAttempt = session.getAttempt({
      stepIndex:         nextStepIndex,
      phase:             "tranNR" as NRPhase,
      phaseAttemptIndex: 0,
    });
    const firstIterNext = nextAttempt.iterations[0];
    expect(firstIterNext).toBeDefined();
    expect(firstIterNext.ours).not.toBeNull();
    const s1AfterReject = firstIterNext.ours!.elementStates1Slots["cmp"];
    expect(s1AfterReject).toBeDefined();

    // Rollback assertion: OUTPUT_WEIGHT was not advanced by the rejected step.
    expect(s1AfterReject[OUTPUT_WEIGHT]).toBe(s1BeforeReject[OUTPUT_WEIGHT]);
  });
});
