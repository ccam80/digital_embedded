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

const DTS_MIRROR = path.resolve(
  "src/components/active/__tests__/fixtures/cccs-canon-mirror.dts",
);
const DTS_GAIN10 = path.resolve(
  "src/components/active/__tests__/fixtures/cccs-canon-gain10.dts",
);

// ---------------------------------------------------------------------------
// Circuit factory (T1 programmatic)
// ---------------------------------------------------------------------------
//
// Topology:
//   Vs --> Rsense --> senseVsrc(0V) --> GND
//                     |--> cccs:sense+
//   cccs:sense- --> GND
//   cccs:out+   --> Rload --> GND
//   cccs:out-   --> GND
//
// I_sense = Vs / Rsense (the 0V senseVsrc forces sense+ to 0V and measures
// the current through Rsense via its branch row).
// I_out   = currentGain * I_sense  (default expression "I(sense)").
//
// SPICE F-element convention (ngspice cccsload.c, matched bit-exact by
// digiTS as of the Norton-stamp sign fix): current of magnitude I_out flows
// FROM out+ THROUGH the source TO out-. With out- grounded and rload between
// out+ and GND, the external loop runs GND -> rload -> out+ -> source ->
// out- -> GND. The resistor sees current flowing from rload:neg (GND) up to
// rload:pos (out+), so V(rload+) = -I_out * Rload (below GND).

interface CccsCircuitParams {
  vsVoltage?: number;
  rSense?: number;
  rLoad?: number;
  currentGain?: number;
  expression?: string;
  /** Drop the senseSourceLabel prop so setup() throws the canonical error. */
  omitSenseLabel?: boolean;
}

function buildCccsCircuit(facade: DefaultSimulatorFacade, p: CccsCircuitParams): Circuit {
  const cccsProps: Record<string, string | number> = {
    label: "cccs1",
    expression: p.expression ?? "I(sense)",
    currentGain: p.currentGain ?? 1.0,
  };
  if (p.omitSenseLabel !== true) {
    cccsProps.senseSourceLabel = "senseVsrc";
  }
  return facade.build({
    components: [
      { id: "vs",        type: "DcVoltageSource", props: { label: "vs1",       voltage: p.vsVoltage ?? 5.0 } },
      { id: "rsense",    type: "Resistor",        props: { label: "rsense",    resistance: p.rSense ?? 1000 } },
      { id: "senseVsrc", type: "DcVoltageSource", props: { label: "senseVsrc", voltage: 0 } },
      { id: "cccs",      type: "CCCS",            props: cccsProps },
      { id: "rload",     type: "Resistor",        props: { label: "rload",     resistance: p.rLoad ?? 1000 } },
      { id: "gnd",       type: "Ground" },
    ],
    connections: [
      ["vs:pos",        "rsense:pos"],
      ["rsense:neg",    "senseVsrc:pos"],
      ["senseVsrc:pos", "cccs:sense+"],
      ["senseVsrc:neg", "gnd:out"],
      ["cccs:sense-",   "gnd:out"],
      ["cccs:out+",     "rload:pos"],
      ["rload:neg",     "gnd:out"],
      ["cccs:out-",     "gnd:out"],
      ["vs:neg",        "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

describe("CCCS initialization (T1)", () => {
  it("init_post_warm_start_node_voltages_match_dcop", () => {
    // Cat 1: post-warm-start (one coordinator.step()) the node voltage at
    // cccs1:out+ must equal the DCOP-seeded value. With Vs=5V, Rsense=1k,
    // gain=1, Rload=1k: I_sense = 5mA, I_out = 5mA flowing out+ → out-.
    // SPICE F convention: V(rload+) = -5mA * 1kΩ = -5V.
    const fix = buildFixture({
      build: (_r, facade) => buildCccsCircuit(facade, {
        vsVoltage: 5.0, rSense: 1000, rLoad: 1000, currentGain: 1,
      }),
    });
    // sense+ is forced to 0V by senseVsrc; out+ is pulled below GND by the
    // controlled current sinking through Rload from GND.
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "cccs1:sense+"))).toBeCloseTo(0.0, 6);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "cccs1:out+"))).toBeCloseTo(-5.0, 4);
  });
});

