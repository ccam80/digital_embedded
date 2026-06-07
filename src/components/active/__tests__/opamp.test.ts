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

const DTS_BUFFER_ROUT75 = path.resolve(
  "src/components/active/__tests__/fixtures/opamp-canon-buffer-rout75.dts",
);
const DTS_INVERTING_ROUT0 = path.resolve(
  "src/components/active/__tests__/fixtures/opamp-canon-inverting-rout0.dts",
);

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1)
// ---------------------------------------------------------------------------
//
// Topology A — Open-loop differential amplifier (rOut > 0 -> composite VCVS+RES path):
//   Vp (in+) and Vn (in-) driven by independent DC sources.
//   Output loaded by Rload to GND.
//   No feedback — avoids transient warm-start stagnation.
//   V(out) = gain*(Vp - Vn) * Rload / (Rload + rOut)  [voltage divider on output].
//
// Topology B — Inverting amplifier (rOut == 0 -> VCVS-only path):
//   Vin -> Rin -> opamp:in-
//   Rf:  opamp:in- <-> opamp:out  (feedback)
//   opamp:in+ -> GND
//   Closed-loop gain = -Rf/Rin.

interface OpAmpOpenLoopParams {
  vp?: number;
  vn?: number;
  rLoad?: number;
  gain?: number;
  rOut?: number;
}

