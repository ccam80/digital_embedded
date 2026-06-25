/**
 * Tests for DataField.
 */

import { describe, it, expect } from "vitest";
import { DataField } from "../data-field";

describe("DataField", () => {
  it("trimTrailingZeros", () => {
    const df = new DataField(6);
    df.setWord(0, 1n);
    df.setWord(1, 2n);
    // words 2-5 remain 0
    df.trim();
    expect(df.size()).toBe(2);
    expect(df.getWord(0)).toBe(1n);
    expect(df.getWord(1)).toBe(2n);
  });

  it("trimAllZeros", () => {
    const df = new DataField(4);
    df.trim();
    expect(df.size()).toBe(0);
  });

  it("setWordBeyondCapacityGrows", () => {
    const df = new DataField(2);
    df.setWord(10, 42n);
    expect(df.getWord(10)).toBe(42n);
    expect(df.size()).toBeGreaterThanOrEqual(11);
  });

  it("getWordBeyondSizeReturnsZero", () => {
    const df = new DataField(2);
    expect(df.getWord(100)).toBe(0n);
  });
});
