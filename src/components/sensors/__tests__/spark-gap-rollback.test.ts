import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { SPARK_GAP_SCHEMA } from "../spark-gap.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// .dts fixture paths (T3 harness).
// ---------------------------------------------------------------------------

// Blocking regime: VS=50V, RS=100, vBreakdown=1000V → V across gap < vBreakdown
// → CONDUCTING stays 0, R = rOff (1e10 Ω), divider holds V(sg:pos) ≈ VS.
const DTS_BLOCKING = path.resolve(
  "src/components/sensors/__tests__/fixtures/spark-gap-canon-blocking.dts",
);

// Conducting regime: VS=2000V, RS=100, vBreakdown=100V → fires at warm-start
// → CONDUCTING=1, R = rOn (5 Ω), divider drops V(sg:pos) to VS·rOn/(RS+rOn).
const DTS_CONDUCTING = path.resolve(
  "src/components/sensors/__tests__/fixtures/spark-gap-canon-conducting.dts",
);

// ---------------------------------------------------------------------------
// Programmatic build helper (T1).
// VS → RS → SG → GND topology. Defaults match the .dts fixtures' blocking
// regime; per-test overrides choose which regime the fixture exercises.
// ---------------------------------------------------------------------------

interface SparkGapParams {
  vSource:    number;
  rSeries?:   number;
  vBreakdown: number;
  rOn?:       number;
  rOff?:      number;
  iHold?:     number;
}

