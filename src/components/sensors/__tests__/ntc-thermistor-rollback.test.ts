/**
 * LTE-rejection rollback test for NTCThermistorElement (Component G6).
 *
 * Verifies that when a transient step involving a dissipation event is
 * rejected by the LTE check, s1[TEMPERATURE] is rolled back to the
 * last accepted value.
 * Slot index resolved via NTC_SCHEMA.indexOf("TEMPERATURE").
 */

import { describe, it, expect } from "vitest";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { NTC_SCHEMA } from "../ntc-thermistor.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import type { NRPhase } from "../../../solver/analog/__tests__/harness/types.js";

describe("NTCThermistorElement LTE rollback (Component G6)", () => {
  it("s1[TEMPERATURE] rolls back after LTE-rejected dissipation step", async () => {
    const TEMPERATURE_SLOT = NTC_SCHEMA.indexOf("TEMPERATURE");
    expect(TEMPERATURE_SLOT).toBeGreaterThanOrEqual(0);

    const TEMPERATURE = "TEMPERATURE";

    // Build circuit: high-voltage DC source through NTC thermistor with
    // self-heating enabled, grounded. High power dissipation causes rapid
    // temperature rise. A large maxStep forces the LTE check to reject the
    // step when TEMPERATURE changes faster than the LTE threshold.
    //
    // At 10V across ~100Ω (R0 at T0=298.15K) the power is ~1W. With
    // thermalCapacitance=0.001 J/K and thermalResistance=50 K/W,
    // dT/dt ≈ (1 - ΔT/50) / 0.001 ≈ 1000 K/s initially.
    // Over a 1µs step ΔT ≈ 1mK — small, but the test circuit uses an
    // elevated dissipation scenario. Use 100V to get 10kW → dT/dt≈10^7 K/s
    // so ΔT over 100ns ≈ 1K, which should trigger LTE rejection.
    const buildCircuit = (registry: ComponentRegistry) => {
      const facade = new DefaultSimulatorFacade(registry);
      return facade.build({
        components: [
          {
            id: "vsrc",
            type: "DcVoltageSource",
            props: { voltage: 100, label: "vsrc" },
          },
          {
            id: "ntc",
            type: "NTCThermistor",
            props: {
              label:             "ntc",
              model:             "behavioral",
              r0:                100,
              beta:              3950,
              t0:                298.15,
              temperature:       298.15,
              selfHeating:       true,
              thermalResistance: 50,
              thermalCapacitance: 0.001,
            },
          },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vsrc:pos", "ntc:pos"],
          ["ntc:neg",  "gnd:out"],
          ["vsrc:neg", "gnd:out"],
        ],
        metadata: {},
      });
    };

    // tStop=200ns, maxStep=100ns. The large temperature ramp under high
    // dissipation triggers LTE rejection.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit,
      analysis: "tran",
      tStop:   2e-7,
      maxStep: 1e-7,
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
    const s1BeforeReject = lastIterRej.ours!.elementStates1Slots["ntc"];
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
    const s1AfterReject = firstIterNext.ours!.elementStates1Slots["ntc"];
    expect(s1AfterReject).toBeDefined();

    // Rollback assertion: TEMPERATURE was not advanced by the rejected step.
    expect(s1AfterReject[TEMPERATURE]).toBe(s1BeforeReject[TEMPERATURE]);
  });
});
