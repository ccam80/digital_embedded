import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import {
  ComparisonSession,
} from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { JFET_SCHEMA } from "../njfet.js";
import { PJFET_SCHEMA } from "../pjfet.js";

const DTS_NJFET_CS = path.resolve(
  "src/components/semiconductors/__tests__/fixtures/njfet-canon-common-source.dts",
);
const DTS_NJFET_CUTOFF = path.resolve(
  "src/components/semiconductors/__tests__/fixtures/njfet-canon-cutoff.dts",
);
const DTS_PJFET_CS = path.resolve(
  "src/components/semiconductors/__tests__/fixtures/pjfet-canon-common-source.dts",
);
const DTS_PJFET_CUTOFF = path.resolve(
  "src/components/semiconductors/__tests__/fixtures/pjfet-canon-cutoff.dts",
);

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Asserts post-warm-start state pool slot values and node voltages exist on
// JFET elements. NJFET (polarity +1) and PJFET (polarity -1) have distinct
// load() polarity dispatch and seeding paths — one block per topology variant.
// ---------------------------------------------------------------------------

describe("JFET initialization (T1)", () => {
  const SLOT_VGS_N = JFET_SCHEMA.indexOf.get("VGS")!;
  const SLOT_VGD_N = JFET_SCHEMA.indexOf.get("VGD")!;
  const SLOT_VGS_P = PJFET_SCHEMA.indexOf.get("VGS")!;
  const SLOT_VGD_P = PJFET_SCHEMA.indexOf.get("VGD")!;

  it("init_njfet_vgs_vgd_seeded", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 10 } },
          { id: "vg",  type: "DcVoltageSource", props: { label: "Vg",  voltage: 0 } },
          { id: "rd",  type: "Resistor",        props: { label: "Rd",  resistance: 10000 } },
          { id: "j1",  type: "NJFET",           props: { label: "J1" } },
          { id: "gnd", type: "Ground",          props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg",  "j1:D"],
          ["vg:pos",  "j1:G"],
          ["j1:S",    "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg",  "gnd:out"],
        ],
      }),
    });

    const idx = fix.circuit.elements.findIndex(
      (_e, i) => fix.elementLabels.get(i) === "J1",
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const el = fix.circuit.elements[idx]!;
    // jfetload.c initJct path seeds vgs/vgd to -1 (device on); after warm-start
    // these slots carry finite NR-converged values.
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_VGS_N])).toBe(true);
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_VGD_N])).toBe(true);
    // Engine has solved a node voltage at the JFET gate after warm-start.
    const vGate = fix.engine.getNodeVoltage(
      fix.circuit.labelToNodeId.get("J1:G")!,
    );
    expect(vGate).toBeCloseTo(0, 6);
  });

  it("init_pjfet_vgs_vgd_seeded", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 10 } },
          { id: "vg",  type: "DcVoltageSource", props: { label: "Vg",  voltage: 7 } },
          { id: "rd",  type: "Resistor",        props: { label: "Rd",  resistance: 10000 } },
          { id: "j1",  type: "PJFET",           props: { label: "J1" } },
          { id: "gnd", type: "Ground",          props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "j1:S"],
          ["j1:D",    "rd:pos"],
          ["rd:neg",  "gnd:out"],
          ["vg:pos",  "j1:G"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg",  "gnd:out"],
        ],
      }),
    });

    const idx = fix.circuit.elements.findIndex(
      (_e, i) => fix.elementLabels.get(i) === "J1",
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const el = fix.circuit.elements[idx]!;
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_VGS_P])).toBe(true);
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_VGD_P])).toBe(true);
    // Source pinned at Vdd=10V via stiff source.
    const vSource = fix.engine.getNodeVoltage(
      fix.circuit.labelToNodeId.get("J1:S")!,
    );
    expect(vSource).toBeCloseTo(10, 6);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical)
