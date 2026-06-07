/**
 * Zener diode (simplified breakdown model) — canonical analog component tests.
 * Canon set: 1, 2, 3, 4, 5, 6. File tier: harness (T3 + T1).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import { DLL_PATH, describeIfDll } from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { isPoolBacked, type PoolBackedAnalogElement } from "../../../solver/analog/element.js";

const DTS_FORWARD = path.resolve(
  "src/components/semiconductors/__tests__/fixtures/zener-canon-forward.dts",
);
const DTS_BREAKDOWN = path.resolve(
  "src/components/semiconductors/__tests__/fixtures/zener-canon-breakdown.dts",
);

// ---------------------------------------------------------------------------
// Programmatic build helpers for T1 fixtures.
//
// Forward bias: V1=1V → Z1 anode → 1kΩ → ground. Forward Shockley regime
// exercises the standard pnjlim path on the AK junction.
//
// Breakdown bias: V1=8V drives the cathode (>BV=5.1V default) while the
// anode is held at ground through 1kΩ. The intrinsic Vd = vA - vK is
// strongly negative (well below -tBV) → the load() reflected-pnjlim branch
// fires and the breakdown-region cdb/gdb formula evaluates.
// ---------------------------------------------------------------------------

function buildZenerForward(
  facade: import("../../../headless/default-facade.js").DefaultSimulatorFacade,
): import("../../../core/circuit.js").Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: 1 } },
      { id: "d1",  type: "ZenerDiode",      props: { label: "D1", model: "simplified" } },
      { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: 1000 } },
      { id: "gnd", type: "Ground",          props: { label: "GND" } },
    ],
    connections: [
      ["vs:pos", "d1:A"],
      ["d1:K",   "r1:pos"],
      ["r1:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function buildZenerBreakdown(
  facade: import("../../../headless/default-facade.js").DefaultSimulatorFacade,
): import("../../../core/circuit.js").Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: 8 } },
      { id: "d1",  type: "ZenerDiode",      props: { label: "D1", model: "simplified" } },
      { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: 1000 } },
      { id: "gnd", type: "Ground",          props: { label: "GND" } },
    ],
    connections: [
      ["vs:pos", "d1:K"],
      ["d1:A",   "r1:pos"],
      ["r1:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function findZenerAnalog(fix: ReturnType<typeof buildFixture>): {
  idx: number;
  el: PoolBackedAnalogElement;
} {
  for (let i = 0; i < fix.circuit.elements.length; i++) {
    const candidate = fix.circuit.elements[i]!;
    if (!isPoolBacked(candidate)) continue;
    if (candidate.stateSchema.owner === "ZenerElement") {
      return { idx: i, el: candidate };
    }
  }
  throw new Error("ZenerAnalogElement not found in compiled circuit");
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Asserts the warm-started pool slots for the zener match ngspice diodefs.h
// (VD, ID, GEQ, Q, CCAP — diosetup.c:199 always allocates 5; companion ieq is
// recomputed inline as cd-gd*vd per dioload.c) and are finite after compile() +
// first coordinator.step(), with anode/cathode node voltages solved.
// ---------------------------------------------------------------------------

describe("Zener initialization (T1)", () => {
  it("init_zener_state_slots_seeded", () => {
    const fix = buildFixture({ build: (_r, f) => buildZenerForward(f) });
    const { el } = findZenerAnalog(fix);
    const SLOT_VD  = el.stateSchema.indexOf.get("VD")!;
    const SLOT_GEQ = el.stateSchema.indexOf.get("GEQ")!;
    const SLOT_ID  = el.stateSchema.indexOf.get("ID")!;

    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_VD])).toBe(true);
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_GEQ])).toBe(true);
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_ID])).toBe(true);

    const vA = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:A")!);
    const vK = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:K")!);
    expect(Number.isFinite(vA)).toBe(true);
    expect(Number.isFinite(vK)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical sanity)
//
// Forward bias: V1=1V → Z1 → 1kΩ → 0V. Default IS=1e-14, N=1.0, T=300.15K
// give Vt ≈ 0.02585V. Closed-form Shockley with I = (V1 - Vf)/R yields
// Vf ≈ 0.6V at I ≈ 0.4mA. Strict bound: 0.4V < Vf < 0.8V.
//
// Breakdown bias: V1=8V across Z1 cathode-side, anode at 0V via 1kΩ. With
// default BV=5.1V and IBV=1e-3A (so tBV ≈ 5.1V), the zener clamps the
// reverse voltage near tBV. I ≈ (V1 - tBV) / R ≈ 2.9mA. Strict bound:
// the anode-cathode voltage Vd = vA - vK is reverse and within ±0.5V of -tBV.
// ---------------------------------------------------------------------------

describe("Zener DCOP analytical (T1)", () => {
  it("dcop_zener_forward_vf_in_band", () => {
    const fix = buildFixture({ build: (_r, f) => buildZenerForward(f) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const vA = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:A")!);
    const vK = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:K")!);
    const vf = vA - vK;
    expect(vf).toBeGreaterThan(0.4);
    expect(vf).toBeLessThan(0.8);
  });

  it("dcop_zener_breakdown_clamps_near_tBV", () => {
    const fix = buildFixture({ build: (_r, f) => buildZenerBreakdown(f) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const vA = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:A")!);
    const vK = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:K")!);
    const vd = vA - vK; // reverse → strongly negative
    // tBV ≈ 5.1V (default BV after diotemp.c iteration). Clamp band ±0.5V.
    expect(vd).toBeLessThan(-4.6);
    expect(vd).toBeGreaterThan(-5.6);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
//
// Simplified-zener model parameters (ZENER_PARAM_DEFS): IS, N, BV, NBV, IBV,
// TCV, TNOM (primary/model partition); TEMP (instance, derived-state-recompute).
// One it() per representative group:
//   - IS: structural Shockley scale (forward regime).
//   - N:  emission coefficient (forward regime).
//   - BV: breakdown voltage (breakdown regime; tBV reseeds via _computeZenerTp).
//   - NBV: breakdown emission coefficient (breakdown regime).
//   - TEMP: derived-state recompute (universal).
// ---------------------------------------------------------------------------

describe("Zener parameter hot-load (T1)", () => {
  it("hotload_IS_changes_vf_forward", () => {
    const fix = buildFixture({ build: (_r, f) => buildZenerForward(f) });
    const ce = fix.element("D1");
    const vAnode = fix.circuit.labelToNodeId.get("D1:A")!;
    const vCath = fix.circuit.labelToNodeId.get("D1:K")!;
    const before = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    fix.coordinator.setComponentProperty(ce, "IS", 1e-10);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    // Larger IS → lower Vf at the same current.
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeLessThan(before);
  });

  it("hotload_N_changes_vf_forward", () => {
    const fix = buildFixture({ build: (_r, f) => buildZenerForward(f) });
    const ce = fix.element("D1");
    const vAnode = fix.circuit.labelToNodeId.get("D1:A")!;
    const vCath = fix.circuit.labelToNodeId.get("D1:K")!;
    const before = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    fix.coordinator.setComponentProperty(ce, "N", 2.0);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    // Larger N raises the thermal voltage scale → Vf rises at the same current.
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_BV_shifts_breakdown_clamp", () => {
    const fix = buildFixture({ build: (_r, f) => buildZenerBreakdown(f) });
    const ce = fix.element("D1");
    const vAnode = fix.circuit.labelToNodeId.get("D1:A")!;
    const vCath = fix.circuit.labelToNodeId.get("D1:K")!;
    const before = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    fix.coordinator.setComponentProperty(ce, "BV", 3.3);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    // Lowering BV from 5.1V to 3.3V raises tBV's negation magnitude less, so
    // the clamp moves toward zero (less reverse). |vd_after| < |vd_before|.
    expect(after).not.toBeCloseTo(before, 6);
    expect(Math.abs(after)).toBeLessThan(Math.abs(before));
  });

  it("hotload_NBV_changes_breakdown_response", () => {
    const fix = buildFixture({ build: (_r, f) => buildZenerBreakdown(f) });
    const ce = fix.element("D1");
    const vAnode = fix.circuit.labelToNodeId.get("D1:A")!;
    const vCath = fix.circuit.labelToNodeId.get("D1:K")!;
    const before = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    // NBV scales the breakdown emission coefficient. Bumping it from N=1.0
    // (default) to 1.5 reshapes nbvVt and the breakdown-region exp slope.
    fix.coordinator.setComponentProperty(ce, "NBV", 1.5);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_TEMP_changes_vf_forward", () => {
    // TEMP is the derived-state recompute parameter (universal). setParam
    // triggers _computeZenerTp() which re-derives vt, nVt, nbvVt, tVcrit,
    // vcritBrk, tBV.
    const fix = buildFixture({ build: (_r, f) => buildZenerForward(f) });
    const ce = fix.element("D1");
    const vAnode = fix.circuit.labelToNodeId.get("D1:A")!;
    const vCath = fix.circuit.labelToNodeId.get("D1:K")!;
    const before = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    fix.coordinator.setComponentProperty(ce, "TEMP", 400);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vAnode) - fix.engine.getNodeVoltage(vCath);
    // Raising T raises vt and (through the diotemp path) the saturation
    // current; at the same current Vf drops.
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeLessThan(before);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — computeTemperature engine-driven path (T1)
//
// ZenerAnalogElement.computeTemperature(ctx) is the engine-driven DEVtemperature
// callback (ckttemp.c:28-33 orchestration). It propagates ctx.cktTemp to the
// zener's operating temperature when no per-instance TEMP override is active
// (diotemp.c:84-85: if(!DIOtempGiven) here->DIOtemp = ckt->CKTtemp).
// ---------------------------------------------------------------------------

describe("Zener computeTemperature engine-driven path (T1)", () => {
  it("computeTemperature_ambient_propagates_to_vf", () => {
    // Build at default temperature (300.15 K). Run DCOP. Record Vf.
    const fixCold = buildFixture({ build: (_r, f) => buildZenerForward(f) });
    fixCold.coordinator.dcOperatingPoint();
    const vAnodeCold = fixCold.engine.getNodeVoltage(fixCold.circuit.labelToNodeId.get("D1:A")!);
    const vCathCold  = fixCold.engine.getNodeVoltage(fixCold.circuit.labelToNodeId.get("D1:K")!);
    const vfCold = vAnodeCold - vCathCold;

    // Build a second fixture; call setCircuitTemp(400) to trigger the
    // engine-driven computeTemperature pass on all DIO elements.
    const fixHot = buildFixture({ build: (_r, f) => buildZenerForward(f) });
    fixHot.facade.setCircuitTemp(400);
    fixHot.coordinator.dcOperatingPoint();
    const vAnodeHot = fixHot.engine.getNodeVoltage(fixHot.circuit.labelToNodeId.get("D1:A")!);
    const vCathHot  = fixHot.engine.getNodeVoltage(fixHot.circuit.labelToNodeId.get("D1:K")!);
    const vfHot = vAnodeHot - vCathHot;

    // Raising T raises tIS exponentially → at the same current Vf drops.
    expect(vfHot).not.toBeCloseTo(vfCold, 6);
    expect(vfHot).toBeLessThan(vfCold);
  });

  it("computeTemperature_respects_per_instance_override", () => {
    // Per-instance TEMP set via setParam must not be overwritten by the
    // engine-driven computeTemperature pass (diotemp.c:84 DIOtempGiven guard).
    const fix = buildFixture({ build: (_r, f) => buildZenerForward(f) });
    const ce = fix.element("D1");

    // Set per-instance TEMP override to 500 K.
    fix.coordinator.setComponentProperty(ce, "TEMP", 500);
    fix.coordinator.dcOperatingPoint();
    const vAnode500 = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:A")!);
    const vCath500  = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:K")!);
    const vf500 = vAnode500 - vCath500;

    // Now push a lower ambient via setCircuitTemp. The per-instance override
    // must win — result must not revert to the ambient-temperature Vf.
    fix.facade.setCircuitTemp(300.15);
    fix.coordinator.step();
    const vAnodeAfter = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:A")!);
    const vCathAfter  = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:K")!);
    const vfAfter = vAnodeAfter - vCathAfter;

    // The Vf must remain at the 500 K operating point to NR convergence tolerance.
    // It should not change when ambient is altered (override holds).
    expect(vfAfter).toBeCloseTo(vf500, 6);
  });

  it("computeTemperature_breakdown_tBV_shifts_with_ambient", () => {
    // In breakdown regime: tBV is derived from BV, IBV, TCV and temperature.
    // Raising circuit temperature via setCircuitTemp must shift the breakdown
    // clamp compared with the default-temperature operating point.
    // cite: diotemp.c:208-244 — tBreakdownVoltage = BV - TCV * dt
    const fixCold = buildFixture({ build: (_r, f) => buildZenerBreakdown(f) });
    fixCold.coordinator.dcOperatingPoint();
    const vdCold =
      fixCold.engine.getNodeVoltage(fixCold.circuit.labelToNodeId.get("D1:A")!) -
      fixCold.engine.getNodeVoltage(fixCold.circuit.labelToNodeId.get("D1:K")!);

    const fixHot = buildFixture({ build: (_r, f) => buildZenerBreakdown(f) });
    fixHot.facade.setCircuitTemp(400);
    fixHot.coordinator.dcOperatingPoint();
    const vdHot =
      fixHot.engine.getNodeVoltage(fixHot.circuit.labelToNodeId.get("D1:A")!) -
      fixHot.engine.getNodeVoltage(fixHot.circuit.labelToNodeId.get("D1:K")!);

    // At higher temperature tIS grows, causing the NR solution to shift.
    // The two results must differ measurably.
    expect(vdHot).not.toBeCloseTo(vdCold, 4);
  });
});

// ---------------------------------------------------------------------------
// Category 6 — Limiting events (T1, own engine)
// pnjlim fires on the AK junction during DCOP NR. Drive a forward-biased
// zener and read fix.coordinator.getLimitingEvents().
// ---------------------------------------------------------------------------

describe("Zener limiting events own-engine (T1)", () => {
  it("limiting_pnjlim_fires_zener_forward", () => {
    const fix = buildFixture({ build: (_r, f) => buildZenerForward(f) });
    fix.coordinator.setLimitingCapture(true);
    fix.coordinator.dcOperatingPoint();
    const events = fix.coordinator.getLimitingEvents();
    const ak = events.find(e => e.label === "D1" && e.junction === "AK");
    expect(ak).toBeDefined();
    expect(ak!.limitType).toBe("pnjlim");
    expect(Number.isFinite(ak!.vBefore)).toBe(true);
    expect(Number.isFinite(ak!.vAfter)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 / 6-paired — Harness sessions (T3)
// One describe()/session per .dts. Sessions open in beforeAll, runs go in the
// FIRST it() per session-sharing rules, dispose in afterAll. Gated on
// canonical dllAvailable() via describeIfDll.
// ---------------------------------------------------------------------------

describeIfDll("Zener forward bias paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_FORWARD,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_forward", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_forward", () => {
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

  it("full_iteration_paired_forward", () => {
    session.compareAllAttempts();
  });

  it("limiting_paired_forward", () => {
    const cmp = session.getLimitingComparison("D1", 0, 0);
    for (const j of cmp.junctions) {
      expect(j.limitingDiff).toBe(0);
    }
  });
});

describeIfDll("Zener breakdown paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_BREAKDOWN,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_breakdown", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_breakdown", () => {
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

  it("full_iteration_paired_breakdown", () => {
    session.compareAllAttempts();
  });

  it("limiting_paired_breakdown", () => {
    const cmp = session.getLimitingComparison("D1", 0, 0);
    for (const j of cmp.junctions) {
      expect(j.limitingDiff).toBe(0);
    }
  });
});
