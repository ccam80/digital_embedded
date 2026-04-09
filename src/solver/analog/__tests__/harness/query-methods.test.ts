/**
 * Tests for Stream 3 query methods, utilities, and ComparisonSession extensions.
 *
 * Tests 1-7:  glob.ts
 * Tests 8-13: format.ts
 * Tests 14+:  additional methods (added by subsequent tasks)
 */

import { describe, it, expect } from "vitest";
import { compileSlotMatcher, matchSlotPattern } from "./glob.js";
import {
  formatComparedValue,
  formatCV,
  formatComparedTable,
  mapToRecord,
  float64ToArray,
} from "./format.js";
import type { ComparedValue } from "./types.js";

// ---------------------------------------------------------------------------
// glob.ts — 7 tests
// ---------------------------------------------------------------------------

describe("glob.ts — compileSlotMatcher / matchSlotPattern", () => {
  it("1. compileSlotMatcher([]) always returns false", () => {
    const match = compileSlotMatcher([]);
    expect(match("anything")).toBe(false);
    expect(match("")).toBe(false);
    expect(match("Q_BE")).toBe(false);
  });

  it('2. compileSlotMatcher(["*"]) always returns true', () => {
    const match = compileSlotMatcher(["*"]);
    expect(match("Q_BE")).toBe(true);
    expect(match("")).toBe(true);
    expect(match("SOME_SLOT_123")).toBe(true);
  });

  it('3. matchSlotPattern("Q_BE", ["Q_*"]) → true', () => {
    expect(matchSlotPattern("Q_BE", ["Q_*"])).toBe(true);
  });

  it('4. matchSlotPattern is case-insensitive: "q_be" matches "Q_*"', () => {
    expect(matchSlotPattern("q_be", ["Q_*"])).toBe(true);
  });

  it('5. matchSlotPattern("VBE", ["Q_*"]) → false', () => {
    expect(matchSlotPattern("VBE", ["Q_*"])).toBe(false);
  });

  it('6. matchSlotPattern: ? matches single char — "VBE" matches "V?E"', () => {
    expect(matchSlotPattern("VBE", ["V?E"])).toBe(true);
    expect(matchSlotPattern("VBE", ["V??"])).toBe(true);
    expect(matchSlotPattern("VBE", ["V?"])).toBe(false);
  });

  it('7. matchSlotPattern with multiple patterns OR\'d — "GEQ" matches ["Q_*", "GEQ"]', () => {
    expect(matchSlotPattern("GEQ", ["Q_*", "GEQ"])).toBe(true);
    expect(matchSlotPattern("GEQ", ["Q_*"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// format.ts — 6 tests
// ---------------------------------------------------------------------------

describe("format.ts — formatting and serialization utilities", () => {
  const cvPass: ComparedValue = {
    ours: 1.23e-3,
    ngspice: 1.24e-3,
    delta: -1e-5,
    absDelta: 1e-5,
    relDelta: 0.008,
    withinTol: true,
  };

  const cvFail: ComparedValue = {
    ours: 1.0,
    ngspice: 2.0,
    delta: -1.0,
    absDelta: 1.0,
    relDelta: 0.5,
    withinTol: false,
  };

  it("8. formatComparedValue with withinTol:true contains 'ours=' and 'PASS'", () => {
    const result = formatComparedValue(cvPass, 4);
    expect(result).toContain("ours=");
    expect(result).toContain("PASS");
    expect(result).not.toContain("FAIL");
  });

  it("9. formatComparedValue with withinTol:false contains 'FAIL'", () => {
    const result = formatComparedValue(cvFail, 4);
    expect(result).toContain("FAIL");
    expect(result).not.toContain("PASS");
  });

  it("10. formatCV returns FormattedComparedValue with all string fields", () => {
    const result = formatCV(cvPass, 4);
    expect(typeof result.ours).toBe("string");
    expect(typeof result.ngspice).toBe("string");
    expect(typeof result.delta).toBe("string");
    expect(typeof result.absDelta).toBe("string");
    expect(typeof result.relDelta).toBe("string");
    expect(typeof result.withinTol).toBe("boolean");
    expect(typeof result.summary).toBe("string");
    expect(result.withinTol).toBe(true);
    expect(result.summary).toBe(formatComparedValue(cvPass, 4));
  });

  it("11. formatComparedTable with 3 entries — sorted by absDelta desc, contains headers", () => {
    const entries: Record<string, ComparedValue> = {
      slot_a: { ours: 1, ngspice: 1.01, delta: -0.01, absDelta: 0.01, relDelta: 0.01, withinTol: true },
      slot_b: { ours: 1, ngspice: 1.5, delta: -0.5, absDelta: 0.5, relDelta: 0.33, withinTol: false },
      slot_c: { ours: 1, ngspice: 1.001, delta: -0.001, absDelta: 0.001, relDelta: 0.001, withinTol: true },
    };
    const result = formatComparedTable(entries, 4);
    const lines = result.split("\n");
    expect(lines[0]).toContain("slot");
    expect(lines[1]).toContain("slot_b");
    expect(lines[2]).toContain("slot_a");
    expect(lines[3]).toContain("slot_c");
    expect(result).toContain("FAIL");
    expect(result).toContain("PASS");
  });

  it("12. mapToRecord converts Map<number|string, V> to Record<string, V>", () => {
    const map = new Map<number | string, string>([[1, "a"], [2, "b"]]);
    const result = mapToRecord(map);
    expect(result).toEqual({ "1": "a", "2": "b" });
  });

  it("13. float64ToArray converts NaN/Infinity to null, finite values preserved", () => {
    const arr = new Float64Array([1.0, NaN, Infinity, -Infinity]);
    const result = float64ToArray(arr);
    expect(result).toEqual([1.0, null, null, null]);
  });
});
