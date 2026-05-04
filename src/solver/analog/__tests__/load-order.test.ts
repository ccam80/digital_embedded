/**
 * V1: factory-output ngspiceLoadOrder unit test.
 *
 * Each analog factory must declare an `ngspiceLoadOrder` ordinal that
 * matches its ngspice device-type slot in `dev.c`'s `DEVices[]` array. The
 * compiler's per-iteration cktLoad ordering parity (architectural item A1)
 * depends on every factory setting this field correctly- a missing or wrong
 * value silently de-syncs internal sparse-matrix indexing from ngspice.
 *
 * This test asserts the field at the leaf-factory level so we catch
 * registration mistakes at the factory boundary, not three layers down in
 * a parity-comparison failure.
 */

import { describe, it, expect } from "vitest";
import { NGSPICE_LOAD_ORDER } from "../ngspice-load-order.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogFactory } from "../../../core/registry.js";
import { ResistorDefinition, RESISTOR_DEFAULTS } from "../../../components/passives/resistor.js";
import { CapacitorDefinition, CAPACITOR_DEFAULTS } from "../../../components/passives/capacitor.js";
import { makeDcVoltageSource, DC_VOLTAGE_SOURCE_DEFAULTS } from "../../../components/sources/dc-voltage-source.js";

function getFactory(def: { modelRegistry?: Record<string, unknown> }): AnalogFactory {
  const entry = def.modelRegistry!["behavioral"] as { kind: "inline"; factory: AnalogFactory };
  return entry.factory;
}

describe("ngspiceLoadOrder per-factory ordinals", () => {
  it("Resistor factory returns RES (40)", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ ...RESISTOR_DEFAULTS, resistance: 1000 });
    const el = getFactory(ResistorDefinition)(
      new Map([["A", 1], ["B", 2]]),
      props,
      () => 0,
    );
    expect(el.ngspiceLoadOrder).toBe(NGSPICE_LOAD_ORDER.RES);
    expect(el.ngspiceLoadOrder).toBe(40);
  });

  it("Capacitor factory returns CAP (17)", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ ...CAPACITOR_DEFAULTS, capacitance: 1e-6 });
    const el = getFactory(CapacitorDefinition)(
      new Map([["pos", 1], ["neg", 2]]),
      props,
      () => 0,
    );
    expect(el.ngspiceLoadOrder).toBe(NGSPICE_LOAD_ORDER.CAP);
    expect(el.ngspiceLoadOrder).toBe(17);
  });

  it("VoltageSource factory returns VSRC (48)", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ ...DC_VOLTAGE_SOURCE_DEFAULTS, voltage: 5.0 });
    const el = makeDcVoltageSource(
      new Map([["pos", 1], ["neg", 0]]),
      props,
      () => 0,
    );
    expect(el.ngspiceLoadOrder).toBe(NGSPICE_LOAD_ORDER.VSRC);
    expect(el.ngspiceLoadOrder).toBe(48);
  });

  it("NGSPICE_LOAD_ORDER constants are stable", () => {
    // Smoke test: the table values determine internal-index parity. If
    // anyone re-orders the enum, every fixture's per-iteration matrix
    // permutation changes silently. Pin the values explicitly.
    expect(NGSPICE_LOAD_ORDER.URC).toBe(0);
    expect(NGSPICE_LOAD_ORDER.BJT).toBe(2);
    expect(NGSPICE_LOAD_ORDER.CAP).toBe(17);
    expect(NGSPICE_LOAD_ORDER.CCCS).toBe(18);
    expect(NGSPICE_LOAD_ORDER.CCVS).toBe(19);
    expect(NGSPICE_LOAD_ORDER.DIO).toBe(22);
    expect(NGSPICE_LOAD_ORDER.IND).toBe(27);
    expect(NGSPICE_LOAD_ORDER.MUT).toBe(28);
    expect(NGSPICE_LOAD_ORDER.ISRC).toBe(29);
    expect(NGSPICE_LOAD_ORDER.JFET).toBe(30);
    expect(NGSPICE_LOAD_ORDER.MOS).toBe(35);
    expect(NGSPICE_LOAD_ORDER.RES).toBe(40);
    expect(NGSPICE_LOAD_ORDER.SW).toBe(42);
    expect(NGSPICE_LOAD_ORDER.TRA).toBe(43);
    expect(NGSPICE_LOAD_ORDER.VCCS).toBe(46);
    expect(NGSPICE_LOAD_ORDER.VCVS).toBe(47);
    expect(NGSPICE_LOAD_ORDER.VSRC).toBe(48);
  });
});

describe("compiled-element load-order sort", () => {
  it("stable-sort preserves intra-bucket order", () => {
    // Synthetic test: build a tiny array of mock elements with identical
    // ordinals and verify stable sort preserves insertion order.
    const elements = [
      { id: "R1", ngspiceLoadOrder: NGSPICE_LOAD_ORDER.RES },
      { id: "R2", ngspiceLoadOrder: NGSPICE_LOAD_ORDER.RES },
      { id: "V1", ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VSRC },
      { id: "R3", ngspiceLoadOrder: NGSPICE_LOAD_ORDER.RES },
      { id: "C1", ngspiceLoadOrder: NGSPICE_LOAD_ORDER.CAP },
    ];
    const sorted = [...elements].sort(
      (a, b) => a.ngspiceLoadOrder - b.ngspiceLoadOrder,
    );
    // Expected order: C1 (CAP=17), R1, R2, R3 (RES=40, insertion order), V1 (VSRC=48).
    expect(sorted.map((e) => e.id)).toEqual(["C1", "R1", "R2", "R3", "V1"]);
  });
});