function buildOpAmpOpenLoop(facade: DefaultSimulatorFacade, p: OpAmpOpenLoopParams): Circuit {
  // Open-loop: V(out) = gain*(vp - vn) * Rload / (Rload + rOut).
  // With small differential and rOut limiting: deterministic, no feedback stagnation.
  return facade.build({
    components: [
      { id: "vp",    type: "DcVoltageSource", props: { label: "vp",    voltage: p.vp ?? 1e-3 } },
      { id: "vn",    type: "DcVoltageSource", props: { label: "vn",    voltage: p.vn ?? 0.0 } },
      { id: "rload", type: "Resistor",        props: { label: "rload", resistance: p.rLoad ?? 1000 } },
      { id: "opamp", type: "OpAmp",           props: { label: "opamp", gain: p.gain ?? 1e3, rOut: p.rOut ?? 75 } },
      { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vp:pos",    "opamp:in+"],
      ["vp:neg",    "gnd:out"],
      ["vn:pos",    "opamp:in-"],
      ["vn:neg",    "gnd:out"],
      ["opamp:out", "rload:pos"],
      ["rload:neg", "gnd:out"],
    ],
  });
}

interface OpAmpInvertingParams {
  vin?: number;
  rIn?: number;
  rF?: number;
  gain?: number;
  rOut?: number;
}

function buildOpAmpInverting(facade: DefaultSimulatorFacade, p: OpAmpInvertingParams): Circuit {
  return facade.build({
    components: [
      { id: "vin",   type: "DcVoltageSource", props: { label: "vin",   voltage: p.vin ?? 0.1 } },
      { id: "rin",   type: "Resistor",        props: { label: "rin",   resistance: p.rIn ?? 1000 } },
      { id: "rf",    type: "Resistor",        props: { label: "rf",    resistance: p.rF ?? 10000 } },
      { id: "opamp", type: "OpAmp",           props: { label: "opamp", gain: p.gain ?? 1e5, rOut: p.rOut ?? 0 } },
      { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vin:pos",   "rin:pos"],
      ["rin:neg",   "opamp:in-"],
      ["rf:pos",    "opamp:in-"],
      ["rf:neg",    "opamp:out"],
      ["opamp:in+", "gnd:out"],
      ["vin:neg",   "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ---------------------------------------------------------------------------
// OpAmp initialization (T1) — Cat 1
// ---------------------------------------------------------------------------

describe("OpAmp initialization (T1)", () => {
  it("init_post_warm_start_open_loop_rout75", () => {
    // Cat 1: post-warm-start node voltages for the composite VCVS+RES path.
    // Open-loop: Vp=1mV, Vn=0V, gain=1000, rOut=75, Rload=1k.
    //   V(vint) = gain*(Vp-Vn) = 1000*1e-3 = 1V  (internal VCVS output)
    //   V(out)  = V(vint) * Rload / (Rload + rOut)
    //           = 1 * 1000/1075 ~= 0.93023V
    const fix = buildFixture({
      build: (_r, facade) => buildOpAmpOpenLoop(facade, {
        vp: 1e-3, vn: 0.0, rLoad: 1000, gain: 1e3, rOut: 75,
      }),
    });
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "opamp:in+"))).toBeCloseTo(1e-3, 6);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"))).toBeCloseTo(0.93023, 3);
  });

  it("init_post_warm_start_open_loop_rout0", () => {
    // Cat 1 for the rOut==0 (VCVS-only) topology variant.
    // Open-loop: Vp=1mV, Vn=0V, gain=1000, rOut=0, Rload=1k.
    //   V(out) = gain*(Vp-Vn) * Rload/(Rload+0) = 1V  (VCVS drives directly)
    const fix = buildFixture({
      build: (_r, facade) => buildOpAmpOpenLoop(facade, {
        vp: 1e-3, vn: 0.0, rLoad: 1000, gain: 1e3, rOut: 0,
      }),
    });
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"))).toBeCloseTo(1.0, 4);
  });
});

// ---------------------------------------------------------------------------
// OpAmp DCOP analytical (T1) — Cat 2 analytical
// ---------------------------------------------------------------------------

describe("OpAmp DCOP analytical (T1)", () => {
  it("dcop_open_loop_rout75_output_voltage_divider", () => {
    // Cat 2 analytical: open-loop with composite VCVS+RES path.
    // Vp=5mV, Vn=0V, gain=1000, rOut=75, Rload=1k.
    //   V(vint) = 1000 * 5e-3 = 5V (ideal VCVS output at internal node)
    //   V(out)  = 5 * 1000/(1000+75) = 5 * 0.93023 = 4.65116V
    const fix = buildFixture({
      build: (_r, facade) => buildOpAmpOpenLoop(facade, {
        vp: 5e-3, vn: 0.0, rLoad: 1000, gain: 1e3, rOut: 75,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"))).toBeCloseTo(4.65116, 3);
  });

  it("dcop_open_loop_rout0_vcvs_only", () => {
    // Cat 2 analytical for the rOut==0 (VCVS-only) path.
    // Vp=2mV, Vn=0V, gain=1000, rOut=0, Rload=1k.
    //   V(out) = 1000 * 2e-3 = 2V  (VCVS drives out directly, no series rOut)
    const fix = buildFixture({
      build: (_r, facade) => buildOpAmpOpenLoop(facade, {
        vp: 2e-3, vn: 0.0, rLoad: 1000, gain: 1e3, rOut: 0,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"))).toBeCloseTo(2.0, 4);
  });

  it("dcop_open_loop_differential_input", () => {
    // Vp=3mV, Vn=1mV -> Vdiff=2mV; gain=500, rOut=0, Rload=1k.
    //   V(out) = 500 * 2e-3 = 1V
    const fix = buildFixture({
      build: (_r, facade) => buildOpAmpOpenLoop(facade, {
        vp: 3e-3, vn: 1e-3, rLoad: 1000, gain: 5e2, rOut: 0,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"))).toBeCloseTo(1.0, 4);
  });

  it("dcop_inverting_amplifier_gain_minus_10", () => {
    // Cat 2 analytical for the inverting closed-loop topology (rOut==0).
    // Vin=0.2V, Rf/Rin=10:
    //   V(out) = -10 * 0.2 = -2.0V (ideal virtual ground at in-).
    const fix = buildFixture({
      build: (_r, facade) => buildOpAmpInverting(facade, {
        vin: 0.2, rIn: 1000, rF: 10000, gain: 1e5, rOut: 0,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"))).toBeCloseTo(-2.0, 3);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "opamp:in-"))).toBeCloseTo(0.0, 4);
  });

  it("dcop_zero_differential_zero_output", () => {
    // Vp=Vn=1V -> Vdiff=0 -> V(out) = 0V (ideal opamp, no offset).
    const fix = buildFixture({
      build: (_r, facade) => buildOpAmpOpenLoop(facade, {
        vp: 1.0, vn: 1.0, rLoad: 1000, gain: 1e3, rOut: 75,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"))).toBeCloseTo(0.0, 6);
  });
});

// ---------------------------------------------------------------------------
// OpAmp parameter hot-load (T1) — Cat 4
// ---------------------------------------------------------------------------

describe("OpAmp parameter hot-load (T1)", () => {
  it("hotload_gain_changes_open_loop_output", () => {
    // Cat 4: setComponentProperty on `gain` changes V(opamp:out).
    // Open-loop: Vp=1mV, Vn=0V, rOut=0, Rload=1k.
    //   gain=500  -> V(out) = 500 * 1e-3 = 0.5V
    //   gain=2000 -> V(out) = 2000 * 1e-3 = 2.0V
    const fix = buildFixture({
      build: (_r, facade) => buildOpAmpOpenLoop(facade, {
        vp: 1e-3, vn: 0.0, rLoad: 1000, gain: 500, rOut: 0,
      }),
    });
    const outNode = nodeOf(fix, "opamp:out");
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(0.5, 4);

    const opampEl = fix.element("opamp");
    fix.coordinator.setComponentProperty(opampEl, "gain", 2000);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).not.toBeCloseTo(before);
    expect(after).toBeCloseTo(2.0, 4);
  });

  it("hotload_rOut_changes_output_divider", () => {
    // Cat 4: rOut changes the resistive divider between vint and opamp:out.
    // Open-loop: Vp=10mV, Vn=0V, gain=1000, Rload=1k.
    //   V(vint) = 1000 * 10e-3 = 10V (VCVS output at internal node)
    //   rOut=100  -> V(out) = 10 * 1000/(1000+100)  = 10 * 0.90909 = 9.0909V
    //   rOut=4000 -> V(out) = 10 * 1000/(1000+4000) = 10 * 0.20000 = 2.0000V
    const fix = buildFixture({
      build: (_r, facade) => buildOpAmpOpenLoop(facade, {
        vp: 10e-3, vn: 0.0, rLoad: 1000, gain: 1e3, rOut: 100,
      }),
    });
    const outNode = nodeOf(fix, "opamp:out");
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(9.0909, 3);

    const opampEl = fix.element("opamp");
    fix.coordinator.setComponentProperty(opampEl, "rOut", 4000);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).not.toBeCloseTo(before);
    expect(after).toBeCloseTo(2.0, 3);
  });
});

// ---------------------------------------------------------------------------
// OpAmp — T3 harness: voltage-follower rOut=75 paired vs ngspice
// (Cat 2-numerical / 3 / 5)
// ---------------------------------------------------------------------------

describeIfDll("OpAmp voltage-follower rOut=75 paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_BUFFER_ROUT75, analysis: "tran", tStop: 1e-4, maxStep: 1e-6 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_buffer_rout75", async () => {
    // First it() owns the run. tStop=1e-4 s, maxStep=1e-6 s.
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_buffer_rout75", () => {
    // Cat 2-numerical: read step 0 (DCOP seed) from the recorded session.
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_buffer_rout75", () => {
    // Cat 5: every NR iteration of every attempt of every step.
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// OpAmp — T3 harness: inverting rOut=0 paired vs ngspice
// (Cat 2-numerical / 3 / 5)
// ---------------------------------------------------------------------------

describeIfDll("OpAmp inverting rOut=0 paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_INVERTING_ROUT0, analysis: "tran", tStop: 1e-4, maxStep: 1e-6 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_inverting_rout0", async () => {
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_inverting_rout0", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_inverting_rout0", () => {
    session.compareAllAttempts();
  });
});
