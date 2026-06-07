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
// Two operating-region configurations, each carrying its own batch of T3
// canonical categories (Cat 2 numerical / Cat 3 transient / Cat 5 stamp):
//
//  - bright divider: lux=luxRef=1000 → R_LDR = rDark = 1k. With rSeries=1k
//    the divider sits at exactly half (V(L1:pos)=2.5V). Linear stamp regime.
//  - dim divider:    lux=100, luxRef=1000, gamma=0.7 → R_LDR = 1e6·10^0.7
//    ≈ 5.012e6. With rSeries=1MΩ the divider sits well above 50% — distinct
//    operating point exercising a different conductance scale.
const DTS_LDR_DIVIDER_BRIGHT = path.resolve(
  "src/components/sensors/__tests__/fixtures/ldr-canon-divider-bright.dts",
);
const DTS_LDR_DIVIDER_DIM = path.resolve(
  "src/components/sensors/__tests__/fixtures/ldr-canon-divider-dim.dts",
);

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1)
// ---------------------------------------------------------------------------
//
// VS → RS → ldr:pos ─ LDR ─ ldr:neg → GND. Closed-form divider:
//   V(ldr:pos) = VS · R_LDR / (RS + R_LDR)
// where R_LDR = rDark                                 (lux ≤ 0)
//       R_LDR = rDark · (lux / luxRef)^(-gamma)       (lux > 0).

interface DividerParams {
  vSource: number;
  rSeries: number;
  rDark: number;
  luxRef: number;
  gamma: number;
  lux: number;
}

function buildLdrDividerCircuit(facade: DefaultSimulatorFacade, p: DividerParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "VS", voltage: p.vSource } },
      { id: "rs",  type: "Resistor",        props: { label: "RS", resistance: p.rSeries } },
      { id: "ldr", type: "LDR",             props: {
          label:  "L1",
          rDark:  p.rDark,
          luxRef: p.luxRef,
          gamma:  p.gamma,
          lux:    p.lux,
      } },
      { id: "gnd", type: "Ground",          props: { label: "GND" } },
    ],
    connections: [
      ["vs:pos",  "rs:pos"],
      ["rs:neg",  "ldr:pos"],
      ["ldr:neg", "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

/** Closed-form LDR resistance: lux ≤ 0 → rDark; else rDark·(lux/luxRef)^(-gamma). */
function ldrResistance(rDark: number, luxRef: number, gamma: number, lux: number): number {
  if (lux <= 0) return rDark;
  return rDark * Math.pow(lux / luxRef, -gamma);
}

// ---------------------------------------------------------------------------
// LDR initialization (T1) — Cat 1
// ---------------------------------------------------------------------------
//
// LDRElement extends AnalogElement (no PoolBackedAnalogElement), so it has no
// state-pool slots — its only stamp-time state is the conductance G=1/R(lux)
// recomputed from `_p` each load(). The post-warm-start observable for Cat 1
// is therefore the converged node voltage at step 0, which the resistive
// divider produces deterministically from the closed-form law.

describe("LDR initialization (T1)", () => {
  it("init_post_warm_start_node_voltage_seeded_to_dcop_value", () => {
    // Bright regime: lux=luxRef → R_LDR = rDark = 1k. rSeries = 1k → V(ldr:pos) = 2.5V.
    const fix = buildFixture({
      build: (_r, facade) => buildLdrDividerCircuit(facade, {
        vSource: 5, rSeries: 1000, rDark: 1000, luxRef: 1000, gamma: 0.7, lux: 1000,
      }),
    });
    const expectedV = 5 * 1000 / (1000 + 1000); // 2.5V
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "L1:pos"))).toBeCloseTo(expectedV, 6);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "VS:pos"))).toBeCloseTo(5, 6);
  });
});

// ---------------------------------------------------------------------------
// LDR DCOP analytical (T1) — Cat 2 analytical
// ---------------------------------------------------------------------------

