import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { DIODE_SCHEMA } from "../diode.js";

import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { Circuit } from "../../../core/circuit.js";

// ---------------------------------------------------------------------------
// .dts paths
// ---------------------------------------------------------------------------

const DTS_RESISTIVE = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/diode-resistor.dts",
);
const DTS_CAP_RC = path.resolve(
  "src/components/semiconductors/__tests__/fixtures/diode-canon-cap-rc.dts",
);

// ---------------------------------------------------------------------------
// Programmatic builders for T1 categories.
// Pin labels confirmed: DcVoltageSource pos/neg, AcVoltageSource pos/neg,
// Resistor pos/neg, Diode A/K, Ground out.
// ---------------------------------------------------------------------------

interface DiodeRcOpts {
  vSource: number;
  rValue: number;
  diodeProps?: Record<string, number>;
}

function buildDiodeRc(facade: DefaultSimulatorFacade, p: DiodeRcOpts): Circuit {
  return facade.build({
    components: [
      { id: "vs", type: "DcVoltageSource", props: { label: "vs", voltage: p.vSource } },
      { id: "r1", type: "Resistor", props: { label: "r1", resistance: p.rValue } },
      { id: "d1", type: "Diode", props: { label: "d1", ...(p.diodeProps ?? {}) } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "r1:pos"],
      ["r1:neg", "d1:A"],
      ["d1:K", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function findDiodeLeaf(fix: ReturnType<typeof buildFixture>): { idx: number } {
  const idx = fix.circuit.elements.findIndex(
    (_e, i) => fix.elementLabels.get(i) === "d1",
  );
  expect(idx).toBeGreaterThanOrEqual(0);
  return { idx };
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Single 5-slot DIODE_SCHEMA mirrors ngspice diodefs.h offsets and is allocated
// unconditionally per diosetup.c:199 (`*states += 5`). The Q/CCAP slots are
// unused when CJO=0 and TT=0, but always present.
// Asserts the post-warm-start state pool VD slot is finite and a converged
// junction node voltage exists at step 0.
// ---------------------------------------------------------------------------

describe("Diode initialization (T1)", () => {
  const SLOT_VD = DIODE_SCHEMA.indexOf.get("VD")!;
  const SLOT_Q  = DIODE_SCHEMA.indexOf.get("Q")!;

  it("init_resistive_vd_seeded", () => {
    const fix = buildFixture({
      build: (_r, f) => buildDiodeRc(f, { vSource: 5, rValue: 1000 }),
    });
    const { idx } = findDiodeLeaf(fix);
    const el = fix.circuit.elements[idx]!;
    const vd = fix.pool.state0[el._stateBase + SLOT_VD];
    expect(Number.isFinite(vd)).toBe(true);
    const vAnode = fix.engine.getNodeVoltage(
      fix.circuit.labelToNodeId.get("d1:A")!,
    );
    expect(Number.isFinite(vAnode)).toBe(true);
  });

  it("init_capacitive_vd_seeded", () => {
    const fix = buildFixture({
      build: (_r, f) => buildDiodeRc(f, {
        vSource: 5, rValue: 1000,
        diodeProps: { CJO: 1e-11, TT: 1e-9 },
      }),
    });
    const { idx } = findDiodeLeaf(fix);
    const el = fix.circuit.elements[idx]!;
    const vd = fix.pool.state0[el._stateBase + SLOT_VD];
    expect(Number.isFinite(vd)).toBe(true);
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_Q])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical sanity)
// 5V → 1kΩ → diode → GND. The closed-form Shockley solution at default
// parameters (IS=1e-14, N=1) sits at Vd ≈ 0.6929V, Id ≈ 4.31 mA. T3 paired
// vs ngspice is the bit-exact check (DTS_RESISTIVE session below).
// ---------------------------------------------------------------------------

describe("Diode DCOP analytical sanity (T1)", () => {
  it("dcop_resistive_forward_converges", () => {
    const fix = buildFixture({
      build: (_r, f) => buildDiodeRc(f, { vSource: 5, rValue: 1000 }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const vAnode = fix.engine.getNodeVoltage(
      fix.circuit.labelToNodeId.get("d1:A")!,
    );
    // Shockley at IS=1e-14, N=1, Vt≈25.85mV, R=1k, V=5: Vd ≈ 0.6929V
    expect(vAnode).toBeCloseTo(0.6929, 3);
    const id = (5 - vAnode) / 1000;
    expect(id).toBeCloseTo(4.307e-3, 5);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// One it() per parameter group:
//   - Primary structural: IS, N
//   - Secondary structural: RS, BV (junction)
//   - Derived-state-recompute: TEMP (universal), TNOM
//   - Instance scaling: AREA
// Assert the simulator output observably changed via the documented
// shift; never inspect property bag or internal element fields.
// ---------------------------------------------------------------------------

describe("Diode parameter hot-load (T1)", () => {
  function build5V1k(): ReturnType<typeof buildFixture> {
    return buildFixture({
      build: (_r, f) => buildDiodeRc(f, { vSource: 5, rValue: 1000 }),
    });
  }

  it("hotload_IS_changes_vd", () => {
    const fix = build5V1k();
    const ce = fix.element("d1");
    const vAnodeNode = fix.circuit.labelToNodeId.get("d1:A")!;
    const before = fix.engine.getNodeVoltage(vAnodeNode);
    fix.coordinator.setComponentProperty(ce, "IS", 1e-11);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(vAnodeNode);
    // Larger IS → smaller Vd at same current. Closed-form ΔV = N*Vt*ln(IS_old/IS_new).
    // ngspice ref at IS=1e-11 with default else: Vd ≈ 0.5153V.
    expect(after).toBeCloseTo(0.5153, 2);
    expect(after).toBeLessThan(before);
  });

  it("hotload_N_changes_vd", () => {
    const fix = build5V1k();
    const ce = fix.element("d1");
    const vAnodeNode = fix.circuit.labelToNodeId.get("d1:A")!;
    const before = fix.engine.getNodeVoltage(vAnodeNode);
    fix.coordinator.setComponentProperty(ce, "N", 2);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(vAnodeNode);
    // N=2: Vd ≈ 1.377V (ngspice ref). Vd rises (twice the thermal voltage scaling).
    expect(after).toBeCloseTo(1.377, 2);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_RS_changes_vd", () => {
    const fix = build5V1k();
    const ce = fix.element("d1");
    const vAnodeNode = fix.circuit.labelToNodeId.get("d1:A")!;
    const before = fix.engine.getNodeVoltage(vAnodeNode);
    // Series resistance RS adds a drop V_RS = Id*RS in series with the
    // junction. At 100Ω and Id≈4mA, V_RS ≈ 0.4V — Vd at the junction must
    // change observably (the anode pin sees the junction-plus-RS sum).
    fix.coordinator.setComponentProperty(ce, "RS", 100);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(vAnodeNode);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_AREA_changes_vd", () => {
    const fix = build5V1k();
    const ce = fix.element("d1");
    const vAnodeNode = fix.circuit.labelToNodeId.get("d1:A")!;
    const before = fix.engine.getNodeVoltage(vAnodeNode);
    // AREA scales IS by AREA; AREA=10 → Vd drops by N*Vt*ln(10) ≈ 60mV.
    fix.coordinator.setComponentProperty(ce, "AREA", 10);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(vAnodeNode);
    expect(after).not.toBeCloseTo(before, 3);
    expect(after).toBeLessThan(before);
  });

  it("hotload_TEMP_changes_vd", () => {
    // TEMP triggers dioTemp() recompute (tIS / vt / tVJ / tCJO / tVcrit / tBV).
    // Universal derived-state path required of every analog component with
    // temperature-dependent state.
    const fix = build5V1k();
    const ce = fix.element("d1");
    const vAnodeNode = fix.circuit.labelToNodeId.get("d1:A")!;
    const before = fix.engine.getNodeVoltage(vAnodeNode);
    fix.coordinator.setComponentProperty(ce, "TEMP", 400);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(vAnodeNode);
    // Raising TEMP increases tIS exponentially → Vd at fixed Id drops.
    expect(after).not.toBeCloseTo(before, 3);
    expect(after).toBeLessThan(before);
  });

  it("hotload_TNOM_changes_vd", () => {
    // TNOM is the parameter measurement reference temperature; changing it
    // re-derives the temperature scaling factor used in dioTemp(), even at
    // default operating TEMP.
    const fix = build5V1k();
    const ce = fix.element("d1");
    const vAnodeNode = fix.circuit.labelToNodeId.get("d1:A")!;
    const before = fix.engine.getNodeVoltage(vAnodeNode);
    fix.coordinator.setComponentProperty(ce, "TNOM", 350);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(vAnodeNode);
    expect(after).not.toBe(before);
  });

  it("hotload_BV_changes_reverse_breakdown_vd", () => {
    // Reverse-bias topology: drive anode below cathode, BV controls the
    // breakdown knee. Changing BV from default (Inf) to a finite value
    // shifts the reverse-Vd at substantial reverse current.
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vs", type: "DcVoltageSource", props: { label: "vs", voltage: 10 } },
          { id: "r1", type: "Resistor", props: { label: "r1", resistance: 1000 } },
          { id: "d1", type: "Diode", props: { label: "d1" } },
          { id: "gnd", type: "Ground" },
        ],
        // Cathode driven HIGH, anode pulled to GND through R: reverse bias.
        connections: [
          ["vs:pos", "d1:K"],
          ["d1:A", "r1:pos"],
          ["r1:neg", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
    });
    const ce = fix.element("d1");
    const vCathodeNode = fix.circuit.labelToNodeId.get("d1:K")!;
    const before = fix.engine.getNodeVoltage(vCathodeNode);
    fix.coordinator.setComponentProperty(ce, "BV", 5);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(vCathodeNode);
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Category 6 — Limiting events (T1, own engine)
// Diode load() invokes pnjlim on the AK junction during NR. Drive a strong
// forward bias circuit and assert the limiting collector recorded an AK
// junction visit at finite vBefore / vAfter.
// ---------------------------------------------------------------------------

describe("Diode limiting events own-engine (T1)", () => {
  it("limiting_pnjlim_fires_forward_bias", () => {
    const fix = buildFixture({
      build: (_r, f) => buildDiodeRc(f, { vSource: 5, rValue: 1000 }),
    });
    fix.coordinator.setLimitingCapture(true);
    fix.coordinator.dcOperatingPoint();
    const events = fix.coordinator.getLimitingEvents();
    const ak = events.find(e => e.label === "d1" && e.junction === "AK");
    expect(ak).toBeDefined();
    expect(ak!.limitType).toBe("pnjlim");
    expect(Number.isFinite(ak!.vBefore)).toBe(true);
    expect(Number.isFinite(ak!.vAfter)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 7 — LTE rollback (T1)
// Diode getLteTimestep() proposes dt over Q / CCAP slots only when capacitance
// is enabled (CJO > 0 OR TT > 0). Drive a sine-modulated cap-bearing diode
// and assert the rolled charge slot rotation invariant after warm-start.
// ---------------------------------------------------------------------------

describe("Diode LTE rollback (T1)", () => {
  it("lte_rollback_state_invariant", () => {
    const SLOT_Q = DIODE_SCHEMA.indexOf.get("Q")!;
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vs", type: "AcVoltageSource", props: {
            label: "vs", amplitude: 1, frequency: 1e6, waveform: "sine", dcOffset: 0,
          } },
          { id: "r1", type: "Resistor", props: { label: "r1", resistance: 1000 } },
          { id: "d1", type: "Diode", props: {
            label: "d1",
            // Activate the cap-driven LTE path: junction depletion + transit time.
            CJO: 1e-11, TT: 1e-9,
          } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg", "d1:A"],
          ["d1:K", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 1e-6, maxTimeStep: 1e-8 },
    });
    fix.coordinator.setConvergenceLogEnabled(true);
    for (let i = 0; i < 20; i++) fix.coordinator.step();
    const log = fix.coordinator.getConvergenceLog();
    expect(log).not.toBeNull();
    // Rotation invariant: state0 and state1 are populated post-warm-start
    // and remain finite for the rolled Q charge slot. cktTerr fires on these
    // slots; the LTE path is exercised when cap-bearing transients run.
    const { idx } = findDiodeLeaf(fix);
    const el = fix.circuit.elements[idx]!;
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_Q])).toBe(true);
    expect(Number.isFinite(fix.pool.state1[el._stateBase + SLOT_Q])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 — Harness sessions (T3) — resistive diode
// 1V → 1kΩ → diode → GND. Forward-bias DC + initial-transient regime; the
// resistive (4-slot) load() path is the bulk of the diode's stamp/state code.
// One session in beforeAll; runTransient lives inside the FIRST it() so a
// hard throw renders as a visible failed test (per spec session-sharing rule).
// ---------------------------------------------------------------------------

describeIfDll("Diode resistive forward paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_RESISTIVE,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_resistive", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_resistive", () => {
    // Step 0 of a transient is the firsttime DCOP solve. getStepEnd(0) exposes
    // the converged DC node and component slot values for paired comparison.
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

  it("full_iteration_paired_resistive", () => {
    session.compareAllAttempts();
  });

  it("limiting_paired_resistive", () => {
    // Pair pnjlim limiting events on D1 AK junction across the first attempt
    // of step 0. wasLimited and {vBefore,vAfter} must agree bit-exact.
    const cmp = session.getLimitingComparison("D1", 0, 0);
    for (const j of cmp.junctions) {
      expect(j.limitingDiff).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 — Harness sessions (T3) — capacitive diode
// 1V sine @ 100kHz → 1kΩ → diode (CJO=10pF, TT=1ns) → GND. Activates the
// junction-charge / Q / CCAP slots in the unified DIODE_SCHEMA: charge
// integration, NIintegrate companion stamping, MODEINITTRAN /
// MODEINITSMSIG cap-block branches that are dormant in the resistive .dts.
// ---------------------------------------------------------------------------

describeIfDll("Diode capacitive RC paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_CAP_RC,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_cap_rc", async () => {
    await session.runTransient(0, 5e-5, 5e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_cap_rc", () => {
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

  it("full_iteration_paired_cap_rc", () => {
    session.compareAllAttempts();
  });
});
