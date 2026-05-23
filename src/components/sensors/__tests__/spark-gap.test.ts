import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { SparkGapElement, SPARK_GAP_SCHEMA } from "../spark-gap.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// .dts paths (T3 harness fixtures)
// ---------------------------------------------------------------------------

const DTS_BLOCKING   = path.resolve("src/components/sensors/__tests__/fixtures/spark-gap-canon-blocking.dts");
const DTS_CONDUCTING = path.resolve("src/components/sensors/__tests__/fixtures/spark-gap-canon-conducting.dts");

// ---------------------------------------------------------------------------
// State-pool slot indices (resolved via schema lookup)
// ---------------------------------------------------------------------------

const SLOT_CONDUCTING = SPARK_GAP_SCHEMA.indexOf.get("CONDUCTING")!;

// ---------------------------------------------------------------------------
// Programmatic circuit factory (T1)
//
// vs -> rs -> sg(SparkGap) -> GND. Sized so:
//   rs = 100 Ohm  is small vs rOff (1e10 Ohm) -> blocking divider holds V(sg:pos) ~= Vsrc
//   rs >> rOn (5 Ohm)                          -> conducting divider drops V(sg:pos) << Vsrc
//   With rOn=5, iHold=0.01: holding-current threshold for Vsrc is
//   iHold*(rs+rOn) = 0.01*105 = 1.05 V.
// ---------------------------------------------------------------------------

interface SparkGapCircuitParams {
  vSource:    number;
  rSeries?:   number;
  vBreakdown?: number;
  rOn?:       number;
  rOff?:      number;
  iHold?:     number;
}

