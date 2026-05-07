import { it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

// ---------------------------------------------------------------------------
// .dts paths
//
// The xfact MODEINITPRED predictor branch is observable through any transient
// run with ≥ 2 accepted steps: it fires whenever ckt->CKTmode has the
// MODEINITPRED bit set, which happens at the start of every NR attempt after
// the very first step. The two reused vetted ngspice-parity fixtures below
// drive that branch in two distinct semiconductor families (diode + BJT),
// satisfying the harness-tier minimum-two-configurations rule and exercising
// the xfact predictor in every state slot Diode and BJT publish.
// ---------------------------------------------------------------------------

const DTS_DIODE_R = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/diode-resistor.dts",
);
const DTS_BJT_CE = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/bjt-common-emitter.dts",
);

// ---------------------------------------------------------------------------
// Diode resistive transient — paired vs ngspice (T3).
// Categories 2-numerical / 3 / 5 against the diode-resistor fixture.
// xfact predictor extrapolates VD / ID / GEQ on every step ≥ 2 of the
// transient; compareAllAttempts walks every iteration of every attempt and
// catches any predictor divergence bit-exact.
// ---------------------------------------------------------------------------

describeIfDll("Diode resistive transient paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_DIODE_R,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_diode_resistive", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_diode_resistive", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("full_iteration_paired_diode_resistive", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// BJT common-emitter transient — paired vs ngspice (T3).
// Categories 2-numerical / 3 / 5 against the bjt-common-emitter fixture.
// Distinct semiconductor family from the diode session: the BJT MODEINITPRED
// branch extrapolates VBE / VBC (and VSUB on the L1 four-terminal path) and
// runs pnjlim on the predicted junction voltages. compareAllAttempts catches
// any divergence in either the extrapolation or the post-extrapolation
// pnjlim invocation bit-exact.
// ---------------------------------------------------------------------------

describeIfDll("BJT common-emitter transient paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_BJT_CE,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_bjt_ce", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_bjt_ce", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("full_iteration_paired_bjt_ce", () => {
    session.compareAllAttempts();
  });
});
