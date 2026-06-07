import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// DTS fixture paths (T3 harness)
// ---------------------------------------------------------------------------

const DTS_LINEAR = path.resolve(
  "src/components/active/__tests__/fixtures/ota-canon-linear.dts",
);
const DTS_SATURATED = path.resolve(
  "src/components/active/__tests__/fixtures/ota-canon-saturated.dts",
);

// ---------------------------------------------------------------------------
// Programmatic OTA circuit factory (T1)
// ---------------------------------------------------------------------------
//
// Topology (matches the .dts fixtures):
//   vp(V+)    --> ota:V+
//   vm(0V)    --> ota:V-
//   viabc(I_bias as voltage; 1A/V mapping per OTA spec) --> ota:Iabc
//   ota:OUT+  --> rload --> GND
//   ota:OUT   --> GND
//
// Closed-form transfer function (ota.ts):
//   twoVt   = 2 * vt
//   tanhX   = tanh(vDiff / twoVt)
//   I_out   = I_bias * tanhX
//   V_out   = I_out * R_load (V_OUT- is grounded)

interface OtaCircuitParams {
  vDiff: number;
  iBias: number;
  rLoad: number;
  vt?: number;
  gmMax?: number;
}

function buildOtaCircuit(facade: DefaultSimulatorFacade, p: OtaCircuitParams): Circuit {
  const otaProps: Record<string, string | number> = { label: "ota1", model: "behavioral" };
  if (p.vt !== undefined) otaProps.vt = p.vt;
  if (p.gmMax !== undefined) otaProps.gmMax = p.gmMax;
  return facade.build({
    components: [
      { id: "ota",   type: "OTA",             props: otaProps },
      { id: "vp",    type: "DcVoltageSource", props: { label: "vp",    voltage: p.vDiff } },
      { id: "vm",    type: "DcVoltageSource", props: { label: "vm",    voltage: 0 } },
      { id: "viabc", type: "DcVoltageSource", props: { label: "viabc", voltage: p.iBias } },
      { id: "rload", type: "Resistor",        props: { label: "rload", resistance: p.rLoad } },
      { id: "gnd",   type: "Ground" },
    ],
    connections: [
      ["vp:pos",    "ota:V+"],
      ["vp:neg",    "gnd:out"],
      ["vm:pos",    "ota:V-"],
      ["vm:neg",    "gnd:out"],
      ["viabc:pos", "ota:Iabc"],
      ["viabc:neg", "gnd:out"],
      ["ota:OUT+",  "rload:pos"],
      ["rload:neg", "gnd:out"],
      ["ota:OUT",   "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ---------------------------------------------------------------------------
// Cat 1 — Initialization (T1)
// ---------------------------------------------------------------------------

describe("OTA initialization (T1)", () => {
  it("init_post_warm_start_node_voltages_match_dcop_linear", () => {
    // Cat 1: post-warm-start (one coordinator.step()) the node voltage at
    // ota1:OUT+ matches the DCOP-seeded value.
    // V_diff = 1mV, V_T = 26mV, I_bias = 1mA, R_load = 1k.
    // I_out = I_bias * tanh(V_diff / (2*V_T)) ~= 19.23 uA.
    // V(rload+) = I_out * R_load ~= 19.23 mV.
    const vt    = 0.026;
    const iBias = 1e-3;
    const vDiff = 1e-3;
    const rLoad = 1000;

    const fix = buildFixture({
      build: (_r, facade) => buildOtaCircuit(facade, { vDiff, iBias, rLoad, vt }),
    });

    // V+ driven by vp(1mV); V- by vm(0V); Iabc by viabc(1mA -> 1mV).
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "ota1:V+"))).toBeCloseTo(vDiff, 6);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "ota1:V-"))).toBeCloseTo(0, 9);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "ota1:Iabc"))).toBeCloseTo(iBias, 6);

    const tanhX = Math.tanh(vDiff / (2 * vt));
    const iOut  = iBias * tanhX;
    const vOutExpected = iOut * rLoad;
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "ota1:OUT+"))).toBeCloseTo(vOutExpected, 6);
  });
});

