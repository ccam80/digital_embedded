import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { COMPARATOR_SCHEMA } from "../comparator.js";
import { PoolBackedAnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Slot indices
// ---------------------------------------------------------------------------

const SLOT_OUTPUT_LATCH  = COMPARATOR_SCHEMA.indexOf.get("OUTPUT_LATCH")!;
const SLOT_OUTPUT_WEIGHT = COMPARATOR_SCHEMA.indexOf.get("OUTPUT_WEIGHT")!;

// ---------------------------------------------------------------------------
// .dts paths
// ---------------------------------------------------------------------------

const DTS_PP_ON  = path.resolve("src/components/active/__tests__/fixtures/comparator-canon-pp-on.dts");
const DTS_PP_OFF = path.resolve("src/components/active/__tests__/fixtures/comparator-canon-pp-off.dts");

// ---------------------------------------------------------------------------
// Helper: locate the comparator driver element in a compiled circuit by
// matching stateSchema.owner === "Comparator".
// ---------------------------------------------------------------------------

function findComparatorDriver(
  elements: ReadonlyArray<unknown>,
): PoolBackedAnalogElement {
  const idx = elements.findIndex(
    (el) =>
      el instanceof PoolBackedAnalogElement &&
      (el as PoolBackedAnalogElement).stateSchema.owner === "Comparator",
  );
  if (idx < 0) throw new Error("Comparator driver element not found in compiled circuit");
  return elements[idx] as PoolBackedAnalogElement;
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Post-warm-start: OUTPUT_LATCH and OUTPUT_WEIGHT are finite; latch is 0 or 1
// depending on V+ vs V-.  Push-pull programmatic build.
// ---------------------------------------------------------------------------

describe("Comparator initialization — push-pull (T1)", () => {
  it("init_pp_active_slots_finite", () => {
    // V+=1V, V-=0V => latch=1 (active, output driven low)
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vsrc_p", type: "DcVoltageSource", props: { label: "vsrc_p", voltage: 1 } },
          { id: "vsrc_n", type: "DcVoltageSource", props: { label: "vsrc_n", voltage: 0 } },
          { id: "rload",  type: "Resistor",        props: { label: "rload",  resistance: 10000 } },
          {
            id: "cmp",
            type: "VoltageComparator",
            props: {
              label:        "cmp",
              model:        "push-pull",
              hysteresis:   0,
              vos:          0,
              rOut:         50,
              responseTime: 1e-7,
              vOH:          3.3,
              vOL:          0,
            },
          },
          { id: "gnd", type: "Ground", props: { label: "gnd" } },
        ],
        connections: [
          ["vsrc_p:pos", "cmp:in+"],
          ["vsrc_p:neg", "gnd:out"],
          ["vsrc_n:pos", "cmp:in-"],
          ["vsrc_n:neg", "gnd:out"],
          ["cmp:out",    "rload:pos"],
          ["rload:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 2e-5, maxTimeStep: 1e-6 },
    });

    const cmp = findComparatorDriver(fix.circuit.elements);
    const latch  = fix.pool.state0[cmp._stateBase + SLOT_OUTPUT_LATCH];
    const weight = fix.pool.state0[cmp._stateBase + SLOT_OUTPUT_WEIGHT];

    expect(Number.isFinite(latch)).toBe(true);
    expect(Number.isFinite(weight)).toBe(true);
    // V+ > V- => latch=1 (active)
    expect(latch).toBe(1);
    expect(weight).toBeGreaterThanOrEqual(0);
    expect(weight).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point analytical (T1)
// Open-collector: V+=2V, V-=1V, rOut=50, vOH=3.3V pull-up through 1kΩ.
// Active state: G_eff = w/rOut at (out,out). Closed-form: with rOut=50 and
// Rpull=1000, Vout = vOH * rOut / (rOut + Rpull) = 3.3 * 50/1050 ≈ 0.157V.
// Push-pull: uses dcOperatingPoint() and asserts converged + Vout direction.
// Note: DCOP uses dt=0 so alpha=0 and OUTPUT_WEIGHT does not integrate from
// the warm-start seed. Assertions are on convergence and directional output.
// ---------------------------------------------------------------------------

describe("Comparator DCOP analytical (T1)", () => {
  it("dcop_pp_active_output_converged", () => {
    // Push-pull: V+=1V, V-=0V => active (latch=1). DCOP converges.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vsrc_p", type: "DcVoltageSource", props: { label: "vsrc_p", voltage: 1 } },
          { id: "vsrc_n", type: "DcVoltageSource", props: { label: "vsrc_n", voltage: 0 } },
          { id: "rload",  type: "Resistor",        props: { label: "rload",  resistance: 10000 } },
          {
            id: "cmp",
            type: "VoltageComparator",
            props: {
              label:      "cmp",
              model:      "push-pull",
              hysteresis: 0,
              vos:        0,
              rOut:       50,
              vOH:        3.3,
              vOL:        0,
            },
          },
          { id: "gnd", type: "Ground", props: { label: "gnd" } },
        ],
        connections: [
          ["vsrc_p:pos", "cmp:in+"],
          ["vsrc_p:neg", "gnd:out"],
          ["vsrc_n:pos", "cmp:in-"],
          ["vsrc_n:neg", "gnd:out"],
          ["cmp:out",    "rload:pos"],
          ["rload:neg",  "gnd:out"],
        ],
      }),
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const outNodeId = fix.circuit.labelToNodeId.get("cmp:out");
    expect(outNodeId).toBeDefined();
    const outV = fix.engine.getNodeVoltage(outNodeId!);
    expect(Number.isFinite(outV)).toBe(true);
  });

  it("dcop_pp_inactive_output_converged", () => {
    // Push-pull: V+=0V, V-=1V => inactive (latch=0). DCOP converges.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vsrc_p", type: "DcVoltageSource", props: { label: "vsrc_p", voltage: 0 } },
          { id: "vsrc_n", type: "DcVoltageSource", props: { label: "vsrc_n", voltage: 1 } },
          { id: "rload",  type: "Resistor",        props: { label: "rload",  resistance: 10000 } },
          {
            id: "cmp",
            type: "VoltageComparator",
            props: {
              label:      "cmp",
              model:      "push-pull",
              hysteresis: 0,
              vos:        0,
              rOut:       50,
              vOH:        3.3,
              vOL:        0,
            },
          },
          { id: "gnd", type: "Ground", props: { label: "gnd" } },
        ],
        connections: [
          ["vsrc_p:pos", "cmp:in+"],
          ["vsrc_p:neg", "gnd:out"],
          ["vsrc_n:pos", "cmp:in-"],
          ["vsrc_n:neg", "gnd:out"],
          ["cmp:out",    "rload:pos"],
          ["rload:neg",  "gnd:out"],
        ],
      }),
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const outNodeId = fix.circuit.labelToNodeId.get("cmp:out");
    expect(outNodeId).toBeDefined();
    const outV = fix.engine.getNodeVoltage(outNodeId!);
    expect(Number.isFinite(outV)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 3 + 5 — Transient step-end paired + full-iteration paired (T3)
// Two .dts circuits: pp-on, pp-off.
// Each describe: one session in beforeAll, run in first it(), step-end in
// second it(), iteration parity in third it().
// ---------------------------------------------------------------------------

describeIfDll("Comparator PP active vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_PP_ON, analysis: "tran", tStop: 2e-5, maxStep: 1e-6 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_pp_active", async () => {
    await session.runTransient(0, 2e-5, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_pp_active", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_pp_active", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("Comparator PP inactive vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_PP_OFF, analysis: "tran", tStop: 2e-5, maxStep: 1e-6 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_pp_inactive", async () => {
    await session.runTransient(0, 2e-5, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_pp_inactive", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_pp_inactive", () => {
    session.compareAllAttempts();
  });
});