describe("LDR DCOP analytical (T1)", () => {
  it("dcop_divider_at_lux_equals_luxref_matches_closed_form", () => {
    // R_LDR(lux=luxRef) = rDark · 1^(-gamma) = rDark = 1k.
    // V(L1:pos) = VS · R_LDR / (RS + R_LDR) = 5 · 1000 / 2000 = 2.5V.
    const fix = buildFixture({
      build: (_r, facade) => buildLdrDividerCircuit(facade, {
        vSource: 5, rSeries: 1000, rDark: 1000, luxRef: 1000, gamma: 0.7, lux: 1000,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const R_LDR = ldrResistance(1000, 1000, 0.7, 1000);
    const expectedV = 5 * R_LDR / (1000 + R_LDR);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "L1:pos"))).toBeCloseTo(expectedV, 6);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "VS:pos"))).toBeCloseTo(5, 6);
  });

  it("dcop_divider_at_dim_lux_takes_power_law_branch", () => {
    // Dim regime: lux=100, luxRef=1000, gamma=0.7
    //   R_LDR = 1e6 · (100/1000)^(-0.7) = 1e6 · 10^0.7 ≈ 5.0119e6.
    // rSeries = 1MΩ → V(L1:pos) = 5 · R_LDR / (1e6 + R_LDR) ≈ 4.168V.
    const fix = buildFixture({
      build: (_r, facade) => buildLdrDividerCircuit(facade, {
        vSource: 5, rSeries: 1e6, rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 100,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const R_LDR = ldrResistance(1e6, 1000, 0.7, 100);
    const expectedV = 5 * R_LDR / (1e6 + R_LDR);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "L1:pos"))).toBeCloseTo(expectedV, 6);
  });

  it("dcop_divider_at_lux_zero_takes_dark_branch", () => {
    // lux=0 → R_LDR = rDark (the dark-branch carve-out, not the power law).
    const fix = buildFixture({
      build: (_r, facade) => buildLdrDividerCircuit(facade, {
        vSource: 5, rSeries: 1e6, rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 0,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const expectedV = 5 * 1e6 / (1e6 + 1e6); // 2.5V
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "L1:pos"))).toBeCloseTo(expectedV, 6);
  });
});

// ---------------------------------------------------------------------------
// LDR parameter hot-load (T1) — Cat 4
// ---------------------------------------------------------------------------
//
// LDR exposes four model params handed to setParam: rDark (primary structural
// scale), lux (primary slider-driven runtime), luxRef (secondary calibration),
// gamma (secondary power-law exponent). All four flow through the same
// `setParam(key, value)` recompute path inside load() (G = 1 / resistance()
// is recomputed every iteration from `_p`). One it() per documented param —
// each param's contract predicts a closed-form post-change V(L1:pos).

