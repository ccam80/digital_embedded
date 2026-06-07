import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
  DLL_PATH,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

import type { Circuit } from "../../../core/circuit.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// .dts fixture paths (T3 harness) — authored under fixtures/
// ---------------------------------------------------------------------------
//
// Pass-through: vs=1V to tg:out1, p1=1V (NFET drv on), p2=0V (PFET drv on),
// rload=1k from tg:out2 to ground. Both paths conducting → series Ron+Rload
// divider drives out2 close to vs.
const DTS_PASS_THROUGH = path.resolve(
  "src/components/switching/__tests__/fixtures/trans-gate-canon-pass-through.dts",
);

// Isolation: vs=1V to tg:out1, p1=0V (NFET drv off), p2=1V (PFET drv off),
// rload=1k from tg:out2 to ground. Both paths off → two parallel Roff=1e9
// paths → Roff_eff=500MΩ. out2 sits at ~2µV (Roff_eff/Rload divider).
const DTS_ISOLATION = path.resolve(
  "src/components/switching/__tests__/fixtures/trans-gate-canon-isolation.dts",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ---------------------------------------------------------------------------
// Programmatic circuit factory (T1) — analog regime
// ---------------------------------------------------------------------------
//
// vs (1V) → tg:out1; p1 driven by vp1 (configurable), p2 driven by vp2
// (configurable); tg:out2 → rload (1k) → gnd.
//
// With Ron=1Ω, Rload=1kΩ, both gates conducting:
//   V(out2) = vs * Rload / (Ron + Rload) = 1 * 1000 / 1001 ≈ 0.999V.
// With both gates off (Roff=1e9):
//   V(out2) = vs * Rload / (Roff + Rload) ≈ vs * 1e-6 ≈ 1µV.

interface AnalogTgParams {
  vs?: number;
  vp1?: number;
  vp2?: number;
  Ron?: number;
  Roff?: number;
  Vth?: number;
  Rload?: number;
}

function buildAnalogTransGateCircuit(facade: DefaultSimulatorFacade, p: AnalogTgParams = {}): Circuit {
  return facade.build({
    components: [
      { id: "vs",    type: "DcVoltageSource", props: { label: "vs",    voltage: p.vs    ?? 1 } },
      { id: "vp1",   type: "DcVoltageSource", props: { label: "vp1",   voltage: p.vp1   ?? 1 } },
      { id: "vp2",   type: "DcVoltageSource", props: { label: "vp2",   voltage: p.vp2   ?? 0 } },
      { id: "tg",    type: "TransGate",       props: { label: "tg",
                                                       model: "behavioral",
                                                       Ron:  p.Ron  ?? 1,
                                                       Roff: p.Roff ?? 1e9,
                                                       Vth:  p.Vth  ?? 0.5 } },
      { id: "rload", type: "Resistor",        props: { label: "rload", resistance: p.Rload ?? 1000 } },
      { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos",    "tg:out1"],
      ["vs:neg",    "gnd:out"],
      ["vp1:pos",   "tg:p1"],
      ["vp1:neg",   "gnd:out"],
      ["vp2:pos",   "tg:p2"],
      ["vp2:neg",   "gnd:out"],
      ["tg:out2",   "rload:pos"],
      ["rload:neg", "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Programmatic circuit factory (T1) — digital bridge regime (Cat 9 / 12)
// ---------------------------------------------------------------------------
//
// In drives p1 and p2 (the digital control inputs); In drives out1 (data in);
// Out observes out2 (data out). The classic complementary-gate truth table is:
//   p1=1, p2=0 → switch closed → out2 follows out1
//   p1=0, p2=1 → switch open   → out2 floats (high-Z)
//   p1=p2 (both 0 or both 1) → forbidden / invalid → switch open (Cat 12)

function buildDigitalTransGateCircuit(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: "p1",   type: "In",        props: { label: "P1",   bitWidth: 1 } },
      { id: "p2",   type: "In",        props: { label: "P2",   bitWidth: 1 } },
      { id: "din",  type: "In",        props: { label: "DIN",  bitWidth: 1 } },
      { id: "tg",   type: "TransGate", props: { label: "tg" } },
      { id: "dout", type: "Out",       props: { label: "DOUT", bitWidth: 1 } },
    ],
    connections: [
      ["p1:out",  "tg:p1"],
      ["p2:out",  "tg:p2"],
      ["din:out", "tg:out1"],
      ["tg:out2", "dout:in"],
    ],
  });
}

// ===========================================================================
// Category 1 — Initialization (T1)
// ===========================================================================
//
// Post-warm-start observable: the engine has compiled the composite netlist
// (NFET drv+sw + PFET drv+sw) and applied initial node voltages. tg:out1 is
// driven by vs=1V; tg:out2 sits at the DCOP-converged divider value with
// both gates conducting (Ron=1, Rload=1k). Cat 1 asserts the seed voltage.

describe("TransGate initialization (T1)", () => {
  it("init_post_warm_start_node_voltage_pass_through_seed", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogTransGateCircuit(facade, {
        vs: 1, vp1: 1, vp2: 0, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    // tg:out1 is on the same net as vs:pos (driven by vs=1V at warm start).
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(1, 3);
    // tg:out2 is on the same net as rload:pos ≈ 1 * 1000/1001 ≈ 0.999V
    // (NFET+PFET both conducting through the composite). Seed value at step 0
    // is the DCOP-converged divider.
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"))).toBeCloseTo(1000 / 1001, 3);
  });
});

// ===========================================================================
// Category 2 — DCOP analytical (T1)
// ===========================================================================
//
// Closed-form: with both gates conducting, the path from vs to gnd is
//   vs --[Ron]--[Ron]-- out2 --[Rload]-- gnd  (the two SW paths in parallel
//   contribute 2x conductance, so effective on-resistance Ron_eff = Ron/2).
// For symmetric verification we keep the Cat 2 analytical assertion at the
// dominant divider: V(out2) ≈ vs * Rload / (Rload + Ron_eff) where Ron_eff
// ≤ Ron. Tolerance 3 places (≈1mV) covers the parallel-vs-single ambiguity.

describe("TransGate DCOP analytical (T1) — pass-through", () => {
  it("dcop_pass_through_v_out2_near_vs", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogTransGateCircuit(facade, {
        vs: 1, vp1: 1, vp2: 0, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    // tg:out1 is on the same net as vs:pos = 1V (driven by vs directly).
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(1, 6);

    // tg:out2 is on the same net as rload:pos; both gates conducting → near-vs.
    // Closed-form bound: V(out2) ∈ [vs*Rload/(Rload+Ron), vs] = [0.999, 1].
    const vOut2 = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    expect(vOut2).toBeGreaterThan(1000 / 1001 - 1e-3);
    expect(vOut2).toBeLessThanOrEqual(1);
    // And specifically within 1mV of the series-divider 0.999V.
    expect(vOut2).toBeCloseTo(1000 / 1001, 3);
  });
});

describe("TransGate DCOP analytical (T1) — isolation", () => {
  it("dcop_isolation_v_out2_near_zero_when_both_gates_off", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogTransGateCircuit(facade, {
        vs: 1, vp1: 0, vp2: 1, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    // tg:out1 is on the same net as vs:pos — still 1V (driven by vs).
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(1, 6);

    // tg:out2 is on the same net as rload:pos; both gates off.
    // TransGate has TWO parallel SW paths (NFET + PFET), each with Roff=1e9.
    // Parallel off-resistance = 1e9 / 2 = 5e8 Ω.
    // Closed-form: V(out2) = vs * Rload / (Roff_parallel + Rload)
    //            = 1 * 1000 / (5e8 + 1000) ≈ 2e-6 V (microvolts).
    const vOut2 = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    const roffParallel = 1e9 / 2;
    expect(vOut2).toBeCloseTo(1 * 1000 / (roffParallel + 1000), 5);
    expect(vOut2).toBeLessThan(1e-3);
  });
});

// ===========================================================================
// Category 4 — Parameter hot-load (T1)
// ===========================================================================
//
// TransGate exposes three model params: Ron, Roff, Vth. One it() per
// structural parameter; each asserts a closed-form post-change observable
// at the documented contract (no Number.isFinite weakening — B-8).

describe("TransGate parameter hot-load (T1) — Ron", () => {
  it("hotload_Ron_changes_v_out2_drop_under_load", () => {
    // Before: Ron=1, Rload=1k → V(out2) ≈ vs * 1000/1001 ≈ 0.999V.
    // After  setComponentProperty(tg, "Ron", 200):
    //   V(out2) ≈ vs * 1000 / (1000 + Ron_eff). With two parallel SW paths,
    //   Ron_eff ≤ 200; the conservative single-path bound is 1000/1200 ≈ 0.833V
    //   and the parallel bound is 1000/1100 ≈ 0.909V. Either way V(out2)
    //   drops measurably from the Ron=1 case.
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogTransGateCircuit(facade, {
        vs: 1, vp1: 1, vp2: 0, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    expect(before).toBeCloseTo(1000 / 1001, 3);

    fix.coordinator.setComponentProperty(fix.element("tg"), "Ron", 200);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));

    // Documented contract: raising Ron drops V(out2). Single-path bound
    // 1000/(1000+200) = 0.833V; parallel-path bound 1000/(1000+100) ≈ 0.909V.
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(1000 / 1200 - 1e-3);
    expect(after).toBeLessThanOrEqual(1000 / 1100 + 1e-3);
  });
});

describe("TransGate parameter hot-load (T1) — Roff", () => {
  it("hotload_Roff_lifts_v_out2_when_gates_off", () => {
    // Both gates OFF at start (vp1=0, vp2=1). Before: Roff=1e9 →
    //   V(out2) = vs * Rload / (Roff + Rload) ≈ 1 * 1000 / 1.001e9 ≈ 1e-6 V.
    // After Roff=10 (extreme drop, gates effectively pseudo-conducting):
    //   V(out2) = vs * Rload / (Roff + Rload) ≈ 1 * 1000 / 1010 ≈ 0.99V.
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogTransGateCircuit(facade, {
        vs: 1, vp1: 0, vp2: 1, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    expect(before).toBeLessThan(1e-3);

    fix.coordinator.setComponentProperty(fix.element("tg"), "Roff", 10);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));

    // Documented contract: lowering Roff lifts V(out2) when gates off.
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeGreaterThan(before);
    // Single-path bound: 1000/(10+1000)=0.990; parallel bound: 1000/(5+1000)=0.995.
    expect(after).toBeGreaterThanOrEqual(0.98);
  });
});

describe("TransGate parameter hot-load (T1) — Vth", () => {
  it("hotload_Vth_above_p1_drive_isolates_pass_through", () => {
    // Before: Vth=0.5, vp1=1V → NFET drv ON → pass-through; V(out2)≈0.999V.
    // After  Vth=2 (> vp1=1V): both gates off; V(out2) collapses toward 0.
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogTransGateCircuit(facade, {
        vs: 1, vp1: 1, vp2: 0, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    expect(before).toBeCloseTo(1000 / 1001, 3);

    fix.coordinator.setComponentProperty(fix.element("tg"), "Vth", 2);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));

    // Documented contract: raising Vth above the gate drive opens the gate.
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(1e-3);
  });
});

// ===========================================================================
// Category 9 — Bridge / digital interaction (T1)
// ===========================================================================
//
// TransGate exposes a digital execute path (executeTransGate) on its 1-bit
// p1, p2, out1, out2 schema when used in a purely digital netlist. Cat 9
// asserts that driving complementary p1/p2 propagates the data input on
// out1 to the data output on out2 within a single coordinator.step().

describe("TransGate digital bridge (T1) — Cat 9", () => {
  it("digital_p1_high_p2_low_passes_din_to_dout", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalTransGateCircuit(facade));
    coordinator.writeByLabel("P1",  digital(1));
    coordinator.writeByLabel("P2",  digital(0));
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 1 });

    coordinator.writeByLabel("DIN", digital(0));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });
  });
});

