import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
  DLL_PATH,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { ResistorElement } from "../resistor.js";

import type { Circuit } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// DTS fixture paths (T3 harness) — reused, not authored.
// ---------------------------------------------------------------------------

// Pure resistive divider: V1=5V, R1=1k (in→mid), R2=1k (mid→gnd).
// Exercises the resistor in DCOP and a flat resistive transient: the linear
// stamp every iteration, single iter per step, uniform dt.
const DTS_RESISTIVE_DIVIDER = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/resistive-divider.dts",
);

// RC transient: pulse source → R1=1k → C1=1uF → gnd. Exercises the resistor
// in a non-trivial dynamic regime where node voltages vary across the
// transient (unlike the static divider) so per-step / per-iteration sweeps
// catch any drift in the resistor's stamp under varying terminal voltages.
const DTS_RC_TRANSIENT = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/rc-transient.dts",
);

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1)
// ---------------------------------------------------------------------------
//
// Voltage divider: VS → R1 → mid → R2 → GND. Closed-form:
//   V(mid) = VS * R2 / (R1 + R2)
// Pin currents: I = V/R, opposite signs at the two pins.

interface DividerParams {
  vSource?: number;
  R1?: number;
  R2?: number;
}

function buildDividerCircuit(facade: DefaultSimulatorFacade, p: DividerParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "vs", voltage: p.vSource ?? 10 } },
      { id: "r1",  type: "Resistor",        props: { label: "r1", resistance: p.R1 ?? 1000 } },
      { id: "r2",  type: "Resistor",        props: { label: "r2", resistance: p.R2 ?? 2000 } },
      { id: "gnd", type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos", "r1:pos"],
      ["r1:neg", "r2:pos"],
      ["r2:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
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

function findResistorIndex(fix: ReturnType<typeof buildFixture>, label: string): number {
  for (const [idx, ce] of fix.circuit.elementToCircuitElement.entries()) {
    if (
      ce instanceof ResistorElement &&
      ce.getProperties().getOrDefault<string>("label", "") === label
    ) {
      return idx;
    }
  }
  throw new Error(`ResistorElement with label '${label}' not found`);
}

// ---------------------------------------------------------------------------
// Resistor initialization (T1) — Cat 1
// ---------------------------------------------------------------------------
//
// ResistorAnalogElement has no state-pool slots (extends AnalogElement, not
// PoolBackedAnalogElement) — its only stamp-time state is the conductance
// G=1/R cached at construct / setParam time. The post-warm-start observable
// for Cat 1 is therefore the converged node voltage at step 0.

describe("Resistor initialization (T1)", () => {
  it("init_post_warm_start_node_voltage_seeded_to_dcop_value", () => {
    // Voltage divider VS=10V, R1=1k, R2=2k. After warm-start the mid node
    // sits at the DCOP-converged value 10 * 2000/(1000+2000) = 6.6666... V.
    const fix = buildFixture({
      build: (_r, facade) => buildDividerCircuit(facade, { vSource: 10, R1: 1000, R2: 2000 }),
    });
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(10, 6);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "r1:neg"))).toBeCloseTo(10 * 2000 / 3000, 6);
  });
});

// ---------------------------------------------------------------------------
// Resistor DCOP analytical (T1) — Cat 2 analytical
// ---------------------------------------------------------------------------

describe("Resistor DCOP analytical (T1)", () => {
  it("dcop_voltage_divider_node_and_pin_currents_match_closed_form", () => {
    // Cat 2 analytical: V(mid) = VS * R2/(R1+R2) = 10*2000/3000.
    // Top of divider held to VS=10V by the source.
    // Pin currents: I = (V_pos - V_neg) / R, opposite signs at the two pins.
    //   For R1: I = (10 - 6.6666...) / 1000 = 3.3333...e-3 A.
    //   For R2: I = (6.6666... - 0) / 2000 = 3.3333...e-3 A.
    const fix = buildFixture({
      build: (_r, facade) => buildDividerCircuit(facade, { vSource: 10, R1: 1000, R2: 2000 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const vMid = fix.engine.getNodeVoltage(nodeOf(fix, "r1:neg"));
    expect(vMid).toBeCloseTo(10 * 2000 / 3000, 6);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(10, 6);

    const r1Idx = findResistorIndex(fix, "r1");
    const r2Idx = findResistorIndex(fix, "r2");
    const r1Pins = fix.engine.getElementPinCurrents(r1Idx);
    const r2Pins = fix.engine.getElementPinCurrents(r2Idx);
    const I = 10 / 3000; // closed-form: total loop current.
    expect(r1Pins[0]).toBeCloseTo(I, 9);
    expect(r1Pins[1]).toBeCloseTo(-I, 9);
    expect(r2Pins[0]).toBeCloseTo(I, 9);
    expect(r2Pins[1]).toBeCloseTo(-I, 9);
  });
});

// ---------------------------------------------------------------------------
// Resistor parameter hot-load (T1) — Cat 4
// ---------------------------------------------------------------------------
//
// Resistor params: resistance (primary, only). No TEMP / AREA / SCALE / M
// derived-state-recompute parameters on this component (a single setParam
// path for "resistance" recomputes G=1/R). One it() covers the only param.

describe("Resistor parameter hot-load (T1)", () => {
  it("hotload_resistance_changes_divider_midpoint_voltage", () => {
    // Cat 4: VS=10V, R1=1k, R2=2k → V(mid)=6.6666...V before.
    // Hot-load R2=8k → V(mid) = 10 * 8000/(1000+8000) = 8.8888...V.
    const fix = buildFixture({
      build: (_r, facade) => buildDividerCircuit(facade, { vSource: 10, R1: 1000, R2: 2000 }),
    });
    const midNode = nodeOf(fix, "r1:neg");
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(midNode);
    expect(before).toBeCloseTo(10 * 2000 / 3000, 6);

    const r2El = ceByLabel(fix, "r2");
    fix.coordinator.setComponentProperty(r2El, "resistance", 8000);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(midNode);

    expect(after).not.toBeCloseTo(before, 4);
    expect(after).toBeCloseTo(10 * 8000 / 9000, 6);
  });
});

// ---------------------------------------------------------------------------
// Resistor paired vs ngspice — resistive divider (T3) — Cat 2 num / 3 / 5
// ---------------------------------------------------------------------------
//
// Per Step 2c: the harness RUN lives in the FIRST it() of the describe
// (transient run); subsequent siblings read from the recorded session.

describeIfDll("Resistor paired vs ngspice — resistive divider (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_RESISTIVE_DIVIDER, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_resistive_divider", async () => {
    await session.runTransient(0, 1e-3, 10e-6);
    session.compareAllSteps();
  }, 120_000);

  it("dcop_paired_resistive_divider", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_resistive_divider", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Resistor paired vs ngspice — RC transient (T3) — Cat 2 num / 3 / 5
// ---------------------------------------------------------------------------
//
// A second operating-region configuration: resistor in a dynamic RC. Without
// this, the divider .dts (static across the transient) hides any per-step
// drift in the resistor's stamp under varying terminal voltages.

describeIfDll("Resistor paired vs ngspice — RC transient (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_RC_TRANSIENT, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_rc", async () => {
    await session.runTransient(0, 2e-3, 2e-6);
    session.compareAllSteps();
  }, 180_000);

  it("dcop_paired_rc", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_rc", () => {
    session.compareAllAttempts();
  });
});
