import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { COMPARATOR_SCHEMA } from "../comparator.js";
import { PoolBackedAnalogElement } from "../../../solver/analog/element.js";
import {
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";

// Slot indices — resolved via schema for Cat 1 / Cat 7 pool assertions only.
const SLOT_OUTPUT_LATCH  = COMPARATOR_SCHEMA.indexOf.get("OUTPUT_LATCH")!;
const SLOT_OUTPUT_WEIGHT = COMPARATOR_SCHEMA.indexOf.get("OUTPUT_WEIGHT")!;

const DTS_PP_ON  = path.resolve("src/components/active/__tests__/fixtures/comparator-canon-pp-on.dts");
const DTS_PP_OFF = path.resolve("src/components/active/__tests__/fixtures/comparator-canon-pp-off.dts");

function findComparatorDriver(elements: ReadonlyArray<unknown>): PoolBackedAnalogElement {
  const idx = elements.findIndex(
    (el) =>
      el instanceof PoolBackedAnalogElement &&
      (el as PoolBackedAnalogElement).stateSchema.owner === "Comparator",
  );
  if (idx < 0) throw new Error("ComparatorDriverElement not found");
  return elements[idx] as PoolBackedAnalogElement;
}

// ---------------------------------------------------------------------------
// Cat 1 — push-pull topology
describe("Comparator initialization — push-pull (T1)", () => {
  it("init_pp_latch_high_when_vp_above_vn", () => {
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vsrc_p", type: "DcVoltageSource", props: { label: "vsrc_p", voltage: 1 } },
          { id: "vsrc_n", type: "DcVoltageSource", props: { label: "vsrc_n", voltage: 0 } },
          { id: "rload",  type: "Resistor",        props: { label: "rload",  resistance: 10000 } },
          { id: "cmp",    type: "VoltageComparator", props: { label: "cmp", model: "push-pull", responseTime: 1e-7, vOH: 3.3, vOL: 0 } },
          { id: "gnd",    type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vsrc_p:pos", "cmp:in+"], ["vsrc_p:neg", "gnd:out"],
          ["vsrc_n:pos", "cmp:in-"], ["vsrc_n:neg", "gnd:out"],
          ["rload:pos",  "cmp:out"], ["rload:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 2e-5, maxTimeStep: 1e-6 },
    });
    const cmp = findComparatorDriver(fix.circuit.elements);
    expect(fix.pool.state0[cmp._stateBase + SLOT_OUTPUT_LATCH]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cat 2 — DC operating point analytical (T1)
// ---------------------------------------------------------------------------

describe("Comparator DCOP — push-pull (T1)", () => {
  it("dcop_pp_off_output_near_vol", () => {
    // vP=0 < vN=1 → latch=0, weight→0, output→vOL=0 V (non-inverting)
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vsrc_p", type: "DcVoltageSource", props: { label: "vsrc_p", voltage: 0 } },
          { id: "vsrc_n", type: "DcVoltageSource", props: { label: "vsrc_n", voltage: 1 } },
          { id: "rload",  type: "Resistor",        props: { label: "rload",  resistance: 10000 } },
          { id: "cmp",    type: "VoltageComparator", props: { label: "cmp", model: "push-pull", responseTime: 1e-7, vOH: 3.3, vOL: 0 } },
          { id: "gnd",    type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vsrc_p:pos", "cmp:in+"], ["vsrc_p:neg", "gnd:out"],
          ["vsrc_n:pos", "cmp:in-"], ["vsrc_n:neg", "gnd:out"],
          ["rload:pos",  "cmp:out"], ["rload:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 2e-5, maxTimeStep: 1e-6 },
    });
    const outNodeId = fix.circuit.labelToNodeId.get("cmp:out")!;
    expect(fix.engine.getNodeVoltage(outNodeId)).toBeCloseTo(0, 1);
  });

  it("dcop_pp_on_output_near_voh", () => {
    // vP=1 > vN=0 → latch=1, weight→1, output→vOH=3.3 V after many steps (non-inverting)
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vsrc_p", type: "DcVoltageSource", props: { label: "vsrc_p", voltage: 1 } },
          { id: "vsrc_n", type: "DcVoltageSource", props: { label: "vsrc_n", voltage: 0 } },
          { id: "rload",  type: "Resistor",        props: { label: "rload",  resistance: 10000 } },
          { id: "cmp",    type: "VoltageComparator", props: { label: "cmp", model: "push-pull", responseTime: 1e-7, vOH: 3.3, vOL: 0 } },
          { id: "gnd",    type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vsrc_p:pos", "cmp:in+"], ["vsrc_p:neg", "gnd:out"],
          ["vsrc_n:pos", "cmp:in-"], ["vsrc_n:neg", "gnd:out"],
          ["rload:pos",  "cmp:out"], ["rload:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-6 },
    });
    for (let i = 0; i < 50; i++) fix.coordinator.step();
    const outNodeId = fix.circuit.labelToNodeId.get("cmp:out")!;
    expect(fix.engine.getNodeVoltage(outNodeId)).toBeCloseTo(3.3, 1);
  });
});

// ---------------------------------------------------------------------------
// Cat 3 + Cat 5 — Transient + full-iteration parity vs ngspice (T3)
// runTransient lives in the FIRST it() of each describeIfDll block.
// ---------------------------------------------------------------------------

describeIfDll("Comparator transient + iteration parity — PP active (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_PP_ON, analysis: "tran", tStop: 2e-5, maxStep: 1e-6 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_pp_on", async () => {
    await session.runTransient(0, 2e-5, 1e-6);
    session.compareAllSteps();
  });

  it("full_iteration_paired_pp_on", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("Comparator transient + iteration parity — PP inactive (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_PP_OFF, analysis: "tran", tStop: 2e-5, maxStep: 1e-6 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_pp_off", async () => {
    await session.runTransient(0, 2e-5, 1e-6);
    session.compareAllSteps();
  });

  it("full_iteration_paired_pp_off", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Cat 4 — Parameter hot-load (T1)
// All assertions on engine.getNodeVoltage — not on pool slots.
// ---------------------------------------------------------------------------

describe("Comparator parameter hot-load — push-pull (T1)", () => {
  it("hotload_vOH_raises_output_when_active", () => {
    // PP, output HIGH (vP>vN, latch=1, non-inverting).
    // Raising vOH from 3.3 to 5.0 V → V_out rises.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vsrc_p", type: "DcVoltageSource", props: { label: "vsrc_p", voltage: 1 } },
          { id: "vsrc_n", type: "DcVoltageSource", props: { label: "vsrc_n", voltage: 0 } },
          { id: "rload",  type: "Resistor",        props: { label: "rload",  resistance: 10000 } },
          { id: "cmp",    type: "VoltageComparator", props: { label: "cmp", model: "push-pull", responseTime: 1e-7, vOH: 3.3, vOL: 0 } },
          { id: "gnd",    type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vsrc_p:pos", "cmp:in+"], ["vsrc_p:neg", "gnd:out"],
          ["vsrc_n:pos", "cmp:in-"], ["vsrc_n:neg", "gnd:out"],
          ["rload:pos",  "cmp:out"], ["rload:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 2e-5, maxTimeStep: 1e-6 },
    });
    const outNodeId = fix.circuit.labelToNodeId.get("cmp:out")!;
    const before = fix.engine.getNodeVoltage(outNodeId);
    fix.coordinator.setComponentProperty(fix.element("cmp"), "vOH", 5.0);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNodeId);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_vOL_lowers_output_when_inactive", () => {
    // PP, output LOW (vP<vN, latch=0, non-inverting) after many steps.
    // Lowering vOL from 0 to -1 V → V_out drops.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vsrc_p", type: "DcVoltageSource", props: { label: "vsrc_p", voltage: 0 } },
          { id: "vsrc_n", type: "DcVoltageSource", props: { label: "vsrc_n", voltage: 1 } },
          { id: "rload",  type: "Resistor",        props: { label: "rload",  resistance: 10000 } },
          { id: "cmp",    type: "VoltageComparator", props: { label: "cmp", model: "push-pull", responseTime: 1e-7, vOH: 3.3, vOL: 0 } },
          { id: "gnd",    type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vsrc_p:pos", "cmp:in+"], ["vsrc_p:neg", "gnd:out"],
          ["vsrc_n:pos", "cmp:in-"], ["vsrc_n:neg", "gnd:out"],
          ["rload:pos",  "cmp:out"], ["rload:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-6 },
    });
    for (let i = 0; i < 50; i++) fix.coordinator.step();
    const outNodeId = fix.circuit.labelToNodeId.get("cmp:out")!;
    const before = fix.engine.getNodeVoltage(outNodeId);
    fix.coordinator.setComponentProperty(fix.element("cmp"), "vOL", -1.0);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNodeId);
    expect(after).toBeLessThan(before);
  });
});

// ---------------------------------------------------------------------------
// Cat 7 — StatePool rotation invariant (T1)
// Asserts s1 after an accepted step equals s0 before — the structural
// pool-rotation invariant for any pool-backed element.
// ---------------------------------------------------------------------------

describe("Comparator StatePool rotation invariant (T1)", () => {
  it("pool_rotation_s1_equals_prior_s0_after_accepted_step", () => {
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vsrc_p",   type: "DcVoltageSource", props: { label: "vsrc_p",   voltage: 1   } },
          { id: "vsrc_n",   type: "DcVoltageSource", props: { label: "vsrc_n",   voltage: 0   } },
          { id: "vsrc_voh", type: "DcVoltageSource", props: { label: "vsrc_voh", voltage: 3.3 } },
          { id: "rload",    type: "Resistor",        props: { label: "rload",    resistance: 1000 } },
          { id: "cmp",      type: "VoltageComparator", props: { label: "cmp", model: "push-pull", responseTime: 1e-7 } },
          { id: "gnd",      type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vsrc_p:pos",   "cmp:in+"], ["vsrc_p:neg",   "gnd:out"],
          ["vsrc_n:pos",   "cmp:in-"], ["vsrc_n:neg",   "gnd:out"],
          ["vsrc_voh:pos", "rload:pos"], ["vsrc_voh:neg", "gnd:out"],
          ["rload:neg",    "cmp:out"],
        ],
      }),
      params: { tStop: 2e-5, maxTimeStep: 1e-6 },
    });
    const cmp = findComparatorDriver(fix.circuit.elements);
    for (let i = 0; i < 3; i++) fix.coordinator.step();
    const s0BeforeStep = fix.pool.state0[cmp._stateBase + SLOT_OUTPUT_WEIGHT];
    fix.coordinator.step();
    const s1AfterStep = fix.pool.state1[cmp._stateBase + SLOT_OUTPUT_WEIGHT];
    expect(s1AfterStep).toBe(s0BeforeStep);
  });
});