// ===========================================================================
// Category 12 — Forbidden / undefined input combinations (T1)
// ===========================================================================
//
// Documented forbidden states: p1 == p2 (both 0 or both 1) is invalid for a
// complementary-gate transmission gate. Production source comment:
//   "Closed when: S=1 AND ~S=0 (S != ~S and S is high). Open in all other
//    cases including when S == ~S (invalid state)."
// Spec mandate: when p1==p2, the gate is OPEN (DOUT = 0 / high-Z observable
// as 0 through the canonical Out sink).

describe("TransGate forbidden input combinations (T1) — Cat 12", () => {
  it("forbidden_p1_eq_p2_both_high_drives_dout_low", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalTransGateCircuit(facade));
    coordinator.writeByLabel("P1",  digital(1));
    coordinator.writeByLabel("P2",  digital(1));
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });
  });

  it("forbidden_p1_eq_p2_both_low_drives_dout_low", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalTransGateCircuit(facade));
    coordinator.writeByLabel("P1",  digital(0));
    coordinator.writeByLabel("P2",  digital(0));
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });
  });
});

// ===========================================================================
// Category 2 numerical / 3 / 5 — paired vs ngspice (T3)
// ===========================================================================
//
// Per Step 2c: harness RUN lives in the FIRST it() of each describe (the
// transient run); subsequent siblings read from the recorded session via
// session.getStepEnd / session.compareAllAttempts.

describeIfDll("TransGate paired vs ngspice — pass-through (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_PASS_THROUGH, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_pass_through", async () => {
    await session.runTransient(0, 2e-5, 1e-6);
    session.compareAllSteps();
  }, 180_000);

  it("dcop_paired_pass_through", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_pass_through", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("TransGate paired vs ngspice — isolation (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_ISOLATION, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_isolation", async () => {
    await session.runTransient(0, 2e-5, 1e-6);
    session.compareAllSteps();
  }, 180_000);

  it("dcop_paired_isolation", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_isolation", () => {
    session.compareAllAttempts();
  });
});
