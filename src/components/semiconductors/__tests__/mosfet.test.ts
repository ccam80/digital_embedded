import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { MOSFET_SCHEMA } from "../mosfet.js";

const DTS_NMOS_INVERTER = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/mosfet-inverter.dts",
);
const DTS_PMOS_CS = path.resolve(
  "src/components/semiconductors/__tests__/fixtures/mosfet-canon-pmos-cs.dts",
);

// Category 1 — Initialization (T1)

describe("MOSFET initialization (T1)", () => {
  const SLOT_VGS = MOSFET_SCHEMA.indexOf.get("VGS")!;
  const SLOT_VDS = MOSFET_SCHEMA.indexOf.get("VDS")!;

  it("init_nmos_vgs_seeded", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 5 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 3 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 1000 } },
          { id: "m1", type: "NMOS", props: { label: "M1", model: "spice-l1" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
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
    const vG = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("M1:G")!);
    expect(Number.isFinite(vG)).toBe(true);
  });

  it("init_pmos_vgs_seeded", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 5 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 2 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 1000 } },
          { id: "m1", type: "PMOS", props: { label: "M1", model: "spice-l1" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "m1:S"],
          ["m1:D", "rd:pos"],
          ["rd:neg", "gnd:out"],
          ["vg:pos", "m1:G"],
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
// Forward-saturation NMOS common-source; collector pulled below rail. The
// bit-exact paired check against ngspice is the canonical Cat 2-numerical
// check (T3 sessions below).
// ---------------------------------------------------------------------------

describe("MOSFET DCOP analytical sanity (T1)", () => {
  it("dcop_nmos_cs_converges", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 5 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 3 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 1000 } },
          { id: "m1", type: "NMOS", props: { label: "M1", model: "spice-l1" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
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
    expect(vd).toBeGreaterThan(0);
    expect(vd).toBeLessThan(5);
  });

  it("dcop_pmos_cs_converges", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 5 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 2 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 1000 } },
          { id: "m1", type: "PMOS", props: { label: "M1", model: "spice-l1" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "m1:S"],
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
    expect(vd).toBeGreaterThan(0);
    expect(vd).toBeLessThan(5);
  });
});

// Category 4 — Parameter hot-load (T1)

