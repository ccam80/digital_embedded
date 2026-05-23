import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { MEMRISTOR_SCHEMA, MemristorElement } from "../memristor.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { Circuit } from "../../../core/circuit.js";

// ---------------------------------------------------------------------------
// Slot indices (resolved via schema lookup)
// ---------------------------------------------------------------------------

const SLOT_W = MEMRISTOR_SCHEMA.indexOf.get("W")!;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const R_ON  = 100;
const R_OFF = 16000;

// ---------------------------------------------------------------------------
// .dts paths
// ---------------------------------------------------------------------------

const DTS_DC_MID_STATE  = path.resolve("src/components/passives/__tests__/fixtures/memristor-canon-dc-mid-state.dts");
const DTS_DC_EDGE_STATE = path.resolve("src/components/passives/__tests__/fixtures/memristor-canon-dc-edge-state.dts");

// ---------------------------------------------------------------------------
// Programmatic circuit factories
// ---------------------------------------------------------------------------

interface MemristorDcCircuitParams {
  vSource: number;
  rSeries: number;
  initialState?: number;
  rOn?: number;
  rOff?: number;
  mobility?: number;
  deviceLength?: number;
  windowOrder?: number;
}

/**
 * VS -> rSeries -> memristor -> GND. Voltage divider at memristor node lets us
 * infer the memristor resistance from the public engine surface:
 *   R_mem = V(memNode) * rSeries / (vSource - V(memNode))
 */
function buildMemristorDcCircuit(facade: DefaultSimulatorFacade, p: MemristorDcCircuitParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "vs", voltage: p.vSource } },
      { id: "rs",  type: "Resistor",        props: { label: "rs", resistance: p.rSeries } },
      { id: "mem", type: "Memristor",       props: {
          label:        "mem",
          model:        "behavioral",
          rOn:          p.rOn          ?? R_ON,
          rOff:         p.rOff         ?? R_OFF,
          initialState: p.initialState ?? 0.5,
          mobility:     p.mobility     ?? 1e-14,
          deviceLength: p.deviceLength ?? 10e-9,
          windowOrder:  p.windowOrder  ?? 1,
      } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos",  "rs:pos"],
      ["rs:neg",  "mem:pos"],
      ["mem:neg", "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });
}

function findMemristor(elements: ReadonlyArray<unknown>): MemristorElement {
  const idx = elements.findIndex((el) => el instanceof MemristorElement);
  if (idx < 0) throw new Error("MemristorElement not found in compiled circuit");
  return elements[idx] as MemristorElement;
}

function findMemristorIndex(fix: ReturnType<typeof buildFixture>): number {
  const idx = fix.circuit.elements.findIndex((el) => el instanceof MemristorElement);
  if (idx < 0) throw new Error("MemristorElement not found in compiled circuit");
  return idx;
}

function getMemristorCe(fix: ReturnType<typeof buildFixture>) {
  const idx = findMemristorIndex(fix);
  const ce = fix.circuit.elementToCircuitElement.get(idx);
  if (ce === undefined) throw new Error("CircuitElement not found for MemristorElement");
  return ce;
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Post-warm-start: SLOT_W contains initialState; node voltage tracks the
// linear-G voltage divider.
// ---------------------------------------------------------------------------

describe("Memristor initialization (T1)", () => {
  it("init_w_slot_seeded_from_initial_state_mid", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildMemristorDcCircuit(facade, {
        vSource: 1, rSeries: 200, initialState: 0.5,
      }),
    });
    const mem = findMemristor(fix.circuit.elements);

    // Post-warm-start state0[W] holds the seeded initialState.
    const w0 = fix.pool.state0[mem._stateBase + SLOT_W];
    expect(w0).toBeCloseTo(0.5, 9);

    // Memristor node tracks the linear-G voltage divider:
    //   G(0.5) = 0.5*(1/R_on - 1/R_off) + 1/R_off ~ 0.005031 S -> R ~ 198.76 Ohm
    //   V_mem = V_src * R_mem / (R_series + R_mem) = 1 * 198.76/(200+198.76) ~ 0.4984 V
    const expectedRMem = 1 / (0.5 * (1 / R_ON - 1 / R_OFF) + 1 / R_OFF);
    const expectedV = 1 * expectedRMem / (200 + expectedRMem);
    const vMem = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("mem:pos")!);
    expect(vMem).toBeCloseTo(expectedV, 3);
  });

  it("init_w_slot_seeded_from_initial_state_edge", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildMemristorDcCircuit(facade, {
        vSource: 1, rSeries: 200, initialState: 0.05,
      }),
    });
    const mem = findMemristor(fix.circuit.elements);

    const w0 = fix.pool.state0[mem._stateBase + SLOT_W];
    expect(w0).toBeCloseTo(0.05, 9);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical)