describe("CCCS DCOP analytical (T1)", () => {
  it("dcop_current_mirror_gain_1", () => {
    // I_sense = 5V/1kΩ = 5mA, gain=1 → I_out=5mA out+ → out-.
    // SPICE F convention: V(rload+) = -5mA * 1kΩ = -5V.
    const fix = buildFixture({
      build: (_r, facade) => buildCccsCircuit(facade, {
        vsVoltage: 5.0, rSense: 1000, rLoad: 1000, currentGain: 1,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "cccs1:out+"));
    expect(vOut).toBeCloseTo(-5.0, 4);
  });

  it("dcop_current_gain_10_amplification", () => {
    // I_sense = 1V/1kΩ = 1mA, gain=10 → I_out=10mA out+ → out-.
    // SPICE F convention: V(rload+) = -10mA * 1kΩ = -10V.
    const fix = buildFixture({
      build: (_r, facade) => buildCccsCircuit(facade, {
        vsVoltage: 1.0, rSense: 1000, rLoad: 1000, currentGain: 10,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "cccs1:out+"));
    expect(vOut).toBeCloseTo(-10.0, 4);
  });

  it("dcop_zero_input_zero_output", () => {
    // Vs = 0V → I_sense = 0 → I_out = 0 → V(rload+) = 0V.
    const fix = buildFixture({
      build: (_r, facade) => buildCccsCircuit(facade, {
        vsVoltage: 0.0, rSense: 1000, rLoad: 1000, currentGain: 1,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "cccs1:out+"));
    expect(vOut).toBeCloseTo(0.0, 6);
  });

  it("dcop_nonlinear_expression_quadratic_in_isense", () => {
    // expression: 0.1 * I(sense)^2; I_sense = 10V/1kΩ = 10mA = 0.01A.
    // I_out = 0.1 * (0.01)^2 = 1e-5 A = 10 µA flowing out+ → out-.
    // SPICE F convention: V(rload+) = -10µA * 1kΩ = -10mV = -0.01V.
    const fix = buildFixture({
      build: (_r, facade) => buildCccsCircuit(facade, {
        vsVoltage: 10.0, rSense: 1000, rLoad: 1000, expression: "0.1 * I(sense)^2",
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "cccs1:out+"));
    expect(vOut).toBeCloseTo(-0.01, 4);
  });

  it("dcop_setup_throws_without_senseSourceLabel", () => {
    // Cat 2 sibling: missing senseSourceLabel must surface the canonical
    // error during the warm-start setup() call. buildFixture's first
    // coordinator.step() runs _setup() which throws.
    expect(() => buildFixture({
      build: (_r, facade) => buildCccsCircuit(facade, { omitSenseLabel: true }),
    })).toThrow(/senseSourceLabel not set/);
  });
});

describe("CCCS parameter hot-load (T1)", () => {
  it("hotload_currentGain_changes_output_voltage", () => {
    // Cat 4: setComponentProperty on currentGain must change V(rload+).
    // Start gain=1, Vs=5V, Rsense=Rload=1kΩ → V(rload+)=-5V (SPICE F).
    // After gain=2 → I_out=10mA → V(rload+)=-10V.
    const fix = buildFixture({
      build: (_r, facade) => buildCccsCircuit(facade, {
        vsVoltage: 5.0, rSense: 1000, rLoad: 1000, currentGain: 1,
      }),
    });
    const outNode = nodeOf(fix, "cccs1:out+");
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(-5.0, 4);

    const cccsEl = fix.element("cccs1");
    fix.coordinator.setComponentProperty(cccsEl, "currentGain", 2);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).not.toBeCloseTo(before);
    expect(after).toBeCloseTo(-10.0, 4);
  });

  it("hotload_vs_drives_isense_changes_output", () => {
    // Cat 4 sibling: changing the source voltage on the upstream Vs changes
    // I_sense and therefore V(rload+). With gain=1, Rsense=Rload=1kΩ
    // (SPICE F convention):
    //   start Vs=5V → V(rload+)=-5V; after Vs=2V → V(rload+)=-2V.
    const fix = buildFixture({
      build: (_r, facade) => buildCccsCircuit(facade, {
        vsVoltage: 5.0, rSense: 1000, rLoad: 1000, currentGain: 1,
      }),
    });
    const outNode = nodeOf(fix, "cccs1:out+");
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(-5.0, 4);

    fix.coordinator.setSourceByLabel("vs1", "voltage", 2.0);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).not.toBeCloseTo(before);
    expect(after).toBeCloseTo(-2.0, 4);
  });
});

// ---------------------------------------------------------------------------
// CCCS — T3 harness: gain=1 mirror vs ngspice (Cat 2-numerical / 3 / 5)
// ---------------------------------------------------------------------------

describeIfDll("CCCS gain=1 mirror paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_MIRROR, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_mirror", async () => {
    // First it() owns the run; tStop=1e-4 s, maxStep=1e-6 s.
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_mirror", () => {
    // Cat 2-numerical: reads from the recorded session (step 0 = DCOP seed).
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_mirror", () => {
    // Cat 5: all NR iterations across all steps.
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// CCCS — T3 harness: gain=10 amplification vs ngspice (Cat 2-numerical / 3 / 5)
// Same structural-parity NUMERICAL failure expected for the same reason.
// ---------------------------------------------------------------------------

describeIfDll("CCCS gain=10 amplification paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_GAIN10, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_gain10", async () => {
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_gain10", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_gain10", () => {
    session.compareAllAttempts();
  });
});
