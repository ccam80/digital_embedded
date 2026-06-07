import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
  DLL_PATH,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

// ---------------------------------------------------------------------------
// DTS fixture paths (T3 harness)
// ---------------------------------------------------------------------------

const DTS_1K = path.resolve(
  "src/components/active/__tests__/fixtures/ccvs-canon-1k.dts",
);
const DTS_ZERO = path.resolve(
  "src/components/active/__tests__/fixtures/ccvs-canon-zero.dts",
);

// ---------------------------------------------------------------------------
// Category 1 - Initialization (T1)
// CCVS holds no StatePool slots (no charge / no rolled state), so the
// post-warm-start observable is the node voltage at the output port: the
// engine has solved the DCOP for the four-terminal CCVS and the output
// node sits at transresistance * I_sense.
// ---------------------------------------------------------------------------

describe("CCVS initialization (T1)", () => {
  it("init_warm_start_output_node_seeded", () => {
    // Vs=5V, Rsense=5k -> I_sense = 1mA; transresistance=1k -> V_out = 1V.
    // After buildFixture's warm-start step, engine.getNodeVoltage on the
    // CCVS output node must be the converged DCOP solution (1V).
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",        type: "DcVoltageSource", props: { label: "vs1",       voltage: 5.0 } },
          { id: "rsense",    type: "Resistor",        props: { label: "rsense",    resistance: 5000 } },
          { id: "senseVsrc", type: "DcVoltageSource", props: { label: "senseVsrc", voltage: 0 } },
          { id: "ccvs",      type: "CCVS",            props: { label: "ccvs1", transresistance: 1000, senseSourceLabel: "senseVsrc" } },
          { id: "rload",     type: "Resistor",        props: { label: "rload",     resistance: 1e6 } },
          { id: "gnd",       type: "Ground" },
        ],
        connections: [
          ["vs:pos",        "rsense:pos"],
          ["rsense:neg",    "senseVsrc:pos"],
          ["senseVsrc:pos", "ccvs:sense+"],
          ["senseVsrc:neg", "gnd:out"],
          ["ccvs:sense-",   "gnd:out"],
          ["ccvs:out+",     "rload:pos"],
          ["rload:neg",     "gnd:out"],
          ["ccvs:out-",     "gnd:out"],
          ["vs:neg",        "gnd:out"],
        ],
      }),
    });

    const vOut = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("ccvs1:out+")!);
    expect(Number.isFinite(vOut)).toBe(true);
    // Closed form: V_out = transresistance * (Vs / Rsense) = 1000 * (5 / 5000) = 1.0 V
    expect(vOut).toBeCloseTo(1.0, 4);
  });
});

// ---------------------------------------------------------------------------
// Category 2 analytical - DC operating point (T1)
// Closed-form V_out = transresistance * I_sense, exercised across two
// distinct operating points so the linear DCOP solve is verified outside
// the trivial single-point case.
// ---------------------------------------------------------------------------

describe("CCVS DCOP analytical (T1)", () => {
  it("dcop_transresistance_1k_5V_drive", () => {
    // I_sense = 5V / 5k = 1mA; V_out = 1k * 1mA = 1V.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",        type: "DcVoltageSource", props: { label: "vs1",       voltage: 5.0 } },
          { id: "rsense",    type: "Resistor",        props: { label: "rsense",    resistance: 5000 } },
          { id: "senseVsrc", type: "DcVoltageSource", props: { label: "senseVsrc", voltage: 0 } },
          { id: "ccvs",      type: "CCVS",            props: { label: "ccvs1", transresistance: 1000, senseSourceLabel: "senseVsrc" } },
          { id: "rload",     type: "Resistor",        props: { label: "rload",     resistance: 1e6 } },
          { id: "gnd",       type: "Ground" },
        ],
        connections: [
          ["vs:pos",        "rsense:pos"],
          ["rsense:neg",    "senseVsrc:pos"],
          ["senseVsrc:pos", "ccvs:sense+"],
          ["senseVsrc:neg", "gnd:out"],
          ["ccvs:sense-",   "gnd:out"],
          ["ccvs:out+",     "rload:pos"],
          ["rload:neg",     "gnd:out"],
          ["ccvs:out-",     "gnd:out"],
          ["vs:neg",        "gnd:out"],
        ],
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    // V_out = transresistance * I_sense = 1000 * (5 / 5000) = 1.0 V
    const vOut = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("ccvs1:out+")!);
    expect(vOut).toBeCloseTo(1.0, 4);

    // sense+ is wired to the 0V senseVsrc whose other terminal is GND, so
    // V(sense+) is held at 0V by the sense source.
    const vSensePlus = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("ccvs1:sense+")!);
    expect(vSensePlus).toBeCloseTo(0.0, 6);
  });

  it("dcop_zero_drive_zero_output", () => {
    // Vs=0 -> I_sense=0 -> V_out=0. Distinct operating regime: the linear
    // expression evaluates at the trivial control quantity, the NR-linearized
    // RHS contribution from `value - derivative * ctrlValue` is exactly 0.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",        type: "DcVoltageSource", props: { label: "vs1",       voltage: 0.0 } },
          { id: "rsense",    type: "Resistor",        props: { label: "rsense",    resistance: 5000 } },
          { id: "senseVsrc", type: "DcVoltageSource", props: { label: "senseVsrc", voltage: 0 } },
          { id: "ccvs",      type: "CCVS",            props: { label: "ccvs1", transresistance: 1000, senseSourceLabel: "senseVsrc" } },
          { id: "rload",     type: "Resistor",        props: { label: "rload",     resistance: 1e6 } },
          { id: "gnd",       type: "Ground" },
        ],
        connections: [
          ["vs:pos",        "rsense:pos"],
          ["rsense:neg",    "senseVsrc:pos"],
          ["senseVsrc:pos", "ccvs:sense+"],
          ["senseVsrc:neg", "gnd:out"],
          ["ccvs:sense-",   "gnd:out"],
          ["ccvs:out+",     "rload:pos"],
          ["rload:neg",     "gnd:out"],
          ["ccvs:out-",     "gnd:out"],
          ["vs:neg",        "gnd:out"],
        ],
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vOut = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("ccvs1:out+")!);
    expect(vOut).toBeCloseTo(0.0, 6);
  });

  it("dcop_setup_throws_without_senseSourceLabel", () => {
    // The CCVS factory passes the senseSourceLabel via setParam at build
    // time. With it omitted, setup() throws the canonical error at the
    // first warm-start step inside buildFixture. This is observable via
    // the simulator path (buildFixture invokes coordinator.step() -> setup),
    // not a registry-plumbing assertion.
    expect(() => buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",        type: "DcVoltageSource", props: { label: "vs1",       voltage: 5.0 } },
          { id: "rsense",    type: "Resistor",        props: { label: "rsense",    resistance: 5000 } },
          { id: "senseVsrc", type: "DcVoltageSource", props: { label: "senseVsrc", voltage: 0 } },
          // senseSourceLabel intentionally omitted - the build-spec entry
          // path leaves it as "" and setup() must throw.
          { id: "ccvs",      type: "CCVS",            props: { label: "ccvs1", transresistance: 1000 } },
          { id: "rload",     type: "Resistor",        props: { label: "rload",     resistance: 1e6 } },
          { id: "gnd",       type: "Ground" },
        ],
        connections: [
          ["vs:pos",        "rsense:pos"],
          ["rsense:neg",    "senseVsrc:pos"],
          ["senseVsrc:pos", "ccvs:sense+"],
          ["senseVsrc:neg", "gnd:out"],
          ["ccvs:sense-",   "gnd:out"],
          ["ccvs:out+",     "rload:pos"],
          ["rload:neg",     "gnd:out"],
          ["ccvs:out-",     "gnd:out"],
          ["vs:neg",        "gnd:out"],
        ],
      }),
    })).toThrow(/senseSourceLabel not set/);
  });
});