// ---------------------------------------------------------------------------
// Cat 2 — DCOP analytical (T1)
// ---------------------------------------------------------------------------

describe("OTA DCOP analytical (T1)", () => {
  it("dcop_linear_region_gm_times_vdiff", () => {
    // V_diff = 1mV << 2*V_T -> linear region; I_out ~= gm * V_diff.
    // gm = I_bias / (2*V_T) ~= 19.23 mS; V_out ~= 19.23 mV.
    const vt    = 0.026;
    const iBias = 1e-3;
    const vDiff = 1e-3;
    const rLoad = 1000;

    const fix = buildFixture({
      build: (_r, facade) => buildOtaCircuit(facade, { vDiff, iBias, rLoad, vt }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const tanhX = Math.tanh(vDiff / (2 * vt));
    const iOut  = iBias * tanhX;
    const vOutExpected = iOut * rLoad;
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "ota1:OUT+"))).toBeCloseTo(vOutExpected, 6);
  });

  it("dcop_tanh_saturation_clamps_to_ibias", () => {
    // V_diff = 1V >> 2*V_T -> tanh saturates near +1.
    // I_out -> +I_bias; V_out -> +I_bias * R_load.
    const vt    = 0.026;
    const iBias = 5e-3;
    const vDiff = 1.0;
    const rLoad = 1000;

    const fix = buildFixture({
      build: (_r, facade) => buildOtaCircuit(facade, { vDiff, iBias, rLoad, vt }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const tanhX = Math.tanh(vDiff / (2 * vt));
    const iOut  = iBias * tanhX;
    const vOutExpected = iOut * rLoad;
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "ota1:OUT+"))).toBeCloseTo(vOutExpected, 6);
  });

  it("dcop_zero_vdiff_zero_output", () => {
    // V_diff = 0 -> tanh(0) = 0 -> I_out = 0 -> V_out = 0.
    const vt    = 0.026;
    const iBias = 1e-3;
    const vDiff = 0;
    const rLoad = 1000;

    const fix = buildFixture({
      build: (_r, facade) => buildOtaCircuit(facade, { vDiff, iBias, rLoad, vt }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "ota1:OUT+"))).toBeCloseTo(0, 9);
  });
});

// ---------------------------------------------------------------------------
// Cat 4 — Parameter hot-load (T1)
// ---------------------------------------------------------------------------

