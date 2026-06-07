import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
  DLL_PATH,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// DTS fixture paths (T3 harness) — all four already authored on disk.
// ---------------------------------------------------------------------------

// Static resistive operating region: ISRC=10mA into R=1k → V(node)=I*R=10V.
// At DCOP, the node sits at the closed-form value; the transient is flat.
// Exercises the ISRC RHS-only stamp at a fixed terminal voltage every iter.
const DTS_R_LOAD = path.resolve(
  "src/components/sources/__tests__/fixtures/current-source-canon-r-load.dts",
);

// Dynamic RC charging regime: ISRC=1mA charging 1uF cap with 10k bleed → GND.
// tau = RC = 10ms; V_cap rises across the transient toward V_inf = I*R = 10V.
// Exercises the ISRC RHS stamp under varying terminal voltage across iters
// and steps so per-iter sweeps catch any drift.
const DTS_RC_CHARGE = path.resolve(
  "src/components/sources/__tests__/fixtures/current-source-canon-rc-charge.dts",
);

// Scaling configurations on the same resistive topology (different I).
const DTS_2MA_1K = path.resolve(
  "src/components/sources/__tests__/fixtures/current-source-canon-2ma-1k.dts",
);
const DTS_5MA_1K = path.resolve(
  "src/components/sources/__tests__/fixtures/current-source-canon-5ma-1k.dts",
);

// ---------------------------------------------------------------------------
// Programmatic circuit builder for T1 categories
//   isrc (I A) -> R (resistance Ω) -> GND
//   V_node = I * R at DCOP convergence (KCL).
// ---------------------------------------------------------------------------

