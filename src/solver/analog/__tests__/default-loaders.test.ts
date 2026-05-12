/**
 * Unit tests for default per-instance family handlers.
 *
 * Verifies that each handler iterates all elements in its bucket and calls
 * the correct optional method, skipping elements that do not implement it.
 *
 * These handlers are the fallback path in `runByDeviceFamily` for any
 * (family, callback) pair absent from FAMILY_REGISTRY.
 */

import { describe, it, expect, vi } from "vitest";
import {
  defaultLoadHandler,
  defaultStampAcHandler,
  defaultTemperatureHandler,
  type AcHandlerCtx,
} from "../loaders/default-loaders.js";

// ---------------------------------------------------------------------------
// Minimal stub helpers -- structural types only, no engine imports
// ---------------------------------------------------------------------------

function makeLoadCtx(): object {
  return {}; // opaque -- elements receive it as-is
}

function makeElement(overrides: Record<string, unknown> = {}): object {
  return {
    load: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// defaultLoadHandler
// ---------------------------------------------------------------------------

describe("defaultLoadHandler", () => {
  it("calls el.load(ctx) for every element in the bucket", () => {
    const ctx = makeLoadCtx();
    const el1 = makeElement();
    const el2 = makeElement();

    defaultLoadHandler.run(ctx, [el1, el2] as never);

    expect((el1 as { load: ReturnType<typeof vi.fn> }).load).toHaveBeenCalledOnce();
    expect((el1 as { load: ReturnType<typeof vi.fn> }).load).toHaveBeenCalledWith(ctx);
    expect((el2 as { load: ReturnType<typeof vi.fn> }).load).toHaveBeenCalledOnce();
    expect((el2 as { load: ReturnType<typeof vi.fn> }).load).toHaveBeenCalledWith(ctx);
  });

  it("handles an empty bucket without throwing", () => {
    expect(() => defaultLoadHandler.run(makeLoadCtx(), [])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// defaultStampAcHandler
// ---------------------------------------------------------------------------

describe("defaultStampAcHandler", () => {
  it("calls el.stampAc(solver, omega, loadCtx) for elements that implement it", () => {
    const solver = {};
    const omega = 6283.185;
    const loadCtx = makeLoadCtx();
    const acCtx: AcHandlerCtx = { solver: solver as never, omega, loadCtx: loadCtx as never };

    const stampAc = vi.fn();
    const el = makeElement({ stampAc });

    defaultStampAcHandler.run(acCtx, [el] as never);

    expect(stampAc).toHaveBeenCalledOnce();
    expect(stampAc).toHaveBeenCalledWith(solver, omega, loadCtx);
  });

  it("skips elements that do not implement stampAc (optional method)", () => {
    const acCtx: AcHandlerCtx = {
      solver: {} as never,
      omega: 1000,
      loadCtx: {} as never,
    };
    const elWithout = makeElement(); // no stampAc

    expect(() =>
      defaultStampAcHandler.run(acCtx, [elWithout] as never)
    ).not.toThrow();
  });

  it("calls stampAc on implementing elements and skips non-implementing ones in the same bucket", () => {
    const solver = {};
    const omega = 314.159;
    const loadCtx = makeLoadCtx();
    const acCtx: AcHandlerCtx = { solver: solver as never, omega, loadCtx: loadCtx as never };

    const stampAc = vi.fn();
    const elWith = makeElement({ stampAc });
    const elWithout = makeElement(); // no stampAc

    defaultStampAcHandler.run(acCtx, [elWith, elWithout] as never);

    expect(stampAc).toHaveBeenCalledOnce();
    expect(stampAc).toHaveBeenCalledWith(solver, omega, loadCtx);
  });

  it("handles an empty bucket without throwing", () => {
    const acCtx: AcHandlerCtx = { solver: {} as never, omega: 0, loadCtx: {} as never };
    expect(() => defaultStampAcHandler.run(acCtx, [])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// defaultTemperatureHandler
// ---------------------------------------------------------------------------

describe("defaultTemperatureHandler", () => {
  it("calls el.computeTemperature(ctx) for elements that implement it", () => {
    const ctx = { cktTemp: 300.15, cktNomTemp: 300.15 };
    const computeTemperature = vi.fn();
    const el = makeElement({ computeTemperature });

    defaultTemperatureHandler.run(ctx, [el] as never);

    expect(computeTemperature).toHaveBeenCalledOnce();
    expect(computeTemperature).toHaveBeenCalledWith(ctx);
  });

  it("skips elements that do not implement computeTemperature (optional method)", () => {
    const ctx = { cktTemp: 350, cktNomTemp: 300.15 };
    const elWithout = makeElement(); // no computeTemperature

    expect(() =>
      defaultTemperatureHandler.run(ctx, [elWithout] as never)
    ).not.toThrow();
  });

  it("calls computeTemperature on implementing elements and skips non-implementing ones", () => {
    const ctx = { cktTemp: 400, cktNomTemp: 300.15 };
    const computeTemperature = vi.fn();
    const elWith = makeElement({ computeTemperature });
    const elWithout = makeElement();

    defaultTemperatureHandler.run(ctx, [elWith, elWithout] as never);

    expect(computeTemperature).toHaveBeenCalledOnce();
    expect(computeTemperature).toHaveBeenCalledWith(ctx);
  });

  it("handles an empty bucket without throwing", () => {
    const ctx = { cktTemp: 300.15, cktNomTemp: 300.15 };
    expect(() => defaultTemperatureHandler.run(ctx, [])).not.toThrow();
  });
});