// ---------------------------------------------------------------------------
// Category 4 - Parameter hot-load (T1)
// Hot-load coverage: `transresistance` is the sole structural parameter
// declared on the CCVS modelRegistry.behavioral.paramDefs. CCVS has no
// TEMP / AREA / derived-state recompute parameters - it is a stamp-only
// element with no temperature-dependent saturation current. One it()
// suffices for the structural-parameter group.
// ---------------------------------------------------------------------------

describe("CCVS hot-load (T1)", () => {
  it("hotload_transresistance_changes_vout", () => {
    // Initial transresistance=1000 -> V_out = 1V at I_sense=1mA.
    // After setComponentProperty("transresistance", 2000), V_out should
    // move toward 2V (per project policy: model params are hot-loadable
    // via setParam).
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",        type: "DcVoltageSource", props: { label: "vs1",       voltage: 5.0 } },
          { id: "rsense",    type: "Resistor",        props: { label: "rsense",    resistance: 5000 } },
          { id: "senseVsrc", type: "DcVoltageSource", props: { label: "senseVsrc", voltage: 0 } },
          { id: "ccvs",      type: "CCVS",            props: { label: "ccvs1", transresistance: 1000, senseSourceLabel: "senseVsrc" } },
          { id: "rload",     type: "Resistor",        props: { label: "rload",     resistance: 1e6 } },
          { id: "gnd",       type: "Ground" },
        ],
        connections: [
          ["vs:pos",        "rsense:pos"],
          ["rsense:neg",    "senseVsrc:pos"],
          ["senseVsrc:pos", "ccvs:sense+"],
          ["senseVsrc:neg", "gnd:out"],
          ["ccvs:sense-",   "gnd:out"],
          ["ccvs:out+",     "rload:pos"],
          ["rload:neg",     "gnd:out"],
          ["ccvs:out-",     "gnd:out"],
          ["vs:neg",        "gnd:out"],
        ],
      }),
    });

    const outNodeId = fix.circuit.labelToNodeId.get("ccvs1:out+")!;
    const before = fix.engine.getNodeVoltage(outNodeId);
    expect(before).toBeCloseTo(1.0, 4);

    fix.coordinator.setComponentProperty(fix.element("ccvs1"), "transresistance", 2000);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNodeId);
    expect(after).not.toBeCloseTo(before, 4);
    // Closed form post-change: V_out = 2000 * (5 / 5000) = 2.0 V.
    expect(after).toBeCloseTo(2.0, 4);
  });
});

// ---------------------------------------------------------------------------
// CCVS — T3 harness: transresistance=1k @ 5V vs ngspice (Cat 2-numerical / 3 / 5)
// ---------------------------------------------------------------------------

describeIfDll("CCVS transresistance=1k paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_1K, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_1k", async () => {
    // First it() owns the run; tStop=1e-4 s, maxStep=1e-6 s.
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_1k", () => {
    // Cat 2-numerical: reads from the recorded session (step 0 = DCOP seed).
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_1k", () => {
    // Cat 5: all NR iterations across all steps.
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// CCVS — T3 harness: zero-input regime vs ngspice (Cat 2-numerical / 3 / 5)
// ---------------------------------------------------------------------------

describeIfDll("CCVS zero-input paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_ZERO, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_zero", async () => {
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_zero", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_zero", () => {
    session.compareAllAttempts();
  });
});