function buildSparkGapCircuit(facade: DefaultSimulatorFacade, p: SparkGapParams): Circuit {
  return facade.build({
    components: [
      { id: "vs", type: "DcVoltageSource", props: { label: "vs", voltage: p.vSource } },
      { id: "rs", type: "Resistor",       props: { label: "rs", resistance: p.rSeries ?? 100 } },
      { id: "sg", type: "SparkGap",       props: {
          label:      "sg",
          model:      "behavioral",
          vBreakdown: p.vBreakdown,
          rOn:        p.rOn  ?? 5,
          rOff:       p.rOff ?? 1e10,
          iHold:      p.iHold ?? 0.01,
      } },
      { id: "gnd", type: "Ground", props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos", "rs:pos"],
      ["rs:neg", "sg:pos"],
      ["sg:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

function findSparkGapIndex(fix: ReturnType<typeof buildFixture>): number {
  for (const [idx, label] of fix.elementLabels.entries()) {
    if (label === "sg") return idx;
  }
  throw new Error("SparkGap element with label 'sg' not found");
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Asserts the warm-started state pool slot reads the canonical CONDUCTING
// value for the regime, plus the post-warm-start node voltage at sg:pos
// matches the corresponding closed-form divider value.
// ---------------------------------------------------------------------------

describe("SparkGap initialization (T1)", () => {
  const SLOT_CONDUCTING = SPARK_GAP_SCHEMA.indexOf.get("CONDUCTING")!;

  it("init_blocking_pool_conducting_slot_zero", () => {
    // VS=50V < vBreakdown=1000V: gap remains in blocking state, slot=0.
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: 50, rSeries: 100, vBreakdown: 1000,
      }),
    });
    const sgIdx = findSparkGapIndex(fix);
    const sg = fix.circuit.elements[sgIdx]!;
    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(0);
    // V(sg:pos) ≈ VS via rOff-dominated divider.
    const vPos = fix.engine.getNodeVoltage(nodeOf(fix, "sg:pos"));
    expect(vPos).toBeCloseTo(50, 4);
  });

  it("init_conducting_pool_conducting_slot_one", () => {
    // VS=2000V > vBreakdown=100V: gap fires during DCOP warm-start, slot=1.
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: 2000, rSeries: 100, vBreakdown: 100,
      }),
    });
    const sgIdx = findSparkGapIndex(fix);
    const sg = fix.circuit.elements[sgIdx]!;
    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(1);
    // V(sg:pos) ≈ VS·rOn/(RS+rOn) via rOn-dominated divider.
    const vPos = fix.engine.getNodeVoltage(nodeOf(fix, "sg:pos"));
    const expected = 2000 * 5 / (100 + 5);
    expect(vPos).toBeCloseTo(expected, 1);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical)
// Closed-form bound on V(sg:pos) and pin currents for both regimes.
// ---------------------------------------------------------------------------

describe("SparkGap DCOP analytical (T1)", () => {
  it("dcop_blocking_divider_at_source", () => {
    // Closed-form: V(sg:pos) = VS · rOff/(RS+rOff). With rOff=1e10, RS=100,
    // VS=50 → V(sg:pos) = 50 · 1e10/(100+1e10) ≈ 50 to 1 part in 1e8.
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: 50, rSeries: 100, vBreakdown: 1000,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vPos = fix.engine.getNodeVoltage(nodeOf(fix, "sg:pos"));
    expect(vPos).toBeCloseTo(50 * 1e10 / (100 + 1e10), 5);
  });

  it("dcop_conducting_divider_drops_below_source", () => {
    // Closed-form: V(sg:pos) = VS · rOn/(RS+rOn) = 2000·5/105 ≈ 95.238 V.
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: 2000, rSeries: 100, vBreakdown: 100,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vPos = fix.engine.getNodeVoltage(nodeOf(fix, "sg:pos"));
    const expected = 2000 * 5 / (100 + 5);
    expect(vPos).toBeCloseTo(expected, 0);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// One it() per primary structural parameter on the spark gap:
//   - vBreakdown: structural threshold; lowering it below VS fires the gap.
//   - rOn: conducting-state resistance; changes the conducting-divider.
//   - rOff: blocking-state resistance; changes the blocking-divider current.
//   - iHold: extinction current threshold; raising above I extinguishes.
// No TEMP-style derived-state-recompute parameter exists on this device.
// ---------------------------------------------------------------------------

describe("SparkGap parameter hot-load (T1)", () => {
  const SLOT_CONDUCTING = SPARK_GAP_SCHEMA.indexOf.get("CONDUCTING")!;

  it("hotload_vBreakdown_lower_below_source_fires_gap", () => {
    // Pre: VS=500V, vBreakdown=1000V → blocking, CONDUCTING=0.
    // Post: vBreakdown=200V → VS=500 > 200 → fires, CONDUCTING=1.
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: 500, rSeries: 100, vBreakdown: 1000,
      }),
    });
    const sgIdx = findSparkGapIndex(fix);
    const sg = fix.circuit.elements[sgIdx]!;
    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(0);

    fix.coordinator.setComponentProperty(fix.element("sg"), "vBreakdown", 200);
    for (let i = 0; i < 20; i++) fix.coordinator.step();

    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(1);
  });

  it("hotload_rOn_changes_conducting_divider_voltage", () => {
    // Pre: VS=2000V, rOn=5, RS=100 → V(sg:pos) ≈ 2000·5/105 ≈ 95.24 V.
    // Post: rOn=50 → V(sg:pos) ≈ 2000·50/150 ≈ 666.67 V.
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: 2000, rSeries: 100, vBreakdown: 100,
      }),
    });
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "sg:pos"));
    fix.coordinator.setComponentProperty(fix.element("sg"), "rOn", 50);
    for (let i = 0; i < 20; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "sg:pos"));
    const expectedAfter = 2000 * 50 / (100 + 50);
    expect(after).not.toBeCloseTo(before, 1);
    expect(after).toBeCloseTo(expectedAfter, 0);
  });

  it("hotload_rOff_changes_blocking_node_voltage", () => {
    // Pre: blocking with rOff=1e10 → V(sg:pos) ≈ VS to 1 part in 1e8.
    // Post: rOff=1000 → divider becomes VS · 1000/(100+1000) = VS·1000/1100.
    // For VS=50, expected after ≈ 45.45 V — measurably different from 50.
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: 50, rSeries: 100, vBreakdown: 1000,
      }),
    });
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "sg:pos"));
    fix.coordinator.setComponentProperty(fix.element("sg"), "rOff", 1000);
    for (let i = 0; i < 20; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "sg:pos"));
    const expectedAfter = 50 * 1000 / (100 + 1000);
    expect(after).not.toBeCloseTo(before, 1);
    expect(after).toBeCloseTo(expectedAfter, 0);
  });

  it("hotload_iHold_above_steady_current_extinguishes_gap", () => {
    // Fire at VS=2000 (> vBreakdown=100), then drop the source BELOW breakdown so
    // the gap stays lit by hysteresis but extinction is stable. A discrete latched
    // gap cannot stably extinguish while a source above vBreakdown is applied — it
    // re-strikes (continuous arc) — so the extinction scenario lowers the source
    // first, mirroring spark-gap.test.ts hotload_iHold_raise_above_steady_current.
    const fix = buildFixture({
      build: (_r, facade) => buildSparkGapCircuit(facade, {
        vSource: 2000, rSeries: 100, vBreakdown: 100, rOn: 5, iHold: 0.01,
      }),
    });
    const sgIdx = findSparkGapIndex(fix);
    const sg = fix.circuit.elements[sgIdx]!;
    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(1);

    // Drop VS to 10 V (< vBreakdown=100); gap stays conducting by hysteresis
    // (I = 10/(100+5) ≈ 0.095 A > iHold 0.01).
    fix.coordinator.setSourceByLabel("vs", "voltage", 10);
    for (let i = 0; i < 20; i++) fix.coordinator.step();
    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(1);

    // Raise iHold above the steady current → stable extinction (source < breakdown).
    fix.coordinator.setComponentProperty(fix.element("sg"), "iHold", 100);
    for (let i = 0; i < 20; i++) fix.coordinator.step();

    expect(fix.pool.state1[sg._stateBase + SLOT_CONDUCTING]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 — Harness paired vs ngspice (T3).
// One describe()/session per .dts. Session opens in beforeAll, runs inside
// the FIRST it() (so a hard throw shows as a failed test), reuses across
// siblings, disposes in afterAll.
// ---------------------------------------------------------------------------

describeIfDll("SparkGap blocking-regime paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_BLOCKING, analysis: "tran", tStop: 1e-4, maxStep: 1e-6 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_blocking", async () => {
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  }, 120_000);

  it("dcop_paired_blocking", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const comp of Object.values(stepEnd.components)) {
      for (const cv of Object.values(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("full_iteration_paired_blocking", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("SparkGap conducting-regime paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_CONDUCTING, analysis: "tran", tStop: 1e-4, maxStep: 1e-6 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_conducting", async () => {
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  }, 120_000);

  it("dcop_paired_conducting", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const comp of Object.values(stepEnd.components)) {
      for (const cv of Object.values(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("full_iteration_paired_conducting", () => {
    session.compareAllAttempts();
  });
});