function buildIsrcCircuit(
  facade: DefaultSimulatorFacade,
  current: number,
  resistance: number,
): Circuit {
  return facade.build({
    components: [
      { id: "isrc", type: "DcCurrentSource", props: { label: "isrc", current } },
      { id: "r1",   type: "Resistor",      props: { label: "r1",   resistance } },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["isrc:pos", "r1:pos"],
      ["r1:neg",   "gnd:out"],
      ["isrc:neg", "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// ---------------------------------------------------------------------------

describe("CurrentSource initialization (T1)", () => {
  it("init_post_warm_start_node_voltage_matches_dcop", () => {
    // Cat 1: post-warm-start (one coordinator.step()) the node voltage at
    // isrc:pos must already equal the DCOP-seeded value.
    // I = 2 mA, R = 1 kΩ → V_node = I*R = 2.0 V.
    const fix = buildFixture({
      build: (_r, facade) => buildIsrcCircuit(facade, 0.002, 1000),
    });
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "isrc:pos"))).toBeCloseTo(2.0, 6);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical)
// ---------------------------------------------------------------------------

describe("CurrentSource DCOP analytical (T1)", () => {
  it("dcop_v_node_equals_i_times_r_2ma_1k", () => {
    // I = 2 mA into R = 1 kΩ → V_node = 2.0 V (closed form, KCL).
    const fix = buildFixture({
      build: (_r, facade) => buildIsrcCircuit(facade, 0.002, 1000),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "isrc:pos"))).toBeCloseTo(2.0, 9);
  });

  it("dcop_v_node_equals_i_times_r_5ma_1k", () => {
    // Second operating-region configuration: different current magnitude
    // surfaces any current scaling bug. I = 5 mA into 1 kΩ → V_node = 5.0 V.
    const fix = buildFixture({
      build: (_r, facade) => buildIsrcCircuit(facade, 0.005, 1000),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "isrc:pos"))).toBeCloseTo(5.0, 9);
  });

  it("dcop_pin_currents_neg_plus_pos_minus_match_stamp", () => {
    // CurrentSourceAnalogImpl.getPinCurrents returns [+I, -I] for [neg, pos]:
    // current enters the element at neg and exits at pos. With I = 2 mA the
    // element pin currents are [+0.002, -0.002].
    const fix = buildFixture({
      build: (_r, facade) => buildIsrcCircuit(facade, 0.002, 1000),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result!.converged).toBe(true);
    const isrcIdx = fix.elementIndex("isrc");
    const pinCurrents = fix.engine.getElementPinCurrents(isrcIdx);
    expect(pinCurrents.length).toBe(2);
    expect(pinCurrents[0]).toBeCloseTo(+0.002, 9); // neg
    expect(pinCurrents[1]).toBeCloseTo(-0.002, 9); // pos
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// ---------------------------------------------------------------------------

describe("CurrentSource parameter hot-load (T1)", () => {
  it("hotload_current_changes_v_node", () => {
    // Cat 4 structural parameter: changing `current` must shift V_node = I*R.
    // Before: I = 2 mA, R = 1 kΩ → V_node = 2.0 V.
    // After:  I = 5 mA, R = 1 kΩ → V_node = 5.0 V.
    const fix = buildFixture({
      build: (_r, facade) => buildIsrcCircuit(facade, 0.002, 1000),
    });
    const nodeId = nodeOf(fix, "isrc:pos");
    const before = fix.engine.getNodeVoltage(nodeId);
    expect(before).toBeCloseTo(2.0, 6);

    const isrcCe = fix.element("isrc");
    fix.coordinator.setComponentProperty(isrcCe, "current", 0.005);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(nodeId);
    expect(after).not.toBeCloseTo(before);
    expect(after).toBeCloseTo(5.0, 6);
  });
});

// ---------------------------------------------------------------------------
// CurrentSource paired vs ngspice — resistive load (T3) — Cat 2 num / 3 / 5
// ---------------------------------------------------------------------------
//
// Per Step 2c: the harness RUN lives in the FIRST it() of the describe
// (transient run); subsequent siblings read from the recorded session.

describeIfDll("CurrentSource paired vs ngspice — resistive load (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_R_LOAD, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_r_load", async () => {
    await session.runTransient(0, 1e-3, 10e-6);
    session.compareAllSteps();
  }, 120_000);

  it("dcop_paired_r_load", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_r_load", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// CurrentSource paired vs ngspice — RC charge (T3) — Cat 2 num / 3 / 5
// ---------------------------------------------------------------------------
//
// Dynamic-regime configuration: ISRC charging a capacitor through a bleed
// resistor. tau = RC = 10k * 1uF = 10ms; node voltage rises across the
// transient toward V_inf = I*R = 10V. Without this fixture the resistive-load
// .dts (static across the transient) hides any per-step drift in the ISRC RHS
// stamp under varying terminal voltage.

describeIfDll("CurrentSource paired vs ngspice — RC charge (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_RC_CHARGE, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_rc_charge", async () => {
    // tau = RC = 10k * 1uF = 10ms. Run to t=20ms (~2 tau) with a fine maxStep.
    await session.runTransient(0, 20e-3, 50e-6);
    session.compareAllSteps();
  }, 180_000);

  it("dcop_paired_rc_charge", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_rc_charge", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// CurrentSource DCOP paired vs ngspice — 2 mA into 1 kΩ (T3) — Cat 2 numerical
// ---------------------------------------------------------------------------
//
// Additional scaling-regime configuration on the same ISRC→R→GND topology to
// exercise the RHS stamp under a different current magnitude. V_node = 2.0 V.

describeIfDll("CurrentSource DCOP paired vs ngspice — 2 mA into 1 kΩ (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_2MA_1K, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("dcop_paired_2ma_1k", async () => {
    await session.runDcOp();
    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// CurrentSource DCOP paired vs ngspice — 5 mA into 1 kΩ (T3) — Cat 2 numerical
// ---------------------------------------------------------------------------
//
// Additional scaling-regime configuration. V_node = 5.0 V.

describeIfDll("CurrentSource DCOP paired vs ngspice — 5 mA into 1 kΩ (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_5MA_1K, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("dcop_paired_5ma_1k", async () => {
    await session.runDcOp();
    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });
});
