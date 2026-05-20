// Surface-1 headless tests for the capacitor v26-baseline reconstruction:
// the geometric-capacitance model (captemp.c:55-68, capsetup.c:71-88) and the
// per-instance temperature pass (captemp.c:38-89). Covers
// spec/v41-port/reconstruction/cap-computetemperature.md acceptance criteria
// 3, 4, 5, 6, 11.
//
// Observability. computeTemperature runs inside the engine warm-start (the
// initial temperature pass, analog-engine.ts:1415-1420) and again on every
// setCircuitTemp; it writes the effective capacitance this.C. ngspice CAPload
// writes the charge state CKTstate0[CAPqcap] only under
// MODETRAN|MODEAC|MODETRANOP (capload.c:30); at a pure DC operating point a
// capacitor is open and the slot is never written. effectiveCapacitance()
// therefore drives a transient step (coordinator.step()) so load() re-stamps
// state0[Q] = this.C * vcap from the current effective C (capload.c:59,81).
// The series RC is open at steady DC, so vcap = Vsrc and the Q slot reads
// C_effective * Vsrc — a direct analytic readout of the post-pass effective
// capacitance.

import { describe, it, expect, vi } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { AnalogCapacitorElement } from "../capacitor.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Physical constants — recomputed from ngspice const.h exactly as
// capacitor.ts derives EPS0 / EPS_SIO2 (const.h:44-53). These are physics
// constants, not slot indices; recomputing them is the sanctioned way to get
// an analytic expectation without importing production internals.
// ---------------------------------------------------------------------------

const CONST_MU_ZERO = 4.0 * Math.PI * 1e-7;          // const.h:44
const CONST_C = 299792458;                            // const.h:19
const EPS0 = 1.0 / (CONST_MU_ZERO * CONST_C * CONST_C); // const.h:47
const EPS_SIO2 = 3.9 * EPS0;                          // const.h:51,53

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

interface CapProps {
  [key: string]: number;
}

