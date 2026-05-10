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
// DTS fixture paths (T3 harness) — authored under fixtures/ for this canon.
// ---------------------------------------------------------------------------

// ISRC=10mA → R=1k → GND. Static resistive operating region: at DCOP, the
// node voltage is V = I*R = 10V; the transient run is flat (no reactive
// elements, no dt selection drama). Exercises the ISRC RHS-only stamp at a
// fixed terminal voltage every iteration.
const DTS_R_LOAD = path.resolve(
  "src/components/sources/__tests__/fixtures/current-source-canon-r-load.dts",
);

// ISRC=1mA charging 1uF cap with 10k bleed → GND. Dynamic regime: node
// voltage rises across the transient with tau=RC=10ms toward the steady-state
// V_inf = I*R = 10V. Exercises the ISRC RHS stamp under varying terminal
// voltage across iterations and steps so per-iter sweeps catch any drift.
const DTS_RC_CHARGE = path.resolve(
  "src/components/sources/__tests__/fixtures/current-source-canon-rc-charge.dts",
);

// ---------------------------------------------------------------------------
// Programmatic circuit factory (T1)
// ---------------------------------------------------------------------------
//
// ISRC → R → GND. Closed-form: V(node) = I * R at DCOP convergence.

interface IsrcCircuitParams {
  current?: number;
  resistance?: number;
}

function buildIsrcCircuit(facade: DefaultSimulatorFacade, p: IsrcCircuitParams): Circuit {
  return facade.build({
    components: [
      { id: "isrc", type: "DcCurrentSource", props: { label: "isrc", current: p.current ?? 0.01 } },
      { id: "r1",   type: "Resistor",      props: { label: "r1",   resistance: p.resistance ?? 1000 } },
      { id: "gnd",  type: "Ground",        props: { label: "gnd" } },
    ],
    connections: [
      ["isrc:pos", "r1:pos"],
      ["r1:neg",   "gnd:out"],
      ["isrc:neg", "gnd:out"],
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
// CurrentSource initialization (T1) — Cat 1
// ---------------------------------------------------------------------------
//
// CurrentSourceAnalogImpl has no state-pool slots and no internal nodes
// (ngspice ISRC has no *set.c — setup() is intentionally empty). The Cat 1
// post-warm-start observable is therefore the converged node voltage at
// step 0: V(node) = I * R with the source delivering current into a load.

describe("CurrentSource initialization (T1)", () => {
  it("init_post_warm_start_node_voltage_seeded_to_dcop_value", () => {
    // ISRC=10mA into R=1k → V(node) = 0.01 * 1000 = 10V at step 0.
    const fix = buildFixture({
      build: (_r, facade) => buildIsrcCircuit(facade, { current: 0.01, resistance: 1000 }),
    });
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "isrc:pos"))).toBeCloseTo(10, 6);
  });
});

// ---------------------------------------------------------------------------
// CurrentSource DCOP analytical (T1) — Cat 2 analytical
// ---------------------------------------------------------------------------

describe("CurrentSource DCOP analytical (T1)", () => {
  it("dcop_node_voltage_equals_I_times_R", () => {
    // Cat 2 analytical: V(node) = I * R after DCOP convergence (KCL).
    // ISRC=2mA into R=1k → V = 2V.
    const fix = buildFixture({
      build: (_r, facade) => buildIsrcCircuit(facade, { current: 0.002, resistance: 1000 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const vNode = fix.engine.getNodeVoltage(nodeOf(fix, "isrc:pos"));
    expect(vNode).toBeCloseTo(2.0, 9);
  });

  it("dcop_negative_current_reverses_node_polarity", () => {
    // ISRC=-5mA into R=2k → V = -10V. The sign path through the RHS stamp
    // (positive into pos node, negative into neg node) reverses polarity
    // when the source current is negative.
    const fix = buildFixture({
      build: (_r, facade) => buildIsrcCircuit(facade, { current: -0.005, resistance: 2000 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const vNode = fix.engine.getNodeVoltage(nodeOf(fix, "isrc:pos"));
    expect(vNode).toBeCloseTo(-10.0, 9);
  });
});

// ---------------------------------------------------------------------------
// CurrentSource parameter hot-load (T1) — Cat 4
// ---------------------------------------------------------------------------
//
// CurrentSource params: current (primary, only). No TEMP / AREA / SCALE on
// this component (a single setParam path for "current" updates the cached
// value used in the RHS stamp). One it() covers the only param.

describe("CurrentSource parameter hot-load (T1)", () => {
  it("hotload_current_changes_node_voltage", () => {
    // Cat 4: ISRC=10mA, R=1k → V=10V before. Hot-load current=20mA → V=20V.
    const fix = buildFixture({
      build: (_r, facade) => buildIsrcCircuit(facade, { current: 0.01, resistance: 1000 }),
    });
    const node = nodeOf(fix, "isrc:pos");
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(node);
    expect(before).toBeCloseTo(10.0, 6);

    const isrcEl = ceByLabel(fix, "isrc");
    fix.coordinator.setComponentProperty(isrcEl, "current", 0.02);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(node);

    expect(after).not.toBeCloseTo(before, 4);
    expect(after).toBeCloseTo(20.0, 6);
  });
});

// ---------------------------------------------------------------------------
// CurrentSource paired vs ngspice — resistive load (T3) — Cat 2 num / 3 / 5
// ---------------------------------------------------------------------------
//
// Per Step 2c: the harness RUN lives in the FIRST it() of the describe
// (transient run); subsequent siblings read from the recorded session.

describeIfDll("CurrentSource paired vs ngspice — resistive load (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_R_LOAD, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_r_load", async () => {
    await session.runTransient(0, 1e-3, 10e-6);
    session.compareAllSteps();
  }, 120_000);

  it("dcop_paired_r_load", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_r_load", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// CurrentSource paired vs ngspice — RC charge (T3) — Cat 2 num / 3 / 5
// ---------------------------------------------------------------------------
//
// A second operating-region configuration: ISRC charging a capacitor through
// a bleed resistor. Without this dynamic-regime fixture, the resistive-load
// .dts (static across the transient) hides any per-step drift in the ISRC
// RHS stamp under varying terminal voltage as V_cap rises toward I*R.

describeIfDll("CurrentSource paired vs ngspice — RC charge (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_RC_CHARGE, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_rc_charge", async () => {
    // tau = RC = 10k * 1uF = 10ms. Run to t=20ms (~2 tau) with a fine maxStep.
    await session.runTransient(0, 20e-3, 50e-6);
    session.compareAllSteps();
  }, 180_000);

  it("dcop_paired_rc_charge", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_rc_charge", () => {
    session.compareAllAttempts();
  });
});
