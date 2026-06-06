import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
  DLL_PATH,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

import type { Circuit } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// DTS fixture paths (T3 harness)
// ---------------------------------------------------------------------------

const DTS_LINEAR = path.resolve(
  "src/components/active/__tests__/fixtures/vccs-canon-linear.dts",
);

// ---------------------------------------------------------------------------
// Circuit factory (T1 programmatic)
// ---------------------------------------------------------------------------
//
// Topology:
//   Vs:pos --> vccs:ctrl+      vccs:out+ --> Rload:pos
//   Vs:neg --> GND             Rload:neg --> GND
//   vccs:ctrl- --> GND         vccs:out-  --> GND
//
// Linear default: I_out = transconductance * V(ctrl).
// Nonlinear: when `expression` differs from "V(ctrl)", I_out = f(V(ctrl)).
// V_ctrl = Vs (since ctrl- is grounded).
//
// SPICE G-element convention (ngspice vccsload.c, matched bit-exact by
// digiTS as of the Norton-stamp sign fix): current of magnitude I_out flows
// FROM out+ THROUGH the source TO out-. With out- grounded and rload between
// out+ and GND, the external current loop runs GND -> rload -> out+ -> source
// -> out- -> GND. The resistor therefore sees current flowing from rload:neg
// (GND) UP to rload:pos (out+), which under passive-element conventions
// means V(rload:pos) is BELOW GND: V(out+) = -I_out * Rload.

interface VccsCircuitParams {
  vsVoltage?: number;
  rLoad?: number;
  transconductance?: number;
  expression?: string;
}