describe("LDR parameter hot-load (T1)", () => {
  it("hotload_lux_higher_lowers_v_ldr_pos_per_power_law", () => {
    // Start dim: lux=100, luxRef=1000, gamma=0.7 → R_LDR ≈ 5.012e6.
    // Bump lux up by 50× to 5000 → R_LDR = 1e6 · 5^(-0.7) ≈ 3.085e5.
    // RS=1MΩ → V(L1:pos) drops from ≈4.168V to ≈1.179V.
    const fix = buildFixture({
      build: (_r, facade) => buildLdrDividerCircuit(facade, {
        vSource: 5, rSeries: 1e6, rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 100,
      }),
    });
    const node = nodeOf(fix, "L1:pos");
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(node);
    const expectedBefore = 5 * ldrResistance(1e6, 1000, 0.7, 100)
                         / (1e6 + ldrResistance(1e6, 1000, 0.7, 100));
    expect(before).toBeCloseTo(expectedBefore, 6);

    fix.coordinator.setComponentProperty(fix.element("L1"), "lux", 5000);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(node);
    const expectedAfter = 5 * ldrResistance(1e6, 1000, 0.7, 5000)
                        / (1e6 + ldrResistance(1e6, 1000, 0.7, 5000));

    expect(after).not.toBeCloseTo(before, 4);
    expect(after).toBeCloseTo(expectedAfter, 6);
    expect(after).toBeLessThan(before);
  });

  it("hotload_lux_zero_returns_dark_branch_resistance", () => {
    // Start at lux=luxRef → R_LDR=rDark=1MΩ → V(L1:pos)=2.5V.
    // Hot-load lux=0 → dark branch R_LDR=rDark, divider unchanged at 2.5V,
    // but the path through resistance() takes the lux<=0 branch rather than
    // the power law. Verifying the post-change V matches the dark-branch
    // closed-form confirms the branch was taken (otherwise pow(0,-gamma)
    // would be Infinity and the divider would collapse to V≈VS).
    const fix = buildFixture({
      build: (_r, facade) => buildLdrDividerCircuit(facade, {
        vSource: 5, rSeries: 1e6, rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 1000,
      }),
    });
    fix.coordinator.setComponentProperty(fix.element("L1"), "lux", 0);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "L1:pos"));
    const expectedAfter = 5 * 1e6 / (1e6 + 1e6); // dark-branch divider
    expect(after).toBeCloseTo(expectedAfter, 6);
  });

  it("hotload_rDark_scales_resistance_and_shifts_v_ldr_pos", () => {
    // Start: rDark=1k, lux=luxRef → R_LDR=1k, RS=1k → V=2.5V.
    // Hot-load rDark=4k → R_LDR=4k → V = 5 · 4000/5000 = 4.0V.
    const fix = buildFixture({
      build: (_r, facade) => buildLdrDividerCircuit(facade, {
        vSource: 5, rSeries: 1000, rDark: 1000, luxRef: 1000, gamma: 0.7, lux: 1000,
      }),
    });
    const node = nodeOf(fix, "L1:pos");
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(node);
    expect(before).toBeCloseTo(2.5, 6);

    fix.coordinator.setComponentProperty(fix.element("L1"), "rDark", 4000);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(node);
    const expectedAfter = 5 * 4000 / (1000 + 4000); // 4.0V
    expect(after).not.toBeCloseTo(before, 4);
    expect(after).toBeCloseTo(expectedAfter, 6);
  });

  it("hotload_luxRef_recalibration_shifts_v_ldr_pos_via_power_law", () => {
    // Start dim: lux=100, luxRef=1000, gamma=0.7, rDark=1MΩ
    //   R_LDR = 1e6 · (100/1000)^(-0.7) ≈ 5.012e6.
    // Hot-load luxRef=100 (recalibrate so the current lux equals the new ref):
    //   R_LDR = 1e6 · (100/100)^(-0.7) = 1e6.
    // RS=1MΩ → V(L1:pos) drops from ≈4.168V to 2.5V.
    const fix = buildFixture({
      build: (_r, facade) => buildLdrDividerCircuit(facade, {
        vSource: 5, rSeries: 1e6, rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 100,
      }),
    });
    const node = nodeOf(fix, "L1:pos");
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(node);

    fix.coordinator.setComponentProperty(fix.element("L1"), "luxRef", 100);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(node);
    const expectedAfter = 5 * 1e6 / (1e6 + 1e6); // 2.5V
    expect(after).not.toBeCloseTo(before, 4);
    expect(after).toBeCloseTo(expectedAfter, 6);
  });

  it("hotload_gamma_steeper_response_changes_dim_resistance", () => {
    // Start dim: lux=100, luxRef=1000, gamma=0.7, rDark=1MΩ
    //   R_LDR = 1e6 · (0.1)^(-0.7) ≈ 5.012e6.
    // Hot-load gamma=1.4 (steeper) →
    //   R_LDR = 1e6 · (0.1)^(-1.4) ≈ 25.12e6.
    // RS=1MΩ → V(L1:pos) climbs from ≈4.168V to ≈4.808V.
    const fix = buildFixture({
      build: (_r, facade) => buildLdrDividerCircuit(facade, {
        vSource: 5, rSeries: 1e6, rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 100,
      }),
    });
    const node = nodeOf(fix, "L1:pos");
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(node);

    fix.coordinator.setComponentProperty(fix.element("L1"), "gamma", 1.4);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(node);
    const R_after = ldrResistance(1e6, 1000, 1.4, 100);
    const expectedAfter = 5 * R_after / (1e6 + R_after);
    expect(after).not.toBeCloseTo(before, 4);
    expect(after).toBeCloseTo(expectedAfter, 6);
    expect(after).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// LDR paired vs ngspice — bright divider (T3) — Cat 2 num / 3 / 5
// ---------------------------------------------------------------------------
//
// The harness RUN lives in the FIRST it() of the describe (transient run);
// subsequent siblings read from the recorded session.

describeIfDll("LDR paired vs ngspice — bright divider (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_LDR_DIVIDER_BRIGHT, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_bright_divider", async () => {
    await session.runTransient(0, 1e-3, 10e-6);
    session.compareAllSteps();
  }, 120_000);

  it("dcop_paired_bright_divider", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_bright_divider", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// LDR paired vs ngspice — dim divider (T3) — Cat 2 num / 3 / 5
// ---------------------------------------------------------------------------
//
// Second operating-region configuration: dim regime where R_LDR is several
// orders of magnitude larger than the bright divider. Without this, the
// bright .dts hides any conductance-scale-dependent drift in the LDR's stamp.

describeIfDll("LDR paired vs ngspice — dim divider (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_LDR_DIVIDER_DIM, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_dim_divider", async () => {
    await session.runTransient(0, 1e-3, 10e-6);
    session.compareAllSteps();
  }, 120_000);

  it("dcop_paired_dim_divider", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_dim_divider", () => {
    session.compareAllAttempts();
  });
});
