/**
 * Tests for DataField- task 4.3.5.
 */

import { describe, it, expect } from "vitest";
import { DataField, parseDataFieldString, serializeDataField } from "../data-field";

describe("DataField", () => {
  it("parseSimple", () => {
    const df = parseDataFieldString("0,1,2,ff");
    expect(df.getWord(0)).toBe(0n);
    expect(df.getWord(1)).toBe(1n);
    expect(df.getWord(2)).toBe(2n);
    expect(df.getWord(3)).toBe(255n);
    expect(df.size()).toBe(4);
  });

  it("parseRunLength", () => {
    const df = parseDataFieldString("4*0,ff");
    expect(df.size()).toBe(5);
    expect(df.getWord(0)).toBe(0n);
    expect(df.getWord(1)).toBe(0n);
    expect(df.getWord(2)).toBe(0n);
    expect(df.getWord(3)).toBe(0n);
    expect(df.getWord(4)).toBe(255n);
  });

  it("parseRunLengthMultiple", () => {
    const df = parseDataFieldString("3*a,2*ff,1");
    expect(df.size()).toBe(6);
    expect(df.getWord(0)).toBe(10n);
    expect(df.getWord(1)).toBe(10n);
    expect(df.getWord(2)).toBe(10n);
    expect(df.getWord(3)).toBe(255n);
    expect(df.getWord(4)).toBe(255n);
    expect(df.getWord(5)).toBe(1n);
  });

  it("parseEmpty", () => {
    const df = parseDataFieldString("");
    expect(df.size()).toBe(0);
  });

  it("parseWithWhitespace", () => {
    const df = parseDataFieldString("  0  ,  1  ,  2  ");
    expect(df.size()).toBe(3);
    expect(df.getWord(1)).toBe(1n);
  });

  it("serializeRoundTrip", () => {
    const original = parseDataFieldString("1,2,3,ff,100");
    const serialized = serializeDataField(original);
    const restored = parseDataFieldString(serialized);
    expect(restored.size()).toBe(original.size());
    for (let i = 0; i < original.size(); i++) {
      expect(restored.getWord(i)).toBe(original.getWord(i));
    }
  });

  it("serializeRoundTripWithRunLength", () => {
    const df = new DataField(8);
    for (let i = 0; i < 8; i++) df.setWord(i, i < 5 ? 0n : 1n);
    const serialized = serializeDataField(df);
    const restored = parseDataFieldString(serialized);
    expect(restored.getWord(4)).toBe(0n);
    expect(restored.getWord(5)).toBe(1n);
  });

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

  it("serializeUsesRunLengthEncoding", () => {
    const df = new DataField(5);
    for (let i = 0; i < 5; i++) df.setWord(i, 0xabcdn);
    const serialized = serializeDataField(df);
    expect(serialized).toMatch(/5\*abcd/i);
  });
});