function buildSparkGapCircuit(facade: DefaultSimulatorFacade, p: SparkGapCircuitParams): Circuit {
  return facade.build({
    components: [
      { id: "vs", type: "DcVoltageSource", props: { label: "vs", voltage: p.vSource } },
      { id: "rs", type: "Resistor",        props: { label: "rs", resistance: p.rSeries ?? 100 } },
      { id: "sg", type: "SparkGap",        props: {
          label:      "sg",
          model:      "behavioral",
          vBreakdown: p.vBreakdown ?? 1000,
          rOn:        p.rOn        ?? 5,
          rOff:       p.rOff       ?? 1e10,
          iHold:      p.iHold      ?? 0.01,
      } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos",  "rs:pos"],
      ["rs:neg",  "sg:pos"],
      ["sg:neg",  "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });
}

function findSparkGap(elements: ReadonlyArray<unknown>): SparkGapElement {
  const idx = elements.findIndex((el) => el instanceof SparkGapElement);
  if (idx < 0) throw new Error("SparkGapElement not found in compiled circuit");
  return elements[idx] as SparkGapElement;
}

// ---------------------------------------------------------------------------
// Category 1 - Initialization (T1)
//
// Post-warm-start: state pool slot CONDUCTING and node voltages are produced
// by setup() + the boot transient step. Two regimes:
//   - blocking (Vsrc < vBreakdown): CONDUCTING == 0, V(sg:pos) ~= Vsrc
//   - conducting (Vsrc > vBreakdown): the gap fires during DCOP. The bottom
//     of load() commits the new flag to s0, _seedFromDcop copies s0 -> s1,
//     so post-warm-start s1[CONDUCTING] == 1 and V(sg:pos) ~= Vsrc*rOn/(rs+rOn).
// ---------------------------------------------------------------------------

describe("SparkGap initialization (T1)", () => {
  it("init_blocking_state_zero_and_node_tracks_source", () => {
    const Vsrc = 500;
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: Vsrc, vBreakdown: 1000, rOn: 5, rOff: 1e10,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-4 },
    });
    const sg = findSparkGap(fix.circuit.elements);
    // Blocking regime: rOff dominates; divider holds V(sg:pos) ~= Vsrc.
    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(0);
    const vPos = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("sg:pos")!);
    expect(Math.abs(vPos - Vsrc) / Vsrc).toBeLessThan(1e-6);
  });

  it("init_firing_state_one_and_node_drops_to_conducting_divider", () => {
    const Vsrc = 1500;
    const rs   = 100;
    const rOn  = 5;
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: Vsrc, rSeries: rs, vBreakdown: 1000, rOn, rOff: 1e10,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-4 },
    });
    const sg = findSparkGap(fix.circuit.elements);
    // Conducting regime: gap fired during boot DCOP.
    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(1);
    // Closed form: V(sg:pos) = Vsrc * rOn / (rs + rOn) = 1500*5/105 ~ 71.43 V.
    const vPos = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("sg:pos")!);
    const expected = Vsrc * rOn / (rs + rOn);
    expect(Math.abs(vPos - expected) / expected).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// Category 2 - DC operating point (T1, analytical)
//
// Two operating regions: sub-vBreakdown (blocking divider) and post-vBreakdown
// (conducting divider). Both have closed-form analytical voltages.
// ---------------------------------------------------------------------------

describe("SparkGap DCOP - blocking + conducting (T1, analytical)", () => {
  it("dcop_blocking_node_tracks_source", () => {
    const Vsrc = 500;
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: Vsrc, rSeries: 100, vBreakdown: 1000, rOn: 5, rOff: 1e10,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-4 },
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // Closed form: V(sg:pos) = Vsrc * rOff / (rs + rOff) ~= Vsrc within 1e-6.
    const vPos = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("sg:pos")!);
    expect(Math.abs(vPos - Vsrc) / Vsrc).toBeLessThan(1e-6);
  });

  it("dcop_conducting_node_drops_to_rOn_divider", () => {
    const Vsrc = 1500;
    const rs   = 100;
    const rOn  = 5;
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: Vsrc, rSeries: rs, vBreakdown: 1000, rOn, rOff: 1e10,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-4 },
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    // Closed form: V(sg:pos) = Vsrc * rOn / (rs + rOn) = 1500*5/105 ~ 71.43 V.
    const vPos = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("sg:pos")!);
    const expected = Vsrc * rOn / (rs + rOn);
    expect(Math.abs(vPos - expected) / expected).toBeLessThan(0.01);
  });

  it("dcop_current_in_conducting_far_exceeds_blocking", () => {
    // I = (Vsrc - V(sg:pos)) / rs. Blocking: V(sg:pos) ~= Vsrc -> I ~= 0.
    // Conducting: V(sg:pos) ~= Vsrc*rOn/(rs+rOn) -> I ~= Vsrc/(rs+rOn).
    const rs = 100;
    const fixBlock = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: 500, rSeries: rs, vBreakdown: 1000, rOn: 5, rOff: 1e10,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-4 },
    });
    const I_block = (500 - fixBlock.engine.getNodeVoltage(fixBlock.circuit.labelToNodeId.get("sg:pos")!)) / rs;

    const fixConduct = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: 1500, rSeries: rs, vBreakdown: 1000, rOn: 5, rOff: 1e10,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-4 },
    });
    const I_conduct = (1500 - fixConduct.engine.getNodeVoltage(fixConduct.circuit.labelToNodeId.get("sg:pos")!)) / rs;

    expect(I_conduct).toBeGreaterThan(Math.abs(I_block) * 1000);
  });
});

// ---------------------------------------------------------------------------
// Category 4 - Parameter hot-load (T1)
//
// Each model parameter (vBreakdown, rOn, rOff, iHold) must be reachable via
// setComponentProperty and must produce the documented post-change observable.
// ---------------------------------------------------------------------------