function buildVccsCircuit(facade: DefaultSimulatorFacade, p: VccsCircuitParams): Circuit {
  const vccsProps: Record<string, string | number> = {
    label: "vccs1",
  };
  if (p.expression !== undefined) vccsProps.expression = p.expression;
  if (p.transconductance !== undefined) vccsProps.transconductance = p.transconductance;
  return facade.build({
    components: [
      { id: "vs",    type: "DcVoltageSource", props: { label: "vs1",   voltage: p.vsVoltage ?? 1.0 } },
      { id: "vccs",  type: "VCCS",            props: vccsProps },
      { id: "rload", type: "Resistor",        props: { label: "rload", resistance: p.rLoad ?? 100 } },
      { id: "gnd",   type: "Ground" },
    ],
    connections: [
      ["vs:pos",      "vccs:ctrl+"],
      ["vs:neg",      "gnd:out"],
      ["vccs:ctrl-",  "gnd:out"],
      ["vccs:out+",   "rload:pos"],
      ["vccs:out-",   "gnd:out"],
      ["rload:neg",   "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

function ceByLabel(fix: ReturnType<typeof buildFixture>, label: string): CircuitElement {
  for (const ce of fix.circuit.elementToCircuitElement.values()) {
    if (ce.getProperties().getOrDefault<string>("label", "") === label) return ce;
  }
  throw new Error(`CircuitElement with label '${label}' not found`);
}

// ---------------------------------------------------------------------------
// VCCS — Cat 1 initialization (T1)
// ---------------------------------------------------------------------------

describe("VCCS initialization (T1)", () => {
  it("init_post_warm_start_node_voltages_match_dcop_linear", () => {
    // Cat 1: post-warm-start node voltage at vccs1:out+ must equal the
    // DCOP-seeded value. With Vs=1V, gm=0.01 S, Rload=100Ω:
    //   V_ctrl = 1V → I_out = 0.01*1 = 10mA flowing out+ → out- (SPICE G).
    //   Through Rload to GND on the external loop, V(out+) = -10mA*100Ω = -1V.
    const fix = buildFixture({
      build: (_r, facade) => buildVccsCircuit(facade, {
        vsVoltage: 1.0, transconductance: 0.01, rLoad: 100,
      }),
    });
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vccs1:ctrl+"))).toBeCloseTo(1.0, 6);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vccs1:out+"))).toBeCloseTo(-1.0, 6);
  });
});

// ---------------------------------------------------------------------------
// VCCS — Cat 2 DCOP analytical (T1)
// ---------------------------------------------------------------------------

describe("VCCS DCOP analytical (T1)", () => {
  it("dcop_linear_transconductance", () => {
    // gm=0.01 S, V_ctrl=1V → I_out=10mA, R_load=100Ω.
    // SPICE G convention: V(out+) = -gm * V_ctrl * R = -1.0 V.
    const fix = buildFixture({
      build: (_r, facade) => buildVccsCircuit(facade, {
        vsVoltage: 1.0, transconductance: 0.01, rLoad: 100,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "vccs1:out+"));
    expect(vOut).toBeCloseTo(-1.0, 6);
  });

  it("dcop_zero_control_zero_output", () => {
    // V_ctrl=0 → I_out=0 → V_out=0V across any load.
    const fix = buildFixture({
      build: (_r, facade) => buildVccsCircuit(facade, {
        vsVoltage: 0.0, transconductance: 0.01, rLoad: 1000,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "vccs1:out+"));
    expect(vOut).toBeCloseTo(0.0, 9);
  });

  it("dcop_nonlinear_square_law", () => {
    // expression: 0.001 * V(ctrl)^2; V_ctrl=3V → I_out = 0.001*9 = 9mA.
    // R_load=100Ω. SPICE G convention: V(out+) = -9mA*100 = -0.9V.
    const fix = buildFixture({
      build: (_r, facade) => buildVccsCircuit(facade, {
        vsVoltage: 3.0, expression: "0.001 * V(ctrl)^2", rLoad: 100,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "vccs1:out+"));
    expect(vOut).toBeCloseTo(-0.9, 6);
  });
});

// ---------------------------------------------------------------------------
// VCCS — Cat 4 parameter hot-load (T1)
// ---------------------------------------------------------------------------

describe("VCCS parameter hot-load (T1)", () => {
  it("hotload_transconductance_changes_output_voltage", () => {
    // Cat 4: setComponentProperty on transconductance must change V(rload+).
    // Start gm=0.01 S, Vs=1V, Rload=100Ω → V(out+)=-1V (SPICE G convention).
    // After gm=0.02 S → I_out=20mA → V(out+)=-2V.
    const fix = buildFixture({
      build: (_r, facade) => buildVccsCircuit(facade, {
        vsVoltage: 1.0, transconductance: 0.01, rLoad: 100,
      }),
    });
    const outNode = nodeOf(fix, "vccs1:out+");
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(-1.0, 6);

    const vccsEl = ceByLabel(fix, "vccs1");
    fix.coordinator.setComponentProperty(vccsEl, "transconductance", 0.02);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNode);
    // Documented contract: doubling gm doubles |V_out| for the linear default.
    expect(after).not.toBeCloseTo(before);
    expect(after).toBeCloseTo(-2.0, 6);
  });

  it("hotload_vs_drives_vctrl_changes_output", () => {
    // Cat 4 sibling: changing the upstream Vs voltage changes V(ctrl) and
    // therefore V(rload+). With gm=0.01 S, Rload=100Ω (SPICE G convention):
    //   start Vs=1V → V(out+)=-1V; after Vs=2V → V(out+)=-2V.
    const fix = buildFixture({
      build: (_r, facade) => buildVccsCircuit(facade, {
        vsVoltage: 1.0, transconductance: 0.01, rLoad: 100,
      }),
    });
    const outNode = nodeOf(fix, "vccs1:out+");
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(-1.0, 6);

    fix.coordinator.setSourceByLabel("vs1", "voltage", 2.0);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).not.toBeCloseTo(before);
    expect(after).toBeCloseTo(-2.0, 6);
  });
});

// ---------------------------------------------------------------------------
// VCCS — T3 harness: linear transconductance vs ngspice (Cat 2 / 3 / 5)
// ---------------------------------------------------------------------------

describeIfDll("VCCS linear transconductance paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_LINEAR, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_linear", async () => {
    // First it() owns the run; tStop=1e-4 s, maxStep=1e-6 s.
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_linear", () => {
    // Cat 2-numerical: reads from the recorded session (step 0 = DCOP seed).
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_linear", () => {
    // Cat 5: all NR iterations across all attempts of all steps.
    session.compareAllAttempts();
  });
});