// Closed-form Shichman-Hodges saturation expectation for default JFET params:
// NJFET: VTO=-2V, BETA=1e-4, LAMBDA=0, B=1, gate=0V, source=GND, Vdd=10V via
//        Rd=10kOhm. vgst = vgs - VTO = 0 - (-2) = +2V; in saturation
//        (vds=Vdrain >= vgst), Bfac=0 collapses Sydney term, so:
//        cdrain = beta * vgst^2 * B = 1e-4 * 4 * 1 = 4e-4 A.
//        Vdrop = 4e-4 * 10000 = 4V → V(Drain) ≈ 6V.
// PJFET: VTO=+2V, source at +10V, gate at +7V. Polarity-flipped:
//        polarity*(Vg-Vs) = -1*(7-10) = +3V; vgst = 3-2 = +1V; cdrain ≈
//        beta * vgst^2 * B = 1e-4 * 1 * 1 = 1e-4 A pulled from drain to source.
//        Drain to ground via Rd=10k → V(Drain) close to ground.
// ---------------------------------------------------------------------------

describe("JFET DCOP analytical (T1)", () => {
  it("dcop_njfet_common_source_saturation", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 10 } },
          { id: "vg",  type: "DcVoltageSource", props: { label: "Vg",  voltage: 0 } },
          { id: "rd",  type: "Resistor",        props: { label: "Rd",  resistance: 10000 } },
          { id: "j1",  type: "NJFET",           props: { label: "J1" } },
          { id: "gnd", type: "Ground",          props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg",  "j1:D"],
          ["vg:pos",  "j1:G"],
          ["j1:S",    "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg",  "gnd:out"],
        ],
      }),
    });

    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    // Stiff source rails.
    const vRdPos = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("Rd:pos")!);
    const vGate  = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("J1:G")!);
    expect(vRdPos).toBeCloseTo(10, 6);
    expect(vGate).toBeCloseTo(0, 6);

    // Closed-form prediction: V(Drain) ≈ 6V (saturation cdrain ≈ 4e-4 A).
    // Bound saturation regime: drain in (vgst, Vdd) = (2V, 10V) excludes
    // cutoff and excludes shorted/linear-overrun regimes.
    const vDrain = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("J1:D")!);
    expect(vDrain).toBeGreaterThan(2);
    expect(vDrain).toBeLessThan(10);

    // |iD| = (Vdd - Vdrain) / Rd ≈ 4e-4 A; bound at least two orders above
    // GMIN-leakage and well below short-circuit.
    const iD = Math.abs((vRdPos - vDrain) / 10000);
    expect(iD).toBeGreaterThan(1e-5);
    expect(iD).toBeLessThan(1e-3);
  });

  it("dcop_pjfet_common_source_saturation", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 10 } },
          { id: "vg",  type: "DcVoltageSource", props: { label: "Vg",  voltage: 7 } },
          { id: "rd",  type: "Resistor",        props: { label: "Rd",  resistance: 100 } },
          { id: "j1",  type: "PJFET",           props: { label: "J1" } },
          { id: "gnd", type: "Ground",          props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "j1:S"],
          ["j1:D",    "rd:pos"],
          ["rd:neg",  "gnd:out"],
          ["vg:pos",  "j1:G"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg",  "gnd:out"],
        ],
      }),
    });

    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    // Source pinned at +10V, gate pinned at +7V via stiff sources.
    const vSource = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("J1:S")!);
    const vGate   = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("J1:G")!);
    expect(vSource).toBeCloseTo(10, 6);
    expect(vGate).toBeCloseTo(7, 6);

    // Closed-form predicts cdrain ≈ 1e-4 A flowing from S to D, drop across
    // Rd=100Ω ≈ 10mV → V(Drain) close to ground but >> GMIN noise floor.
    // Bound: V(Drain) above the cutoff floor (current >> GMIN).
    const vDrain = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("J1:D")!);
    const iD = Math.abs(vDrain / 100);
    expect(iD).toBeGreaterThan(1e-5);
    expect(iD).toBeLessThan(1e-1);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// Structural parameters (BETA, VTO, LAMBDA) and derived-state-recompute (TEMP,
// AREA). setParam triggers makeTp recompute; assertion is on simulator output.
// One block per representative parameter group, on the NJFET CS topology.
// ---------------------------------------------------------------------------