describe("OTA parameter hot-load (T1)", () => {
  it("hotload_vt_decrease_increases_gm_and_vout", () => {
    // gm = I_bias / (2*V_T): halving V_T doubles gm. In the linear region
    // (small V_diff) V_out ~= gm * V_diff * R_load, so V_out should ~double
    // (clamped by gmMax if reached).
    // Start: vt=0.026, iBias=1mA, vDiff=1mV, rLoad=1k -> V_out~=19.23 mV.
    // After: vt=0.013 -> gm doubles -> V_out~=38.46 mV (gmMax default 0.01 S
    // permits gm up to 0.01 S; raw gm goes 19.23 mS -> 38.46 mS, both clamped
    // by gmMax=10 mS for the stamp Jacobian, but the Norton constant uses
    // I_out which is I_bias * tanh(x) — this still doubles the slope of
    // the tanh near zero in the I_out term).
    const vt0    = 0.026;
    const iBias  = 1e-3;
    const vDiff  = 1e-3;
    const rLoad  = 1000;

    const fix = buildFixture({
      build: (_r, facade) => buildOtaCircuit(facade, { vDiff, iBias, rLoad, vt: vt0 }),
    });
    const outNode = nodeOf(fix, "ota1:OUT+");
    const before  = fix.engine.getNodeVoltage(outNode);
    const tanhX0  = Math.tanh(vDiff / (2 * vt0));
    expect(before).toBeCloseTo(iBias * tanhX0 * rLoad, 6);

    const otaEl = fix.element("ota1");
    const vt1   = 0.013;
    fix.coordinator.setComponentProperty(otaEl, "vt", vt1);
    fix.coordinator.step();
    const after  = fix.engine.getNodeVoltage(outNode);
    const tanhX1 = Math.tanh(vDiff / (2 * vt1));
    const expectedAfter = iBias * tanhX1 * rLoad;

    expect(after).not.toBeCloseTo(before);
    expect(after).toBeCloseTo(expectedAfter, 6);
  });

  it("hotload_gmMax_clamp_changes_vout_in_linear_region", () => {
    // gmMax bounds the Jacobian slope used in the NR Norton stamp. In the
    // linear region the raw gm = I_bias/(2*V_T) = 1e-3/0.052 ~= 19.23 mS.
    // With default gmMax=0.01 (10 mS), gm is clamped to 10 mS at the stamp.
    // Tightening gmMax to 1e-4 (0.1 mS) clamps gm an order of magnitude
    // lower, which changes the NR fixed point's Norton offset and shifts
    // V_out. Loosening gmMax above the raw gm leaves the stamp un-clamped
    // and uses the unclamped slope.
    const vt    = 0.026;
    const iBias = 1e-3;
    const vDiff = 1e-3;
    const rLoad = 1000;

    const fix = buildFixture({
      build: (_r, facade) => buildOtaCircuit(facade, {
        vDiff, iBias, rLoad, vt, gmMax: 1.0,
      }),
    });
    const outNode = nodeOf(fix, "ota1:OUT+");
    const before  = fix.engine.getNodeVoltage(outNode);

    const otaEl = fix.element("ota1");
    fix.coordinator.setComponentProperty(otaEl, "gmMax", 1e-4);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNode);

    // Documented contract: clamping the Jacobian slope shifts the converged
    // V_out at the same operating point. Direction: tightening gmMax reduces
    // the effective small-signal slope, so the V_out magnitude moves.
    expect(after).not.toBeCloseTo(before);
  });

  it("hotload_iabc_drives_ibias_changes_vout", () => {
    // Cat 4 sibling: changing the upstream voltage source on Iabc changes
    // I_bias (1A/V mapping per ota.ts) and therefore V_out in the linear
    // region (V_out scales with I_bias).
    // Start: viabc=1mA -> V_out ~= I_bias*tanh(x)*R_load.
    // After: viabc=2mA -> V_out doubles (linear region).
    const vt    = 0.026;
    const vDiff = 1e-3;
    const rLoad = 1000;
    const iBias0 = 1e-3;

    const fix = buildFixture({
      build: (_r, facade) => buildOtaCircuit(facade, {
        vDiff, iBias: iBias0, rLoad, vt,
      }),
    });
    const outNode = nodeOf(fix, "ota1:OUT+");
    const before  = fix.engine.getNodeVoltage(outNode);
    const tanhX   = Math.tanh(vDiff / (2 * vt));
    expect(before).toBeCloseTo(iBias0 * tanhX * rLoad, 6);

    const iBias1 = 2e-3;
    fix.coordinator.setSourceByLabel("viabc", "voltage", iBias1);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNode);
    const expectedAfter = iBias1 * tanhX * rLoad;

    expect(after).not.toBeCloseTo(before);
    expect(after).toBeCloseTo(expectedAfter, 6);
  });
});

// ---------------------------------------------------------------------------
// OTA — T3 harness: linear region paired vs ngspice (Cat 2-num / 3 / 5)
// ---------------------------------------------------------------------------

describeIfDll("OTA linear region paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_LINEAR, analysis: "tran", tStop: 1e-4, maxStep: 1e-6 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_linear", async () => {
    // First it() owns the run; tStop=1e-4 s, maxStep=1e-6 s.
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_linear", () => {
    // Cat 2-numerical: reads from the recorded session (step 0 = DCOP seed).
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_linear", () => {
    // Cat 5: every NR iteration of every attempt of every step.
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// OTA — T3 harness: tanh saturation paired vs ngspice (Cat 2-num / 3 / 5)
// ---------------------------------------------------------------------------

describeIfDll("OTA tanh saturation paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_SATURATED, analysis: "tran", tStop: 1e-4, maxStep: 1e-6 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_saturated", async () => {
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_saturated", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_saturated", () => {
    session.compareAllAttempts();
  });
});
