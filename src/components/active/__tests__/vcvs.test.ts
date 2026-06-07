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

const DTS_GAIN1 = path.resolve(
  "src/components/active/__tests__/fixtures/vcvs-canon-gain1.dts",
);
const DTS_GAIN10 = path.resolve(
  "src/components/active/__tests__/fixtures/vcvs-canon-gain10.dts",
);

// ---------------------------------------------------------------------------
// Circuit factory (T1 programmatic)
// ---------------------------------------------------------------------------
//
// Topology (linear-gain shape):
//   Vs:pos --> vcvs:ctrl+
//   Vs:neg --> GND
//   vcvs:ctrl- --> GND
//   vcvs:out+  --> Rload --> GND
//   vcvs:out-  --> GND
//
// V_ctrl = V(vs)
// V_out  = gain * V_ctrl  (default expression "V(ctrl)" -> gain * V(ctrl))
// V(rload+) = V_out (output is an ideal voltage source; load draws I_out
//                    through the branch row but does not change V_out).

interface VcvsCircuitParams {
  vsVoltage?: number;
  rLoad?: number;
  gain?: number;
  expression?: string;
}

function buildVcvsCircuit(facade: DefaultSimulatorFacade, p: VcvsCircuitParams): Circuit {
  const vcvsProps: Record<string, string | number> = {
    label: "vcvs1",
    expression: p.expression ?? "V(ctrl)",
    gain: p.gain ?? 1.0,
  };
  return facade.build({
    components: [
      { id: "vs",    type: "DcVoltageSource", props: { label: "vs1",   voltage: p.vsVoltage ?? 1.0 } },
      { id: "vcvs",  type: "VCVS",            props: vcvsProps },
      { id: "rload", type: "Resistor",        props: { label: "rload", resistance: p.rLoad ?? 1000 } },
      { id: "gnd",   type: "Ground" },
    ],
    connections: [
      ["vs:pos",     "vcvs:ctrl+"],
      ["vs:neg",     "gnd:out"],
      ["vcvs:ctrl-", "gnd:out"],
      ["vcvs:out+",  "rload:pos"],
      ["rload:neg",  "gnd:out"],
      ["vcvs:out-",  "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ---------------------------------------------------------------------------
// Category 1 - Initialization (T1)
// VCVS holds no StatePool slots (linear voltage source with no charge / no
// rolled state). The post-warm-start observable is the node voltage at the
// output port: after one coordinator.step() the engine has solved the DCOP
// for the four-terminal VCVS and the output node sits at gain * V(ctrl).
// ---------------------------------------------------------------------------

describe("VCVS initialization (T1)", () => {
  it("init_warm_start_output_node_seeded", () => {
    // Vs=3.3V, gain=1 -> V_out = 3.3V. After buildFixture's warm-start step,
    // engine.getNodeVoltage on the VCVS out+ node must equal 3.3V.
    const fix = buildFixture({
      build: (_r, facade) => buildVcvsCircuit(facade, {
        vsVoltage: 3.3, gain: 1.0, rLoad: 1000,
      }),
    });
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "vcvs1:out+"));
    expect(vOut).toBeCloseTo(3.3, 4);
  });
});

// ---------------------------------------------------------------------------
// Category 2 analytical - DC operating point (T1)
// Closed-form V_out = gain * V_ctrl, exercised across multiple operating
// regimes so the linear DCOP solve is verified outside the trivial
// single-point case.
// ---------------------------------------------------------------------------

describe("VCVS DCOP analytical (T1)", () => {
  it("dcop_unity_gain_buffer_3v3", () => {
    // gain=1, Vs=3.3V -> V_out = 3.3V.
    const fix = buildFixture({
      build: (_r, facade) => buildVcvsCircuit(facade, {
        vsVoltage: 3.3, gain: 1.0, rLoad: 1000,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "vcvs1:out+"));
    expect(vOut).toBeCloseTo(3.3, 4);
  });

  it("dcop_gain_of_10_amplification", () => {
    // gain=10, Vs=0.5V -> V_out = 5.0V.
    const fix = buildFixture({
      build: (_r, facade) => buildVcvsCircuit(facade, {
        vsVoltage: 0.5, gain: 10.0, rLoad: 1000,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "vcvs1:out+"));
    expect(vOut).toBeCloseTo(5.0, 4);
  });

  it("dcop_zero_input_zero_output", () => {
    // Vs=0V -> V_ctrl=0 -> V_out=0V. The NR-linearized RHS contribution
    // `value - derivative * ctrlValue` is exactly 0 at this operating point.
    const fix = buildFixture({
      build: (_r, facade) => buildVcvsCircuit(facade, {
        vsVoltage: 0.0, gain: 1.0, rLoad: 1000,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "vcvs1:out+"));
    expect(vOut).toBeCloseTo(0.0, 6);
  });

  it("dcop_nonlinear_expression_quadratic_in_vctrl", () => {
    // expression: 0.5 * V(ctrl)^2; Vs=2V -> V_ctrl=2V.
    // V_out = 0.5 * 4 = 2.0V.
    const fix = buildFixture({
      build: (_r, facade) => buildVcvsCircuit(facade, {
        vsVoltage: 2.0, expression: "0.5 * V(ctrl)^2", rLoad: 1000,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "vcvs1:out+"));
    expect(vOut).toBeCloseTo(2.0, 4);
  });

  it("dcop_output_drives_load_independent_of_rload", () => {
    // The VCVS out+ port is an ideal voltage source: V_out is enforced by
    // the branch equation regardless of load. With Vs=1V, gain=10, R load
    // of 1kOhm: V_out = 10V independent of the resistor's value.
    const fix = buildFixture({
      build: (_r, facade) => buildVcvsCircuit(facade, {
        vsVoltage: 1.0, gain: 10.0, rLoad: 1000,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "vcvs1:out+"));
    expect(vOut).toBeCloseTo(10.0, 4);
  });
});

// ---------------------------------------------------------------------------
// Category 4 - Parameter hot-load (T1)
// Hot-load coverage: `gain` is the sole structural parameter declared on
// the VCVS modelRegistry.behavioral.paramDefs (VCVS_PARAM_DEFS). VCVS has
// no TEMP / AREA / derived-state recompute parameters - it is a stamp-only
// element with no temperature-dependent state. One it() suffices for the
// structural-parameter group.
// ---------------------------------------------------------------------------

describe("VCVS parameter hot-load (T1)", () => {
  it("hotload_gain_changes_output_voltage", () => {
    // Initial gain=1, Vs=2V -> V_out=2V.
    // After setComponentProperty("gain", 5), V_out should move toward 10V
    // (per project policy: model params are hot-loadable via setParam).
    const fix = buildFixture({
      build: (_r, facade) => buildVcvsCircuit(facade, {
        vsVoltage: 2.0, gain: 1.0, rLoad: 1000,
      }),
    });

    const outNode = nodeOf(fix, "vcvs1:out+");
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(2.0, 4);

    const vcvsEl = fix.element("vcvs1");
    fix.coordinator.setComponentProperty(vcvsEl, "gain", 5);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).not.toBeCloseTo(before);
    // Closed-form post-change: V_out = 5 * 2 = 10V.
    expect(after).toBeCloseTo(10.0, 4);
  });

  it("hotload_vs_drives_vctrl_changes_output", () => {
    // Cat 4 sibling: changing the source voltage on the upstream Vs changes
    // V_ctrl and therefore V_out. With gain=2: start Vs=1V -> V_out=2V;
    // after Vs=3V -> V_out=6V.
    const fix = buildFixture({
      build: (_r, facade) => buildVcvsCircuit(facade, {
        vsVoltage: 1.0, gain: 2.0, rLoad: 1000,
      }),
    });
    const outNode = nodeOf(fix, "vcvs1:out+");
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(2.0, 4);

    fix.coordinator.setSourceByLabel("vs1", "voltage", 3.0);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).not.toBeCloseTo(before);
    expect(after).toBeCloseTo(6.0, 4);
  });
});

// ---------------------------------------------------------------------------
// VCVS - T3 harness: gain=1 unity buffer vs ngspice (Cat 2-numerical / 3 / 5)
// ---------------------------------------------------------------------------

describeIfDll("VCVS gain=1 unity buffer paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_GAIN1, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_gain1", async () => {
    // First it() owns the run; tStop=1e-4 s, maxStep=1e-6 s.
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_gain1", () => {
    // Cat 2-numerical: reads from the recorded session (step 0 = DCOP seed).
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_gain1", () => {
    // Cat 5: all NR iterations across all steps.
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// VCVS - T3 harness: gain=10 amplification vs ngspice (Cat 2-numerical / 3 / 5)
// ---------------------------------------------------------------------------

describeIfDll("VCVS gain=10 amplification paired vs ngspice (T3)", () => {
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