// G(w) is the canonical stamp; voltage divider lets us infer R_mem from
// node voltage. Three w values (0, 0.5, 1) cover the boundary + interior.
// ---------------------------------------------------------------------------

describe("Memristor DCOP — linear-G voltage divider (T1)", () => {
  function rMemFromDcop(vSource: number, rSeries: number, initialState: number): number {
    const fix = buildFixture({
      build: (_r, facade) => buildMemristorDcCircuit(facade, {
        vSource, rSeries, initialState,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const vMem = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("mem:pos")!);
    return (vMem * rSeries) / (vSource - vMem);
  }

  it("dcop_w0_gives_R_off", () => {
    // G(0) = 1/R_off -> R_mem = R_off = 16 kOhm.
    const rMem = rMemFromDcop(10, R_OFF, 0.0);
    expect(rMem).toBeCloseTo(R_OFF, -1);
  });

  it("dcop_w1_gives_R_on", () => {
    // G(1) = 1/R_on -> R_mem = R_on = 100 Ohm.
    const rMem = rMemFromDcop(10, R_ON, 1.0);
    expect(rMem).toBeCloseTo(R_ON, 0);
  });

  it("dcop_w_half_gives_inverse_G_half", () => {
    // G(0.5) = 0.5*(1/R_on - 1/R_off) + 1/R_off ~ 0.005031 S -> R ~ 198.76 Ohm.
    const expectedR = 1 / (0.5 * (1 / R_ON - 1 / R_OFF) + 1 / R_OFF);
    const rMem = rMemFromDcop(10, 200, 0.5);
    expect(rMem).toBeCloseTo(expectedR, 0);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// Memristor params: rOn, rOff, initialState, mobility, deviceLength, windowOrder.
// Structural representatives:
//   - rOff: scales the w=0 conductance directly (DCOP node voltage moves)
//   - initialState: hard-resets W; DCOP node voltage shifts predictably
//   - mobility: scales dw/dt (transient W evolution rate)
// ---------------------------------------------------------------------------

describe("Memristor parameter hot-load (T1)", () => {
  it("hotload_rOff_changes_dcop_voltage_at_w0", () => {
    // w=0 -> R_mem = rOff. Default rOff=16000, R_series=16000 -> V_mem = V_src/2 = 5V.
    // After hotload rOff=4000 -> V_mem = 10 * 4000/(16000+4000) = 2V.
    const fix = buildFixture({
      build: (_r, facade) => buildMemristorDcCircuit(facade, {
        vSource: 10, rSeries: R_OFF, initialState: 0.0,
      }),
    });
    const nMem = fix.circuit.labelToNodeId.get("mem:pos")!;
    const before = fix.engine.getNodeVoltage(nMem);
    expect(before).toBeCloseTo(5, 1);

    fix.coordinator.setComponentProperty(getMemristorCe(fix), "rOff", 4000);
    fix.coordinator.dcOperatingPoint();

    const after = fix.engine.getNodeVoltage(nMem);
    // Closed-form: V_mem = 10 * 4000/(16000+4000) = 2V.
    expect(after).toBeCloseTo(2, 1);
    expect(after).toBeLessThan(before);
  });

  it("hotload_initialState_resets_W_slot_and_dcop_voltage", () => {
    // Start at w=0.5 then hot-load to w=0.0 (R_mem = R_off = 16000).
    // Pair with R_series=200 so the divider shifts noticeably.
    const fix = buildFixture({
      build: (_r, facade) => buildMemristorDcCircuit(facade, {
        vSource: 1, rSeries: 200, initialState: 0.5,
      }),
    });
    const mem = findMemristor(fix.circuit.elements);
    const nMem = fix.circuit.labelToNodeId.get("mem:pos")!;

    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nMem);
    // w=0.5: V_mem ~ 0.4984 V (mid-state divider).
    expect(before).toBeCloseTo(0.4984, 2);

    fix.coordinator.setComponentProperty(getMemristorCe(fix), "initialState", 0.0);
    // SLOT_W must be reset to the new initialState.
    expect(fix.pool.state1[mem._stateBase + SLOT_W]).toBeCloseTo(0.0, 9);

    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nMem);
    // w=0 -> R_mem=16000 -> V_mem = 1 * 16000/(200+16000) ~ 0.9877 V.
    expect(after).toBeCloseTo(1 * R_OFF / (200 + R_OFF), 2);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_mobility_changes_transient_W_evolution_rate", () => {
    // mobility scales dw/dt linearly. Larger mobility -> larger W shift over
    // the same transient interval. Documented contract: positive drive +
    // higher mobility -> larger DELTA-w over the same window.
    const fixLow = buildFixture({
      build: (_r, facade) => buildMemristorDcCircuit(facade, {
        vSource: 10, rSeries: 100, initialState: 0.5,
        rOn: R_ON, rOff: R_OFF, deviceLength: 3e-9, mobility: 1e-15,
      }),
      params: { tStop: 5e-6, maxTimeStep: 1e-7 },
    });
    const memLow = findMemristor(fixLow.circuit.elements);
    while (fixLow.engine.simTime! < 4e-6) fixLow.coordinator.step();
    const dwLow = fixLow.pool.state1[memLow._stateBase + SLOT_W] - 0.5;

    const fixHigh = buildFixture({
      build: (_r, facade) => buildMemristorDcCircuit(facade, {
        vSource: 10, rSeries: 100, initialState: 0.5,
        rOn: R_ON, rOff: R_OFF, deviceLength: 3e-9, mobility: 1e-13,
      }),
      params: { tStop: 5e-6, maxTimeStep: 1e-7 },
    });
    const memHigh = findMemristor(fixHigh.circuit.elements);
    while (fixHigh.engine.simTime! < 4e-6) fixHigh.coordinator.step();
    const dwHigh = fixHigh.pool.state1[memHigh._stateBase + SLOT_W] - 0.5;

    // Both directional positive (positive drive increases W), and the
    // higher-mobility shift is strictly larger.
    expect(dwLow).toBeGreaterThan(0);
    expect(dwHigh).toBeGreaterThan(0);
    expect(dwHigh).toBeGreaterThan(dwLow);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 — Paired vs ngspice (T3) on mid-state regime
// One ComparisonSession per .dts; the run lives in the first it(), step-end
// and per-iteration siblings read the recorded session.
// ---------------------------------------------------------------------------

describeIfDll("Memristor mid-state vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_DC_MID_STATE, analysis: "tran", tStop: 1e-5, maxStep: 1e-7 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_mid_state", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_mid_state", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_mid_state", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 — Paired vs ngspice (T3) on edge-state regime
// ---------------------------------------------------------------------------

describeIfDll("Memristor edge-state vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_DC_EDGE_STATE, analysis: "tran", tStop: 1e-5, maxStep: 1e-7 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_edge_state", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_edge_state", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_edge_state", () => {
    session.compareAllAttempts();
  });
});
