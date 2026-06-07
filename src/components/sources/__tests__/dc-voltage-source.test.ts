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
// DTS fixture paths (T3 harness)
// ---------------------------------------------------------------------------
//
// Two operating-region configurations are required (Step 1: harness file, no
// topology variants — the DcVoltageSource has a single behavioural model and
// no n-type/p-type or push-pull/open-collector variants). The first regime is
// a low-magnitude (5V) source driving a resistive divider; the second is a
// higher-magnitude (12V) source driving a smaller load. The two operating
// points exercise the branch-row stamp and the srcFact ramp at distinct
// scales so per-step / per-iteration sweeps catch any drift in the source's
// stamp under different solve magnitudes.

// Reused (no edits): existing parity fixture — 5V source + R1=1k + R2=1k.
const DTS_RESISTIVE_DIVIDER = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/resistive-divider.dts",
);

// 12V source + RL=470Ω to ground.
const DTS_DCVS_12V_LOAD = path.resolve(
  "src/components/sources/__tests__/fixtures/dc-voltage-source-canon-12v-load.dts",
);

// ---------------------------------------------------------------------------
// Programmatic circuit factory (T1)
// ---------------------------------------------------------------------------
//
// VS:pos -> RL:pos, RL:neg -> gnd, VS:neg -> gnd. Steady-state DC:
//   V(VS:pos) = voltage  (held by the source's branch-row constraint)
// RL provides a return path so the MNA matrix is well-posed.

interface VsrcCircuitParams {
  voltage: number;
  resistance?: number;
}

function buildVsrcCircuit(facade: DefaultSimulatorFacade, p: VsrcCircuitParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "vs", voltage: p.voltage } },
      { id: "rl",  type: "Resistor",        props: { label: "rl", resistance: p.resistance ?? 1000 } },
      { id: "gnd", type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos", "rl:pos"],
      ["rl:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ---------------------------------------------------------------------------
// DcVoltageSource initialization (T1) — Cat 1
// ---------------------------------------------------------------------------
//
// DcVoltageSourceAnalogElement extends AnalogElement (no state-pool slots) —
// its only stamp-time state is the cached `_voltage` set at construct /
// setParam time. The post-warm-start observable for Cat 1 is therefore the
// converged node voltage at step 0: VS:pos sits at exactly the programmed
// source voltage, held by the branch-row constraint.

describe("DcVoltageSource initialization (T1)", () => {
  it("init_post_warm_start_pos_node_held_at_source_voltage", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildVsrcCircuit(facade, { voltage: 5, resistance: 1000 }),
    });
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(5.0, 9);
  });
});

// ---------------------------------------------------------------------------
// DcVoltageSource DCOP analytical (T1) — Cat 2 analytical
// ---------------------------------------------------------------------------

describe("DcVoltageSource DCOP analytical (T1)", () => {
  it("dcop_pos_node_equals_source_voltage_5v", () => {
    // Closed-form: V(VS:pos) = 5.0 exactly. Loop current magnitude is V/R.
    // The two pin currents obey KCL (sum to zero) by the source's branch-row
    // constraint, with magnitude V/R; the sign convention of which pin
    // reports +I vs -I is a solver-internal convention, so the canonical
    // closed-form assertion is on |I| and KCL closure (pin currents sum to 0).
    const fix = buildFixture({
      build: (_r, facade) => buildVsrcCircuit(facade, { voltage: 5, resistance: 1000 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(5.0, 9);

    const vsIdx = fix.elementIndex("vs");
    const vsPins = fix.engine.getElementPinCurrents(vsIdx);
    const Imag = 5.0 / 1000;
    expect(Math.abs(vsPins[0])).toBeCloseTo(Imag, 9);
    expect(Math.abs(vsPins[1])).toBeCloseTo(Imag, 9);
    expect(vsPins[0] + vsPins[1]).toBeCloseTo(0, 9);
  });

  it("dcop_pos_node_equals_source_voltage_12v_smaller_load", () => {
    // Closed-form: V(VS:pos) = 12.0 exactly with a 470Ω return path.
    // |I| = 12/470 ≈ 0.02553 A; pin currents sum to zero (KCL).
    const fix = buildFixture({
      build: (_r, facade) => buildVsrcCircuit(facade, { voltage: 12, resistance: 470 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(12.0, 9);

    const vsIdx = fix.elementIndex("vs");
    const vsPins = fix.engine.getElementPinCurrents(vsIdx);
    const Imag = 12.0 / 470;
    expect(Math.abs(vsPins[0])).toBeCloseTo(Imag, 9);
    expect(Math.abs(vsPins[1])).toBeCloseTo(Imag, 9);
    expect(vsPins[0] + vsPins[1]).toBeCloseTo(0, 9);
  });
});

// ---------------------------------------------------------------------------
// DcVoltageSource parameter hot-load (T1) — Cat 4
// ---------------------------------------------------------------------------
//
// DcVoltageSource params: `voltage` (primary, only). No TEMP / AREA / SCALE /
// derived-state-recompute parameters — `setParam("voltage", v)` directly
// updates the cached `_voltage` field consumed at the next load(). One it()
// covers the only param.

describe("DcVoltageSource parameter hot-load (T1)", () => {
  it("hotload_voltage_changes_pos_node", () => {
    // Cat 4: VS=5V, RL=1k → V(VS:pos)=5V before. Hot-load voltage=10V →
    // V(VS:pos)=10V after. Closed-form post-change observable.
    const fix = buildFixture({
      build: (_r, facade) => buildVsrcCircuit(facade, { voltage: 5, resistance: 1000 }),
    });
    const posNode = nodeOf(fix, "vs:pos");
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(posNode);
    expect(before).toBeCloseTo(5.0, 9);

    const vsEl = fix.element("vs");
    fix.coordinator.setComponentProperty(vsEl, "voltage", 10);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(posNode);

    expect(after).not.toBeCloseTo(before, 4);
    expect(after).toBeCloseTo(10.0, 9);
  });
});

// ---------------------------------------------------------------------------
// DcVoltageSource paired vs ngspice — resistive divider (T3) — Cat 2 num / 3 / 5
// ---------------------------------------------------------------------------
//
// Per Step 2c: the harness RUN lives in the FIRST it() of the describe
// (transient run); subsequent siblings read from the recorded session.

describeIfDll("DcVoltageSource paired vs ngspice — 5V resistive divider (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_RESISTIVE_DIVIDER, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_resistive_divider", async () => {
    await session.runTransient(0, 1e-3, 10e-6);
    session.compareAllSteps();
  }, 120_000);

  it("dcop_paired_resistive_divider", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_resistive_divider", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// DcVoltageSource paired vs ngspice — 12V/470Ω load (T3) — Cat 2 num / 3 / 5
// ---------------------------------------------------------------------------
//
// Second operating-region configuration: a higher-magnitude source driving a
// smaller load. Without this, the divider .dts (low-magnitude single-regime)
// hides any per-step drift in the source's branch-row stamp / srcFact ramp
// at different solve scales.

describeIfDll("DcVoltageSource paired vs ngspice — 12V load (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_DCVS_12V_LOAD, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_12v_load", async () => {
    await session.runTransient(0, 1e-3, 10e-6);
    session.compareAllSteps();
  }, 120_000);

  it("dcop_paired_12v_load", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_12v_load", () => {
    session.compareAllAttempts();
  });
});
