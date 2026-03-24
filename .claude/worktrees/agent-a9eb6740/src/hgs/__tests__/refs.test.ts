/**
 * Tests for the HGS reference system — task 4.3.4.
 */

import { describe, it, expect } from "vitest";
import { HGSContext } from "../context";
import { HGSArray, HGSMap } from "../value";
import { ReferenceToVar, ReferenceToArray, ReferenceToStruct } from "../refs";
import type { LiteralExpr } from "../ast";

function litExpr(n: bigint): LiteralExpr {
  return { kind: "literal", value: n, line: 1 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Reference", () => {
  it("varReadWrite", async () => {
    const ctx = new HGSContext({ enableOutput: true });
    ctx.declareVar("x", 5n);

    const ref = new ReferenceToVar("x");

    expect(await ref.get(ctx)).toBe(5n);

    await ref.set(ctx, 10n);
    expect(await ref.get(ctx)).toBe(10n);
  });

  it("varDeclare", async () => {
    const ctx = new HGSContext({ enableOutput: true });
    const ref = new ReferenceToVar("y");

    await ref.declare(ctx, 42n);
    expect(await ref.get(ctx)).toBe(42n);
  });

  it("arrayAccess", async () => {
    const ctx = new HGSContext({ enableOutput: true });
    const arr = new HGSArray([10n, 20n, 30n]);
    ctx.declareVar("a", arr);

    const varRef = new ReferenceToVar("a");
    const arrRef = new ReferenceToArray(varRef, litExpr(1n));

    expect(await arrRef.get(ctx)).toBe(20n);

    await arrRef.set(ctx, 99n);
    expect(await arrRef.get(ctx)).toBe(99n);
    expect(arr.get(1)).toBe(99n);
  });

  it("structAccess", async () => {
    const ctx = new HGSContext({ enableOutput: true });
    const map = new HGSMap(new Map([["a", 1n]]));
    ctx.declareVar("m", map);

    const varRef = new ReferenceToVar("m");
    const structRef = new ReferenceToStruct(varRef, "a");

    expect(await structRef.get(ctx)).toBe(1n);

    await structRef.set(ctx, 2n);
    expect(await structRef.get(ctx)).toBe(2n);
  });

  it("chainedAccess", async () => {
    // obj.data[0] — ReferenceToArray(ReferenceToStruct(ReferenceToVar("obj"), "data"), 0)
    const ctx = new HGSContext({ enableOutput: true });
    const innerArr = new HGSArray([100n, 200n]);
    const map = new HGSMap(new Map<string, import("../value").HGSValue>([["data", innerArr]]));
    ctx.declareVar("obj", map);

    const objRef = new ReferenceToVar("obj");
    const dataRef = new ReferenceToStruct(objRef, "data");
    const elemRef = new ReferenceToArray(dataRef, litExpr(0n));

    expect(await elemRef.get(ctx)).toBe(100n);

    await elemRef.set(ctx, 999n);
    expect(await elemRef.get(ctx)).toBe(999n);
    expect(innerArr.get(0)).toBe(999n);
  });

  it("structDeclare adds new field", async () => {
    const ctx = new HGSContext({ enableOutput: true });
    const map = new HGSMap();
    ctx.declareVar("m", map);

    const varRef = new ReferenceToVar("m");
    const fieldRef = new ReferenceToStruct(varRef, "newField");

    await fieldRef.declare(ctx, 77n);
    expect(await fieldRef.get(ctx)).toBe(77n);
  });

  it("arrayOutOfBounds throws", async () => {
    const ctx = new HGSContext({ enableOutput: true });
    const arr = new HGSArray([1n, 2n]);
    ctx.declareVar("a", arr);

    const varRef = new ReferenceToVar("a");
    const arrRef = new ReferenceToArray(varRef, litExpr(10n));

    await expect(arrRef.get(ctx)).rejects.toThrow(/out of bounds/i);
  });

  it("structMissingFieldThrows on set", async () => {
    const ctx = new HGSContext({ enableOutput: true });
    const map = new HGSMap();
    ctx.declareVar("m", map);

    const varRef = new ReferenceToVar("m");
    const fieldRef = new ReferenceToStruct(varRef, "missing");

    await expect(fieldRef.set(ctx, 1n)).rejects.toThrow(/not declared/i);
  });
});
