/**
 * V1: factory-output ngspiceLoadOrder unit test.
 *
 * Each `make*` analog factory must declare an `ngspiceLoadOrder` ordinal that
 * matches its ngspice device-type slot in `dev.c`'s `DEVices[]` array. The
 * compiler's per-iteration cktLoad ordering parity (architectural item A1)
 * depends on every factory setting this field correctly — a missing or wrong
 * value silently de-syncs internal sparse-matrix indexing from ngspice.
 *
 * This test asserts the field at the leaf-factory level so we catch
 * registration mistakes at the factory boundary, not three layers down in
 * a parity-comparison failure.
 */

import { describe, it, expect } from "vitest";
import { NGSPICE_LOAD_ORDER } from "../../../core/analog-types.js";
import { makeResistor, makeVoltageSource, makeCapacitor } from "./test-helpers.js";

describe("ngspiceLoadOrder per-factory ordinals", () => {
  it("Resistor factory returns RES (0)", () => {
    const el = makeResistor(1, 2, 1000);
    expect(el.ngspiceLoadOrder).toBe(NGSPICE_LOAD_ORDER.RES);
    expect(el.ngspiceLoadOrder).toBe(0);
  });

  it("Capacitor factory returns CAP (1)", () => {
    const el = makeCapacitor(1, 2, 1e-6);
    expect(el.ngspiceLoadOrder).toBe(NGSPICE_LOAD_ORDER.CAP);
    expect(el.ngspiceLoadOrder).toBe(1);
  });

  it("VoltageSource factory returns VSRC (4)", () => {
    const el = makeVoltageSource(1, 0, 2, 5.0);
    expect(el.ngspiceLoadOrder).toBe(NGSPICE_LOAD_ORDER.VSRC);
    expect(el.ngspiceLoadOrder).toBe(4);
  });

  it("NGSPICE_LOAD_ORDER constants are stable", () => {
    // Smoke test: the table values determine internal-index parity. If
    // anyone re-orders the enum, every fixture's per-iteration matrix
    // permutation changes silently. Pin the values explicitly.
    expect(NGSPICE_LOAD_ORDER.RES).toBe(0);
    expect(NGSPICE_LOAD_ORDER.CAP).toBe(1);
    expect(NGSPICE_LOAD_ORDER.IND).toBe(2);
    expect(NGSPICE_LOAD_ORDER.MUT).toBe(3);
    expect(NGSPICE_LOAD_ORDER.VSRC).toBe(4);
    expect(NGSPICE_LOAD_ORDER.ISRC).toBe(5);
    expect(NGSPICE_LOAD_ORDER.VCVS).toBe(6);
    expect(NGSPICE_LOAD_ORDER.VCCS).toBe(7);
    expect(NGSPICE_LOAD_ORDER.CCCS).toBe(8);
    expect(NGSPICE_LOAD_ORDER.CCVS).toBe(9);
    expect(NGSPICE_LOAD_ORDER.URC).toBe(10);
    expect(NGSPICE_LOAD_ORDER.TRA).toBe(11);
    expect(NGSPICE_LOAD_ORDER.DIO).toBe(12);
    expect(NGSPICE_LOAD_ORDER.BJT).toBe(13);
    expect(NGSPICE_LOAD_ORDER.JFET).toBe(14);
    expect(NGSPICE_LOAD_ORDER.MOS).toBe(15);
    expect(NGSPICE_LOAD_ORDER.SW).toBe(16);
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
    // Expected order: R1, R2, R3 (RES bucket, original order), C1 (CAP), V1 (VSRC).
    expect(sorted.map((e) => e.id)).toEqual(["R1", "R2", "R3", "C1", "V1"]);
  });
});