describe("MOSFET parameter hot-load (T1)", () => {
  function buildCs(): ReturnType<typeof buildFixture> {
    return buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 5 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 3 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 1000 } },
          { id: "m1", type: "NMOS", props: { label: "M1", model: "spice-l1" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
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

  it("hotload_VTO_changes_vd", () => {
    const fix = buildCs();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "VTO", 2.5);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    // Raising VTO above Vgs reduces drain current -> drain pulls toward Vdd.
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_KP_changes_vd", () => {
    const fix = buildCs();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "KP", 240e-6);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    // Doubling KP doubles transconductance -> larger Id -> drain falls.
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_LAMBDA_changes_vd", () => {
    const fix = buildCs();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "LAMBDA", 0.1);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(after).not.toBe(before);
  });

  it("hotload_W_changes_vd", () => {
    const fix = buildCs();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "W", 10e-6);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    // Wider channel -> more current -> drain falls.
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_L_changes_vd", () => {
    const fix = buildCs();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "L", 5e-6);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_TEMP_changes_vd", () => {
    const fix = buildCs();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "TEMP", 400);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_PHI_changes_vd", () => {
    const fix = buildCs();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "PHI", 0.8);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(Number.isFinite(after)).toBe(true);
    expect(after).not.toBe(before);
  });

  it("hotload_GAMMA_changes_vd", () => {
    const fix = buildCs();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "GAMMA", 0.5);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(Number.isFinite(after)).toBe(true);
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Category 6 — Limiting events (T1, own engine)
// fetlim fires on Vgs at high gate drive; limvds fires on Vds during DCOP
// large-step recovery. Drives the engine to a converged DC-OP and asserts
// the limiting collector recorded GS / DS junction visits.
// ---------------------------------------------------------------------------

describe("MOSFET limiting events own-engine (T1)", () => {
  it("limiting_fetlim_fires_nmos_cs", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 5 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 5 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 1000 } },
          { id: "m1", type: "NMOS", props: { label: "M1", model: "spice-l1" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg", "gnd:out"],
        ],
      }),
    });
    fix.coordinator.setLimitingCapture(true);
    fix.coordinator.dcOperatingPoint();
    const events = fix.coordinator.getLimitingEvents();
    const gs = events.find(e => e.label === "M1" && e.junction === "GS");
    const ds = events.find(e => e.label === "M1" && e.junction === "DS");
    expect(gs).toBeDefined();
    expect(ds).toBeDefined();
    expect(gs!.limitType).toBe("fetlim");
    expect(ds!.limitType).toBe("limvds");
    expect(Number.isFinite(gs!.vBefore)).toBe(true);
    expect(Number.isFinite(gs!.vAfter)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 7 — LTE rollback (T1)
// MOSFET.getLteTimestep proposes a dt based on cktTerr() over QGS / QGD / QGB
// / QBD / QBS charge slots. The slots remain finite across the warm-start
// step boundary; the rotation invariant (state0 / state1 both populated and
// finite) is the rollback gate.
// ---------------------------------------------------------------------------

describe("MOSFET LTE rollback (T1)", () => {
  it("lte_rollback_state_invariant", () => {
    const SLOT_QGS = MOSFET_SCHEMA.indexOf.get("QGS")!;
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 5 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 3 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 1000 } },
          { id: "m1", type: "NMOS", props: {
            label: "M1",
            model: "spice-l1",
            // Activate cap-driven LTE path: gate-overlap caps + body junction caps.
            CGSO: 1e-10,
            CGDO: 1e-10,
            CBD: 1e-12,
            CBS: 1e-12,
          } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });
    fix.coordinator.setConvergenceLogEnabled(true);
    for (let i = 0; i < 20; i++) fix.coordinator.step();
    const log = fix.coordinator.getConvergenceLog();
    expect(log).not.toBeNull();
    const idx = fix.circuit.elements.findIndex(
      (_e, i2) => fix.elementLabels.get(i2) === "M1",
    );
    const el = fix.circuit.elements[idx]!;
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_QGS])).toBe(true);
    expect(Number.isFinite(fix.pool.state1[el._stateBase + SLOT_QGS])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 / 6-paired — Harness sessions (T3)
// One describe()/session per .dts. Each session opens once in beforeAll,
// reuses across categories that share that circuit, disposes in afterAll.
// All gated on canonical dllAvailable() via describeIfDll.
// ---------------------------------------------------------------------------

describeIfDll("MOSFET NMOS inverter paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_NMOS_INVERTER,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_nmos_inverter", async () => {
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_nmos_inverter", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("full_iteration_paired_nmos_inverter", () => {
    session.compareAllAttempts();
  });

  it("limiting_paired_nmos_inverter", () => {
    // fetlim / limvds limiting events on M1 GS / DS junctions; bit-exact
    // {vBefore,vAfter,wasLimited} parity.
    const cmp = session.getLimitingComparison("M1", 0, 0);
    for (const j of cmp.junctions) {
      expect(j.limitingDiff).toBe(0);
    }
  });
});

describeIfDll("MOSFET PMOS common-source paired vs ngspice (T3)", () => {
  // PMOS polarity exercises the polarity=-1 branch in load(): every junction
  // voltage (vbs/vgs/vds) is polarity-signed at the read site and un-signed
  // at the stamp site. Distinct from any NMOS .dts.
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_PMOS_CS,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_pmos_cs", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_pmos_cs", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("full_iteration_paired_pmos_cs", () => {
    session.compareAllAttempts();
  });
});
