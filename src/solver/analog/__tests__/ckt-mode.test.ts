/**
 * Unit tests for the ckt-mode bitfield helpers.
 *
 * Focus: `bitsToName()` — the diagnostic decoder for the `cktMode` bitfield.
 * Canonical policy for the `cktMode` bitfield is `spec/architectural-alignment.md` §C2.
 */

import { describe, it, expect } from "vitest";
import {
  MODETRAN, MODEAC, MODEDCOP, MODETRANOP, MODEDCTRANCURVE,
  MODEINITFLOAT, MODEINITJCT, MODEINITFIX, MODEINITSMSIG,
  MODEINITTRAN, MODEINITPRED, MODEUIC,
  bitsToName, setInitf, setAnalysis,
} from "../ckt-mode.js";

describe("bitsToName — cktMode diagnostic decoder", () => {
  it("returns MODE_NONE for zero", () => {
    expect(bitsToName(0)).toBe("MODE_NONE");
  });

  it("decodes each individual analysis bit to its cktdefs.h name", () => {
    expect(bitsToName(MODETRAN)).toBe("MODETRAN");
    expect(bitsToName(MODEAC)).toBe("MODEAC");
    expect(bitsToName(MODEDCOP)).toBe("MODEDCOP");
    expect(bitsToName(MODETRANOP)).toBe("MODETRANOP");
    expect(bitsToName(MODEDCTRANCURVE)).toBe("MODEDCTRANCURVE");
  });

  it("decodes each individual INITF bit to its cktdefs.h name", () => {
    expect(bitsToName(MODEINITFLOAT)).toBe("MODEINITFLOAT");
    expect(bitsToName(MODEINITJCT)).toBe("MODEINITJCT");
    expect(bitsToName(MODEINITFIX)).toBe("MODEINITFIX");
    expect(bitsToName(MODEINITSMSIG)).toBe("MODEINITSMSIG");
    expect(bitsToName(MODEINITTRAN)).toBe("MODEINITTRAN");
    expect(bitsToName(MODEINITPRED)).toBe("MODEINITPRED");
  });

  it("decodes the MODEUIC orthogonal flag", () => {
    expect(bitsToName(MODEUIC)).toBe("MODEUIC");
  });

  it("joins multiple bits with | in the canonical order", () => {
    // Analysis first, then INITF — matches bitsToName body order.
    const dcopWithJct = setInitf(MODEDCOP, MODEINITJCT);
    expect(bitsToName(dcopWithJct)).toBe("MODEDCOP|MODEINITJCT");

    const tranWithFloat = setInitf(MODETRAN, MODEINITFLOAT);
    expect(bitsToName(tranWithFloat)).toBe("MODETRAN|MODEINITFLOAT");

    const tranOpWithJct = setInitf(MODETRANOP, MODEINITJCT);
    expect(bitsToName(tranOpWithJct)).toBe("MODETRANOP|MODEINITJCT");

    // Analysis + INITF + UIC (MODETRANOP + MODEINITJCT + MODEUIC)
    const withUic = setInitf(MODETRANOP | MODEUIC, MODEINITJCT);
    expect(bitsToName(withUic)).toBe("MODETRANOP|MODEINITJCT|MODEUIC");
  });

  it("produces the ngspice dcopDirect pattern (MODEDCOP|MODEINITFLOAT)", () => {
    // After the DCOP init ladder completes (cktop.c), MODEDCOP|MODEINITFLOAT
    // is the steady state during the main dcopDirect solve. Cited in
    // ngspice-bridge-grouping.test.ts §6.1 fixtures.
    const dcopDirect = setInitf(MODEDCOP, MODEINITFLOAT);
    expect(bitsToName(dcopDirect)).toBe("MODEDCOP|MODEINITFLOAT");
  });

  it("produces the MODETRAN free-running pattern", () => {
    // During transient NR after the initial tranInit, cktMode = MODETRAN
    // with no INITF bit (MODEINITFLOAT is cleared once the predictor runs).
    expect(bitsToName(MODETRAN)).toBe("MODETRAN");
  });

  it("round-trips through setAnalysis + setInitf", () => {
    let mode = 0;
    mode = setAnalysis(mode, MODETRAN);
    mode = setInitf(mode, MODEINITTRAN);
    expect(bitsToName(mode)).toBe("MODETRAN|MODEINITTRAN");
  });
});