// Series RC: VS -> R -> C -> GND. At DC the cap is open, V_C = Vsrc.
function buildRcWithCapProps(
  facade: DefaultSimulatorFacade,
  vSource: number,
  capProps: CapProps,
): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: vSource } },
      { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: 1000 } },
      { id: "c1",  type: "Capacitor",       props: { label: "C1", ...capProps } },
      { id: "gnd", type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos", "r1:pos"],
      ["r1:neg", "c1:pos"],
      ["c1:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function findCapacitor(fix: ReturnType<typeof buildFixture>): AnalogCapacitorElement {
  const idx = fix.circuit.elements.findIndex((el) => el instanceof AnalogCapacitorElement);
  if (idx < 0) throw new Error("AnalogCapacitorElement not found in compiled circuit");
  return fix.circuit.elements[idx] as AnalogCapacitorElement;
}

// Effective-capacitance read-back. ngspice CAPload writes CKTstate0[CAPqcap]
// only under MODETRAN|MODEAC|MODETRANOP (capload.c:30) — never at a pure DC
// operating point, where a capacitor is open. A transient step re-runs load()
// so state0[Q] = this.C * vcap with the current effective C (capload.c:59,81);
// the series RC is open at steady DC so vcap = Vsrc. Mirrors the canonical
// post-change transient observation (transformer.test.ts:270-297).
function effectiveCapacitance(fix: ReturnType<typeof buildFixture>, vSource: number): number {
  const cap = findCapacitor(fix);
  fix.coordinator.step();
  const slotQ = cap.stateSchema.indexOf.get("Q")!;
  return fix.pool.state0[cap._stateBase + slotQ] / vSource;
}

// ===========================================================================
// Geometry: area + perimeter capacitance — criterion 4 / 11
// captemp.c:55-68: C_base = cj·(w-narrow)·(l-short)
//                          + cjsw·2·((l-short)+(w-narrow))
// ===========================================================================

describe("Capacitor geometric capacitance — area + perimeter (T1)", () => {
  it("geometry_cj_cjsw_w_l_no_capacitance_yields_area_perimeter_capacitance", () => {
    // criterion 4: with cj/cjsw/w/l and NO instance capacitance, the base
    // capacitance is the area·cj + perimeter·cjsw formula. narrow/short
    // default to 0, TC1/TC2 default to 0, SCALE to 1 → factor 1, C = base.
    const cj = 1e-4;     // F/m^2
    const cjsw = 2e-10;  // F/m
    const w = 2e-5;      // m
    const l = 1e-5;      // m
    const vSource = 1.0;

    const fix = buildFixture({
      build: (_r, facade) => buildRcWithCapProps(facade, vSource, { cj, cjsw, w, l }),
    });

    const expectedBase = cj * w * l + cjsw * 2 * (l + w);
    expect(effectiveCapacitance(fix, vSource)).toBeCloseTo(expectedBase, 18);
  });

  it("geometry_narrow_short_corrections_shrink_effective_dimensions", () => {
    // criterion 4: narrow / short subtract from w / l in both the area and
    // perimeter terms. C_base = cj·(w-narrow)·(l-short) + cjsw·2·(...).
    const cj = 1e-4;
    const cjsw = 0;
    const w = 4e-5;
    const l = 3e-5;
    const narrow = 1e-5;
    const short = 0.5e-5;
    const vSource = 1.0;

    const fix = buildFixture({
      build: (_r, facade) =>
        buildRcWithCapProps(facade, vSource, { cj, cjsw, w, l, narrow, short }),
    });

    const expectedBase =
      cj * (w - narrow) * (l - short) + cjsw * 2 * ((l - short) + (w - narrow));
    expect(effectiveCapacitance(fix, vSource)).toBeCloseTo(expectedBase, 18);
  });
});

// ===========================================================================
// Geometry: cj-from-thickness derivation in setup() — criterion 3 / 11
// capsetup.c:71-88: when cj is not given, derive it from di / thick.
// ===========================================================================

describe("Capacitor cj-from-thickness derivation (T1)", () => {
  it("di_and_thick_no_cj_derives_cj_as_di_eps0_over_thick", () => {
    // criterion 3: di given → _cj = di·EPS0/thick. Then the area formula
    // (cjsw = 0) gives C = _cj·w·l.
    const di = 4;
    const thick = 1e-6;  // m
    const w = 1e-4;      // m
    const l = 1e-4;      // m
    const vSource = 1.0;

    const fix = buildFixture({
      build: (_r, facade) =>
        buildRcWithCapProps(facade, vSource, { di, thick, w, l }),
    });

    const derivedCj = (di * EPS0) / thick;
    const expectedBase = derivedCj * w * l;
    expect(effectiveCapacitance(fix, vSource)).toBeCloseTo(expectedBase, 22);
  });

  it("thick_no_di_no_cj_derives_cj_as_eps_sio2_over_thick", () => {
    // criterion 3: thick given but di not given → _cj = EPS_SIO2/thick.
    const thick = 2e-6;  // m
    const w = 1e-4;
    const l = 1e-4;
    const vSource = 1.0;

    const fix = buildFixture({
      build: (_r, facade) =>
        buildRcWithCapProps(facade, vSource, { thick, w, l }),
    });

    const derivedCj = EPS_SIO2 / thick;
    const expectedBase = derivedCj * w * l;
    expect(effectiveCapacitance(fix, vSource)).toBeCloseTo(expectedBase, 22);
  });

  it("no_cj_no_thick_geometry_capacitance_is_zero", () => {
    // criterion 3: !thickGiven → _cj = 0. With w/l given but no cj path the
    // area+perimeter formula collapses to 0 (cjsw also 0).
    const w = 1e-4;
    const l = 1e-4;
    const vSource = 1.0;

    const fix = buildFixture({
      build: (_r, facade) => buildRcWithCapProps(facade, vSource, { w, l }),
    });

    expect(effectiveCapacitance(fix, vSource)).toBeCloseTo(0, 22);
  });
});

// ===========================================================================
// TC1 / TC2 / SCALE temperature fold — criterion 6
// captemp.c:72-89: C = base·(1 + TC1·Δ + TC2·Δ²)·SCALE, Δ = effTemp − TNOM.
// ===========================================================================

describe("Capacitor TC1/TC2/SCALE temperature fold (T1)", () => {
  it("tc1_tc2_fold_with_tnom_offset_from_ambient", () => {
    // criterion 6: with no per-instance temp, effTemp = cktTemp = 300.15 K.
    // TNOM = 250 → Δ = 50.15. factor = 1 + TC1·Δ + TC2·Δ².
    const nominalC = 1e-6;
    const TC1 = 0.01;
    const TC2 = 1e-4;
    const TNOM = 250;
    const vSource = 1.0;

    const fix = buildFixture({
      build: (_r, facade) =>
        buildRcWithCapProps(facade, vSource, { capacitance: nominalC, TC1, TC2, TNOM }),
    });

    const delta = 300.15 - TNOM;
    const factor = 1 + TC1 * delta + TC2 * delta * delta;
    const expectedC = nominalC * factor;
    expect(effectiveCapacitance(fix, vSource)).toBeCloseTo(expectedC, 12);
  });

  it("scale_multiplies_the_folded_capacitance", () => {
    // criterion 6: SCALE is the trailing multiplier of the TC fold.
    // With TC1 = TC2 = 0 and TNOM = 300.15 the factor is 1, so C = base·SCALE.
    const nominalC = 1e-6;
    const SCALE = 3;
    const vSource = 1.0;

    const fix = buildFixture({
      build: (_r, facade) =>
        buildRcWithCapProps(facade, vSource, { capacitance: nominalC, SCALE, TNOM: 300.15 }),
    });

    expect(effectiveCapacitance(fix, vSource)).toBeCloseTo(nominalC * SCALE, 12);
  });
});

// ===========================================================================
// Per-instance TEMP override and DTEMP offset — criterion 5
// captemp.c:38-47: temp given → effTemp = TEMP, dtemp forced 0 and ignored
// (warning printed when dtemp was also supplied); temp not given →
// effTemp = cktTemp + DTEMP.
// ===========================================================================

describe("Capacitor per-instance TEMP / DTEMP (T1)", () => {
  it("temp_given_uses_absolute_instance_temperature", () => {
    // criterion 5: with TEMP given, effTemp = TEMP (not ambient).
    // TEMP = 400, TNOM = 300.15 → Δ = 99.85.
    const nominalC = 1e-6;
    const TC1 = 0.01;
    const TNOM = 300.15;
    const TEMP = 400;
    const vSource = 1.0;

    const fix = buildFixture({
      build: (_r, facade) =>
        buildRcWithCapProps(facade, vSource, { capacitance: nominalC, TC1, TNOM, TEMP }),
    });

    const delta = TEMP - TNOM;
    const factor = 1 + TC1 * delta;
    expect(effectiveCapacitance(fix, vSource)).toBeCloseTo(nominalC * factor, 12);
  });

  it("dtemp_offsets_ambient_when_temp_not_given", () => {
    // criterion 5: with no TEMP, effTemp = cktTemp + DTEMP = 300.15 + 50.
    const nominalC = 1e-6;
    const TC1 = 0.01;
    const TNOM = 300.15;
    const DTEMP = 50;
    const vSource = 1.0;

    const fix = buildFixture({
      build: (_r, facade) =>
        buildRcWithCapProps(facade, vSource, { capacitance: nominalC, TC1, TNOM, DTEMP }),
    });

    const delta = (300.15 + DTEMP) - TNOM;
    const factor = 1 + TC1 * delta;
    expect(effectiveCapacitance(fix, vSource)).toBeCloseTo(nominalC * factor, 12);
  });

  it("temp_given_forces_dtemp_to_zero_and_warns", () => {
    // criterion 5: when BOTH temp and dtemp are supplied, dtemp is forced 0
    // and ignored, and ngspice prints a warning (captemp.c:44-46). The folded
    // C must use effTemp = TEMP exactly, with no DTEMP contribution.
    const nominalC = 1e-6;
    const TC1 = 0.01;
    const TNOM = 300.15;
    const TEMP = 350;
    const DTEMP = 99;        // supplied but must be ignored
    const vSource = 1.0;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fix = buildFixture({
        build: (_r, facade) =>
          buildRcWithCapProps(facade, vSource, { capacitance: nominalC, TC1, TNOM, TEMP, DTEMP }),
      });

      // effTemp = TEMP (350), NOT TEMP + DTEMP and NOT ambient + DTEMP.
      const delta = TEMP - TNOM;
      const factor = 1 + TC1 * delta;
      expect(effectiveCapacitance(fix, vSource)).toBeCloseTo(nominalC * factor, 12);

      // The temp-given precedence warning fired.
      expect(warnSpy).toHaveBeenCalled();
      const warned = warnSpy.mock.calls.some(
        (args) => typeof args[0] === "string" && args[0].includes("dtemp ignored"),
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
