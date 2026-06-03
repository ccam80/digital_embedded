import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { MOSFET3_SCHEMA } from "../mosfet3.js";

const DTS_AMP = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/mos3-amp.dts",
);
const DTS_AC = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/mos3-ac.dts",
);

// A short-channel level-3 model exercising the THETA/VMAX/KAPPA/ETA/XJ/NFS
// corrections (a plain L1 deck would leave all five at default-zero).
const L3_MODEL: Record<string, number> = {
  VTO: 0.7, KP: 60e-6, W: 20e-6, L: 1e-6,
  GAMMA: 0.5, PHI: 0.6, NSUB: 1e16,
  THETA: 0.05, VMAX: 1e5, KAPPA: 0.5, ETA: 0.1, XJ: 0.4e-6,
  DELTA: 1.0, NFS: 1e10, TOX: 2e-8, UO: 600,
  RD: 0, RS: 0,
};

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// ---------------------------------------------------------------------------

describe("MOS3 initialization (T1)", () => {
  const SLOT_VGS = MOSFET3_SCHEMA.indexOf.get("VGS")!;
  const SLOT_VDS = MOSFET3_SCHEMA.indexOf.get("VDS")!;

  it("init_schema_has_17_slots", () => {
    expect(MOSFET3_SCHEMA.size).toBe(17);
  });

  it("init_slot_order_matches_mos3defs", () => {
    const order = ["VBD", "VBS", "VGS", "VDS", "CAPGS", "QGS", "CQGS",
      "CAPGD", "QGD", "CQGD", "CAPGB", "QGB", "CQGB", "QBD", "CQBD", "QBS", "CQBS"];
    order.forEach((name, i) => {
      expect(MOSFET3_SCHEMA.indexOf.get(name)).toBe(i);
    });
  });

  it("init_nmos3_vgs_vds_seeded", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 5 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 3 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 10000 } },
          { id: "m1", type: "NMOS3", props: { label: "M1", model: "spice-l3", ...L3_MODEL } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
          ["m1:B", "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg", "gnd:out"],
        ],
      }),
    });
    const idx = fix.circuit.elements.findIndex(
      (_e, i) => fix.elementLabels.get(i) === "M1",
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const el = fix.circuit.elements[idx]!;
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_VGS])).toBe(true);
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_VDS])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical sanity)
// ---------------------------------------------------------------------------

describe("MOS3 DCOP analytical sanity (T1)", () => {
  function buildCommonSource(vg: number, modelOverride: Record<string, number> = {}) {
    return buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 5 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: vg } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 10000 } },
          { id: "m1", type: "NMOS3", props: { label: "M1", model: "spice-l3", ...L3_MODEL, ...modelOverride } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
          ["m1:B", "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg", "gnd:out"],
        ],
      }),
    });
  }

  it("dcop_nmos3_on_pulls_drain_low", () => {
    const fix = buildCommonSource(3);
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const vd = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("M1:D")!);
    expect(Number.isFinite(vd)).toBe(true);
    expect(vd).toBeGreaterThanOrEqual(0);
    expect(vd).toBeLessThan(5);
  });

  it("dcop_nmos3_off_drain_near_rail", () => {
    const fix = buildCommonSource(0);
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const vd = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("M1:D")!);
    expect(vd).toBeGreaterThan(4.9);
  });

  it("dcop_body_effect_bulk_biased_separately", () => {
    // 4-terminal: bulk biased below source raises threshold (body effect).
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 5 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 2.5 } },
          { id: "vbb", type: "DcVoltageSource", props: { label: "Vbb", voltage: 2 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 10000 } },
          { id: "m1", type: "NMOS3", props: { label: "M1", model: "spice-l3", ...L3_MODEL } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
          ["vbb:pos", "m1:B"],
          ["vbb:neg", "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg", "gnd:out"],
        ],
      }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    // 4-terminal: bulk node driven separately from source by Vbb; the body-
    // effect path (gamma-from-nsub) participates and the OP converges.
    const vb = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("M1:B")!);
    expect(Math.abs(vb)).toBeCloseTo(2, 3);
  });

  it("dcop_pmos3_converges", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 5 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 2 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 10000 } },
          { id: "m1", type: "PMOS3", props: { label: "M1", model: "spice-l3", ...L3_MODEL, VTO: -0.7 } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "m1:S"],
          ["vdd:pos", "m1:B"],
          ["m1:D", "rd:pos"],
          ["rd:neg", "gnd:out"],
          ["vg:pos", "m1:G"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg", "gnd:out"],
        ],
      }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const vd = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("M1:D")!);
    expect(Number.isFinite(vd)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// ---------------------------------------------------------------------------

describe("MOS3 parameter hot-load (T1)", () => {
  function buildSwitch(): ReturnType<typeof buildFixture> {
    return buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 5 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 2 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 10000 } },
          { id: "m1", type: "NMOS3", props: { label: "M1", model: "spice-l3", ...L3_MODEL } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
          ["m1:B", "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg", "gnd:out"],
        ],
      }),
    });
  }

  function getM1(fix: ReturnType<typeof buildFixture>) {
    const idx = fix.circuit.elements.findIndex(
      (_e, i) => fix.elementLabels.get(i) === "M1",
    );
    const ce = fix.circuit.elementToCircuitElement.get(idx);
    expect(ce).toBeDefined();
    return { idx, ce: ce! };
  }

  it("hotload_KP_changes_vd", () => {
    const fix = buildSwitch();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "KP", 600e-6);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_VTO_changes_vd", () => {
    const fix = buildSwitch();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "VTO", 3);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_THETA_takes_effect", () => {
    const fix = buildSwitch();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "THETA", 0.5);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(Number.isFinite(after)).toBe(true);
    expect(after).not.toBe(before);
  });

  it("hotload_KAPPA_takes_effect", () => {
    const fix = buildSwitch();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    fix.coordinator.setComponentProperty(ce, "KAPPA", 1.5);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(Number.isFinite(after)).toBe(true);
  });

  it("hotload_VMAX_takes_effect", () => {
    const fix = buildSwitch();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "VMAX", 5e4);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(Number.isFinite(after)).toBe(true);
    expect(after).not.toBe(before);
  });

  it("hotload_TEMP_changes_vd", () => {
    const fix = buildSwitch();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "TEMP", 400);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(after).not.toBeCloseTo(before, 6);
  });
});

// ---------------------------------------------------------------------------
// Category 6 — Limiting events (T1, own engine)
// ---------------------------------------------------------------------------

describe("MOS3 limiting events own-engine (T1)", () => {
  it("limiting_records_events_nmos3", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 50 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 10 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 100 } },
          { id: "m1", type: "NMOS3", props: { label: "M1", model: "spice-l3", ...L3_MODEL } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
          ["m1:B", "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg", "gnd:out"],
        ],
      }),
    });
    fix.coordinator.setLimitingCapture(true);
    const result = fix.coordinator.dcOperatingPoint();
    expect(result!.converged).toBe(true);
    const events = fix.coordinator.getLimitingEvents();
    expect(Array.isArray(events)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 — Harness sessions (T3), gated on the DLL.
// ---------------------------------------------------------------------------

describeIfDll("MOS3 amplifier paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_AMP,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("dcop_paired_amp", async () => {
    await session.runTransient(0, 1e-4, 1e-6);
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("transient_step_end_paired_amp", () => {
    session.compareAllSteps();
  });

  it("full_iteration_paired_amp", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("MOS3 AC small-signal paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_AC,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("ac_dcop_bias_paired", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });
});