describe("JFET parameter hot-load (T1)", () => {
  function buildNJfetCs(): ReturnType<typeof buildFixture> {
    return buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 10 } },
          { id: "vg",  type: "DcVoltageSource", props: { label: "Vg",  voltage: 0 } },
          { id: "rd",  type: "Resistor",        props: { label: "Rd",  resistance: 10000 } },
          { id: "j1",  type: "NJFET",           props: { label: "J1" } },
          { id: "gnd", type: "Ground",          props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg",  "j1:D"],
          ["vg:pos",  "j1:G"],
          ["j1:S",    "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg",  "gnd:out"],
        ],
      }),
    });
  }

  it("hotload_BETA_changes_vd", () => {
    // BETA scales drain current quadratically: cdrain = beta * vgst^2 * (...).
    // Larger BETA → larger Id → V(Drain) drops further below Vdd.
    const fix = buildNJfetCs();
    const ce = fix.element("J1");
    const vdNode = fix.circuit.labelToNodeId.get("J1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "BETA", 4e-4);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeLessThan(before);
  });

  it("hotload_VTO_changes_vd", () => {
    // VTO shifts the threshold; raising VTO toward 0 shrinks vgst (= -VTO at
    // gate=0V), reducing Id and pushing V(Drain) closer to Vdd.
    const fix = buildNJfetCs();
    const ce = fix.element("J1");
    const vdNode = fix.circuit.labelToNodeId.get("J1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "VTO", -1.0);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_LAMBDA_changes_vd", () => {
    // LAMBDA = channel-length modulation; finite LAMBDA introduces gds slope
    // in saturation. Move from default 0 to 0.05 shifts the operating point.
    const fix = buildNJfetCs();
    const ce = fix.element("J1");
    const vdNode = fix.circuit.labelToNodeId.get("J1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "LAMBDA", 0.05);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(after).not.toBe(before);
  });

  it("hotload_TEMP_changes_vd", () => {
    // TEMP is a derived-state-recompute parameter: setParam("TEMP", T)
    // triggers computeJfetTempParams which recomputes tBeta, tThreshold,
    // tSatCur, vt. Universal temperature path required of every analog
    // component with temperature-dependent state.
    const fix = buildNJfetCs();
    const ce = fix.element("J1");
    const vdNode = fix.circuit.labelToNodeId.get("J1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "TEMP", 400);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    // Default BEX=0 → tBeta unchanged; default TCV=0 → tThreshold unchanged.
    // Yet vt and tSatCur shift, perturbing the gate-junction stamp at the
    // same operating point. Observable shift confirms recompute path ran.
    expect(after).not.toBe(before);
  });

  it("hotload_AREA_changes_vd", () => {
    // AREA scales beta and tSatCur via the area factor (instance-partitioned).
    // Larger AREA → larger Id → V(Drain) drops.
    const fix = buildNJfetCs();
    const ce = fix.element("J1");
    const vdNode = fix.circuit.labelToNodeId.get("J1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "AREA", 4);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeLessThan(before);
  });
});

// ---------------------------------------------------------------------------
// Category 6 — Limiting events (T1, own engine)
// jfetload.c calls pnjlim on G-S and G-D junctions during DCOP NR. Drives the
// engine to a converged DC-OP and asserts the limiting collector recorded the
// GS / GD junction visits with finite vBefore/vAfter.
// ---------------------------------------------------------------------------

describe("JFET limiting events own-engine (T1)", () => {
  it("limiting_pnjlim_fires_njfet_cs", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 10 } },
          { id: "vg",  type: "DcVoltageSource", props: { label: "Vg",  voltage: 0 } },
          { id: "rd",  type: "Resistor",        props: { label: "Rd",  resistance: 10000 } },
          { id: "j1",  type: "NJFET",           props: { label: "J1" } },
          { id: "gnd", type: "Ground",          props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg",  "j1:D"],
          ["vg:pos",  "j1:G"],
          ["j1:S",    "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg",  "gnd:out"],
        ],
      }),
    });
    fix.coordinator.setLimitingCapture(true);
    fix.coordinator.dcOperatingPoint();
    const events = fix.coordinator.getLimitingEvents();
    // jfetload.c pushes GS and GD events when limitingCollector is non-null.
    const gs = events.find(e => e.label === "J1" && e.junction === "GS");
    const gd = events.find(e => e.label === "J1" && e.junction === "GD");
    expect(gs).toBeDefined();
    expect(gd).toBeDefined();
    expect(gs!.limitType).toBe("pnjlim");
    expect(gd!.limitType).toBe("pnjlim");
    expect(Number.isFinite(gs!.vBefore)).toBe(true);
    expect(Number.isFinite(gs!.vAfter)).toBe(true);
    expect(Number.isFinite(gd!.vBefore)).toBe(true);
    expect(Number.isFinite(gd!.vAfter)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 7 — LTE rollback (T1)
// JFET.getLteTimestep proposes a dt based on cktTerr() over QGS / QGD charge
// slots. Slots are non-zero only when caps (CGS / CGD) are enabled.
// Topology: NJFET CS with caps activated. State1/state0 rotation invariant
// after warm-start steps is the rollback gate.
// ---------------------------------------------------------------------------

describe("JFET LTE rollback (T1)", () => {
  it("lte_rollback_state_invariant", () => {
    const SLOT_QGS = JFET_SCHEMA.indexOf.get("QGS")!;
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 10 } },
          { id: "vg",  type: "DcVoltageSource", props: { label: "Vg",  voltage: 0 } },
          { id: "rd",  type: "Resistor",        props: { label: "Rd",  resistance: 10000 } },
          { id: "j1",  type: "NJFET",           props: {
            label: "J1",
            // Activate cap-driven LTE path.
            CGS: 5e-12,
            CGD: 2e-12,
          } },
          { id: "gnd", type: "Ground",          props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg",  "j1:D"],
          ["vg:pos",  "j1:G"],
          ["j1:S",    "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });
    fix.coordinator.setConvergenceLogEnabled(true);
    for (let i = 0; i < 20; i++) fix.coordinator.step();
    const log = fix.coordinator.getConvergenceLog();
    expect(log).not.toBeNull();
    // Rollback invariant: at the step boundary post-warm-start, both state0
    // and state1 are populated (rotation occurred) and remain finite for the
    // rolled QGS charge slot. cktTerr/LTE proposals fire only when these
    // slots carry meaningful values.
    const idx = fix.circuit.elements.findIndex(
      (_e, i2) => fix.elementLabels.get(i2) === "J1",
    );
    const el = fix.circuit.elements[idx]!;
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_QGS])).toBe(true);
    expect(Number.isFinite(fix.pool.state1[el._stateBase + SLOT_QGS])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 / 6-paired — Harness sessions (T3)
// One describe()/session per .dts. Session opens once in beforeAll, runs in
// the FIRST it() per the contract (so any throw is a visible failed test
// rather than a silent skipped suite), reuses across categories that share
// the circuit, disposes in afterAll. Gated on canonical dllAvailable() via
// describeIfDll.
// Two operating regions per topology variant (saturation + cutoff) PLUS
// per-polarity variants (NJFET +1, PJFET -1) → 4 sessions total.
// ---------------------------------------------------------------------------

describeIfDll("NJFET common-source paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_NJFET_CS,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  // First it() owns the run. A hard throw here is a visible test failure.
  it("transient_step_end_paired_njfet_cs", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_njfet_cs", () => {
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

  it("full_iteration_paired_njfet_cs", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("NJFET cutoff paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_NJFET_CUTOFF,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_njfet_cutoff", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_njfet_cutoff", () => {
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

  it("full_iteration_paired_njfet_cutoff", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("PJFET common-source paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_PJFET_CS,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_pjfet_cs", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_pjfet_cs", () => {
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

  it("full_iteration_paired_pjfet_cs", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("PJFET cutoff paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_PJFET_CUTOFF,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_pjfet_cutoff", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_pjfet_cutoff", () => {
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

  it("full_iteration_paired_pjfet_cutoff", () => {
    session.compareAllAttempts();
  });
});
