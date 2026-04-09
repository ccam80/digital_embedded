import { describe, it, expect } from "vitest";
import { formatNumber, formatComparedValue, suggestComponents } from "../harness-format.js";
import type { FormattedNumber, ComparedValueJSON } from "../harness-format.js";

describe("formatNumber", () => {
  it("returns raw: null and display '—' for NaN", () => {
    const result = formatNumber(NaN);
    expect(result.raw).toBeNull();
    expect(result.display).toBe("—");
  });

  it("returns raw: Infinity and display '+Inf' for positive infinity", () => {
    const result = formatNumber(Infinity);
    expect(result.raw).toBe(Infinity);
    expect(result.display).toBe("+Inf");
  });

  it("returns raw: -Infinity and display '-Inf' for negative infinity", () => {
    const result = formatNumber(-Infinity);
    expect(result.raw).toBe(-Infinity);
    expect(result.display).toBe("-Inf");
  });

  it("returns '0.000' for zero", () => {
    const result = formatNumber(0);
    expect(result.raw).toBe(0);
    expect(result.display).toBe("0.000");
  });

  it("uses T suffix for values >= 1e12", () => {
    const result = formatNumber(1.234e12);
    expect(result.display).toMatch(/T$/);
    expect(result.raw).toBe(1.234e12);
  });

  it("uses G suffix for values >= 1e9", () => {
    const result = formatNumber(4.567e9);
    expect(result.display).toMatch(/G$/);
  });

  it("uses M suffix for values >= 1e6", () => {
    const result = formatNumber(2.345e6);
    expect(result.display).toMatch(/M$/);
  });

  it("uses k suffix for values >= 1e3", () => {
    const result = formatNumber(1000);
    expect(result.display).toMatch(/k$/);
  });

  it("uses no suffix for values in [1, 1e3)", () => {
    const result = formatNumber(3.3);
    expect(result.display).not.toMatch(/[TGMkmunpf]$/);
    expect(result.display).toContain("3.300");
  });

  it("uses m suffix for values in [1e-3, 1)", () => {
    const result = formatNumber(3.3e-3);
    expect(result.display).toMatch(/m$/);
  });

  it("uses u suffix for values in [1e-6, 1e-3)", () => {
    const result = formatNumber(1.234e-6);
    expect(result.display).toMatch(/u$/);
  });

  it("uses n suffix for values in [1e-9, 1e-6)", () => {
    const result = formatNumber(4.567e-9);
    expect(result.display).toMatch(/n$/);
  });

  it("uses p suffix for values in [1e-12, 1e-9)", () => {
    const result = formatNumber(1.234e-12);
    expect(result.display).toMatch(/p$/);
  });

  it("uses f suffix for values < 1e-12", () => {
    const result = formatNumber(1e-15);
    expect(result.display).toMatch(/f$/);
  });

  it("includes sign for negative values", () => {
    const result = formatNumber(-3.3e-3);
    expect(result.display).toMatch(/^-/);
  });

  it("preserves raw value", () => {
    const value = 1.23456789e-6;
    const result = formatNumber(value);
    expect(result.raw).toBe(value);
  });
});

describe("formatComparedValue", () => {
  it("wraps all fields of a ComparedValue into FormattedNumber", () => {
    const cv = {
      ours: 1.5e-3,
      ngspice: 1.4e-3,
      delta: 1e-4,
      absDelta: 1e-4,
      relDelta: 0.0667,
      withinTol: true,
    };
    const result: ComparedValueJSON = formatComparedValue(cv);
    expect(result.ours.raw).toBe(cv.ours);
    expect(result.ngspice.raw).toBe(cv.ngspice);
    expect(result.delta.raw).toBe(cv.delta);
    expect(result.absDelta.raw).toBe(cv.absDelta);
    expect(result.relDelta.raw).toBe(cv.relDelta);
    expect(result.withinTol).toBe(true);
  });

  it("converts NaN fields to null raw and '—' display", () => {
    const cv = {
      ours: NaN,
      ngspice: NaN,
      delta: NaN,
      absDelta: NaN,
      relDelta: NaN,
      withinTol: false,
    };
    const result = formatComparedValue(cv);
    expect(result.ours.raw).toBeNull();
    expect(result.ours.display).toBe("—");
    expect(result.ngspice.raw).toBeNull();
  });

  it("withinTol false is preserved", () => {
    const cv = {
      ours: 1.0,
      ngspice: 2.0,
      delta: -1.0,
      absDelta: 1.0,
      relDelta: 0.5,
      withinTol: false,
    };
    const result = formatComparedValue(cv);
    expect(result.withinTol).toBe(false);
  });
});

describe("suggestComponents", () => {
  it("returns top 2 closest matches by Levenshtein distance", () => {
    const labels = ["Q1", "Q2", "R1", "C1", "D1"];
    const suggestions = suggestComponents("q1", labels);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toBe('"Q1"');
  });

  it("is case-insensitive", () => {
    const labels = ["Q1", "R1", "C1"];
    const suggestions = suggestComponents("Q1", labels);
    expect(suggestions[0]).toBe('"Q1"');
  });

  it("returns fewer than 2 if fewer labels exist", () => {
    const suggestions = suggestComponents("X1", ["Q1"]);
    expect(suggestions).toHaveLength(1);
  });

  it("wraps suggestions in double quotes", () => {
    const suggestions = suggestComponents("Q1", ["Q1", "Q2"]);
    expect(suggestions[0]).toMatch(/^"/);
    expect(suggestions[0]).toMatch(/"$/);
  });
});
