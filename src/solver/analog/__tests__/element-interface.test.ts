/**
 * Structural-typing tests for AnalogElementCore post-Wave-6.1 shape.
 *
 * These tests verify at compile time (via @ts-expect-error guards) and at
 * runtime (via property-existence checks) that AnalogElementCore has the
 * correct method surface after the C1.1 migration.
 */

import { describe, it, expect } from "vitest";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { LoadContext } from "../load-context.js";

// ---------------------------------------------------------------------------
// Minimal conforming implementation
// ---------------------------------------------------------------------------

/**
 * Minimal object that satisfies AnalogElementCore with only the required
 * fields. Used to verify the post-migration shape type-checks correctly.
 */
function makeMinimalCore(): AnalogElementCore {
  return {
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    load(_ctx: LoadContext): void {
      // minimal no-op
    },
    setParam(_key: string, _value: number): void {
      // minimal no-op
    },
    getPinCurrents(_voltages: Float64Array): number[] {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnalogElementCore", () => {
  it("has_load_method", () => {
    const core = makeMinimalCore();
    // Runtime assertion: load must be a function
    expect(typeof core.load).toBe("function");
    // stamp / stampNonlinear / updateOperatingPoint must NOT exist
    expect((core as any).stamp).toBeUndefined();
    expect((core as any).stampNonlinear).toBeUndefined();
    expect((core as any).updateOperatingPoint).toBeUndefined();
    expect((core as any).stampCompanion).toBeUndefined();
    expect((core as any).stampReactiveCompanion).toBeUndefined();
    expect((core as any).updateChargeFlux).toBeUndefined();
    expect((core as any).updateState).toBeUndefined();
    expect((core as any).shouldBypass).toBeUndefined();
    expect((core as any).getBreakpoints).toBeUndefined();
  });

  it("rejects_deleted_methods", () => {
    // Each @ts-expect-error line asserts that assigning the listed deleted
    // method to an AnalogElementCore variable is a compile-time error.
    // If the interface mistakenly re-adds any of these, tsc will error on
    // the @ts-expect-error directive itself, turning this test red.

    // @ts-expect-error stamp is not part of AnalogElementCore
    const _withStamp: AnalogElementCore = {
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      stamp(_solver: unknown): void {},
      load(_ctx: LoadContext): void {},
      setParam(_key: string, _value: number): void {},
      getPinCurrents(_voltages: Float64Array): number[] { return []; },
    };

    // @ts-expect-error stampNonlinear is not part of AnalogElementCore
    const _withStampNonlinear: AnalogElementCore = {
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      stampNonlinear(_solver: unknown): void {},
      load(_ctx: LoadContext): void {},
      setParam(_key: string, _value: number): void {},
      getPinCurrents(_voltages: Float64Array): number[] { return []; },
    };

    // @ts-expect-error updateOperatingPoint is not part of AnalogElementCore
    const _withUpdateOp: AnalogElementCore = {
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      updateOperatingPoint(_voltages: Float64Array): void {},
      load(_ctx: LoadContext): void {},
      setParam(_key: string, _value: number): void {},
      getPinCurrents(_voltages: Float64Array): number[] { return []; },
    };

    // Suppress unused variable warnings
    void _withStamp;
    void _withStampNonlinear;
    void _withUpdateOp;

    // If we reach here the @ts-expect-error directives are doing their job
    expect(true).toBe(true);
  });

  it("checkConvergence_is_single_arg", () => {
    // A fixture implementing the old 4-arg checkConvergence should fail tsc.
    // A fixture implementing the new 1-arg (ctx: LoadContext) should pass.

    // New correct 1-arg signature — must type-check without error
    const coreWithNewSig: AnalogElementCore = {
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      load(_ctx: LoadContext): void {},
      checkConvergence(_ctx: LoadContext): boolean { return true; },
      setParam(_key: string, _value: number): void {},
      getPinCurrents(_voltages: Float64Array): number[] { return []; },
    };

    expect(typeof coreWithNewSig.checkConvergence).toBe("function");

    // Old 4-arg signature — must fail tsc (compile-time negative assertion)
    // @ts-expect-error checkConvergence must take a single LoadContext arg, not 4 args
    const _coreWithOldSig: AnalogElementCore = {
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      checkConvergence(
        _voltages: Float64Array,
        _prevVoltages: Float64Array,
        _reltol: number,
        _abstol: number,
      ): boolean { return true; },
      load(_ctx: LoadContext): void {},
      setParam(_key: string, _value: number): void {},
      getPinCurrents(_voltages: Float64Array): number[] { return []; },
    };

    void _coreWithOldSig;
    expect(true).toBe(true);
  });
});
