/**
 * Tests for formatSI — SI prefix formatting for analog electrical values.
 */

import { describe, it, expect } from "vitest";
import { formatSI } from "@/editor/si-format";

describe("SIFormat", () => {
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