describe("SparkGap parameter hot-load (T1)", () => {
  it("hotload_vBreakdown_drop_below_vsrc_fires_blocking_gap", () => {
    // Vsrc=500, vBreakdown=1000 -> blocking at boot.
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: 500, vBreakdown: 1000, rOn: 5, rOff: 1e10, iHold: 0.01,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-4 },
    });
    const sg = findSparkGap(fix.circuit.elements);
    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(0);

    // Drop vBreakdown to 200 V -> Vsrc=500 > vBreakdown -> gap should fire.
    const sgIdx = fix.circuit.elements.indexOf(sg);
    const sgCe = fix.circuit.elementToCircuitElement.get(sgIdx)!;
    fix.coordinator.setComponentProperty(sgCe, "vBreakdown", 200);
    for (let i = 0; i < 20; i++) fix.coordinator.step();

    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(1);
  });

  it("hotload_rOn_increase_shifts_conducting_node_voltage", () => {
    const Vsrc = 1500;
    const rs   = 100;
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: Vsrc, rSeries: rs, vBreakdown: 1000, rOn: 5, rOff: 1e10,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-4 },
    });
    const sg = findSparkGap(fix.circuit.elements);
    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(1);
    const vBefore = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("sg:pos")!);

    // Hot-patch rOn from 5 to 50: divider shifts from Vsrc*5/105 to Vsrc*50/150.
    const sgIdx = fix.circuit.elements.indexOf(sg);
    const sgCe = fix.circuit.elementToCircuitElement.get(sgIdx)!;
    fix.coordinator.setComponentProperty(sgCe, "rOn", 50);
    for (let i = 0; i < 20; i++) fix.coordinator.step();

    const vAfter = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("sg:pos")!);
    const expectedAfter = Vsrc * 50 / (rs + 50);
    expect(Math.abs(vAfter - expectedAfter) / expectedAfter).toBeLessThan(0.05);
    expect(vAfter).toBeGreaterThan(vBefore * 2);
  });

  it("hotload_rOff_increase_holds_blocking_divider_at_source", () => {
    // Blocking regime; raise rOff; V(sg:pos) must stay ~= Vsrc and not lower.
    const Vsrc = 500;
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: Vsrc, rSeries: 100, vBreakdown: 1000, rOn: 5, rOff: 1e9, iHold: 0.01,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-4 },
    });
    const sg = findSparkGap(fix.circuit.elements);
    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(0);
    const vBefore = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("sg:pos")!);

    // Hot-patch rOff from 1e9 -> 1e11. Closed form: Vsrc*rOff/(rs+rOff) ~ Vsrc.
    const sgIdx = fix.circuit.elements.indexOf(sg);
    const sgCe = fix.circuit.elementToCircuitElement.get(sgIdx)!;
    fix.coordinator.setComponentProperty(sgCe, "rOff", 1e11);
    for (let i = 0; i < 20; i++) fix.coordinator.step();

    const vAfter = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("sg:pos")!);
    // Both before and after must track Vsrc within 1e-6 (rOff dominates either way);
    // and rOff increase must move V(sg:pos) closer to Vsrc, never away.
    expect(Math.abs(vAfter - Vsrc) / Vsrc).toBeLessThan(1e-6);
    expect(Math.abs(vAfter - Vsrc)).toBeLessThanOrEqual(Math.abs(vBefore - Vsrc));
    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(0);
  });

  it("hotload_iHold_raise_above_steady_current_extinguishes_gap", () => {
    // Fire the gap, then raise iHold above the steady-state holding current
    // I_steady = Vsrc/(rs+rOn). At Vsrc=10, rs=100, rOn=5 -> I_steady ~ 0.0952 A.
    // Raising iHold to 0.5 A puts I_steady < iHold -> extinction transition.
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: 1500, rSeries: 100, vBreakdown: 1000, rOn: 5, rOff: 1e10, iHold: 0.01,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-4 },
    });
    const sg = findSparkGap(fix.circuit.elements);
    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(1);

    // Drop Vsrc to 10 V (still I > 0.01 -> gap stays conducting).
    fix.coordinator.setSourceByLabel("vs", "voltage", 10);
    for (let i = 0; i < 20; i++) fix.coordinator.step();
    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(1);

    // Raise iHold above the steady-state current -> gap must extinguish.
    const sgIdx = fix.circuit.elements.indexOf(sg);
    const sgCe = fix.circuit.elementToCircuitElement.get(sgIdx)!;
    fix.coordinator.setComponentProperty(sgCe, "iHold", 0.5);
    for (let i = 0; i < 20; i++) fix.coordinator.step();

    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 - Paired vs ngspice (T3) on blocking regime
// One ComparisonSession per .dts; the run lives in the first it(), siblings
// read the recorded session.
// ---------------------------------------------------------------------------

describeIfDll("SparkGap blocking vs ngspice - transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_BLOCKING, analysis: "tran", tStop: 1e-5, maxStep: 1e-7 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_blocking", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_blocking", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_blocking", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 - Paired vs ngspice (T3) on conducting regime
// ---------------------------------------------------------------------------

describeIfDll("SparkGap conducting vs ngspice - transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_CONDUCTING, analysis: "tran", tStop: 1e-5, maxStep: 1e-7 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_conducting", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_conducting", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_conducting", () => {
    session.compareAllAttempts();
  });
});
