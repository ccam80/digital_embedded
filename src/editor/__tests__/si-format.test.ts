/**
 * Tests for formatSI / parseSI — SI prefix formatting and parsing.
 */

import { describe, it, expect } from "vitest";
import { formatSI, parseSI } from "@/editor/si-format";

describe("formatSI", () => {
  it("milliamps", () => {
    expect(formatSI(0.0047, "A")).toBe("4.70 mA");
  });

  it("kilohms", () => {
    expect(formatSI(2200, "Ω")).toBe("2.20 kΩ");
  });

  it("microfarads", () => {
    expect(formatSI(1e-6, "F")).toBe("1.00 µF");
  });

  it("zero", () => {
    expect(formatSI(0, "V")).toBe("0.00 V");
  });

  it("negative", () => {
    expect(formatSI(-3.3, "V")).toBe("-3.30 V");
  });

  it("very_small", () => {
    expect(formatSI(1e-14, "A")).toBe("10.0 fA");
  });
});

describe("parseSI", () => {
  it("bare number", () => {
    expect(parseSI("47")).toBe(47);
  });

  it("kilo prefix", () => {
    expect(parseSI("4.7k")).toBe(4700);
  });

  it("kilo with unit suffix", () => {
    expect(parseSI("4.7kΩ")).toBe(4700);
  });

  it("mega prefix", () => {
    expect(parseSI("1.5M")).toBe(1.5e6);
  });

  it("micro with u", () => {
    expect(parseSI("2.2uF")).toBe(2.2e-6);
  });

  it("micro with µ", () => {
    expect(parseSI("2.2µF")).toBe(2.2e-6);
  });

  it("nano prefix", () => {
    expect(parseSI("100n")).toBeCloseTo(1e-7, 20);
  });

  it("pico prefix", () => {
    expect(parseSI("33pF")).toBeCloseTo(33e-12, 20);
  });

  it("femto prefix", () => {
    expect(parseSI("10f")).toBeCloseTo(1e-14, 20);
  });

  it("milli prefix", () => {
    expect(parseSI("4.7mA")).toBe(0.0047);
  });

  it("giga prefix", () => {
    expect(parseSI("1G")).toBe(1e9);
  });

  it("tera prefix", () => {
    expect(parseSI("2.2T")).toBe(2.2e12);
  });

  it("with spaces", () => {
    expect(parseSI("4.7 kΩ")).toBe(4700);
  });

  it("negative value", () => {
    expect(parseSI("-3.3V")).toBe(-3.3);
  });

  it("scientific notation", () => {
    expect(parseSI("1e-6")).toBe(1e-6);
  });

  it("meg SPICE convention", () => {
    expect(parseSI("10meg")).toBe(10e6);
  });

  it("uppercase K accepted", () => {
    expect(parseSI("10K")).toBe(10000);
  });

  it("empty string returns NaN", () => {
    expect(parseSI("")).toBeNaN();
  });

  it("garbage returns NaN", () => {
    expect(parseSI("abc")).toBeNaN();
  });
});

describe("parseSI ↔ formatSI round-trip", () => {
  const cases = [
    { value: 4700, unit: "Ω" },
    { value: 1e-6, unit: "F" },
    { value: 1e-3, unit: "H" },
    { value: 0.0047, unit: "A" },
    { value: 2.2e6, unit: "Hz" },
    { value: 1e-14, unit: "A" },
  ];

  for (const { value, unit } of cases) {
    it(`round-trips ${value} ${unit}`, () => {
      const formatted = formatSI(value, unit);
      const parsed = parseSI(formatted);
      expect(parsed).toBeCloseTo(value, 10);
    });
  }
});
