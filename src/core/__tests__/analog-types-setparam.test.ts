import { describe, it, expect } from "vitest";
import type { AnalogElementCore } from "../analog-types.js";

describe("AnalogElementCore.setParam", () => {
  it("is required on the interface (not optional)", () => {
    // @ts-expect-error — missing setParam should be a type error
    const _bad: AnalogElementCore = {
      pinNodeIds: [],
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      stamp() {},
    };
    // If this compiles without the @ts-expect-error triggering,
    // setParam is still optional — that's a bug.
    expect(_bad).toBeDefined();
  });

  it("accepts a conforming object with setParam", () => {
    const good: AnalogElementCore = {
      pinNodeIds: [],
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      stamp() {},
      setParam(_key: string, _value: number) {},
    };
    expect(typeof good.setParam).toBe("function");
  });
});
