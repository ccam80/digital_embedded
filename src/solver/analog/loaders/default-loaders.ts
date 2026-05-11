/**
 * Default per-instance family handlers.
 *
 * These three handlers implement the trivial per-instance walk that is
 * equivalent to the deleted flat loops in ckt-load.ts and ac-analysis.ts.
 * They are used as the `defaultHandler` fallback parameter in
 * `runByDeviceFamily` for any (family, callback) pair that has no registered
 * specialist handler in FAMILY_REGISTRY.
 *
 * cite: cktload.c:61-75   -- per-type DEVload orchestration (default = per-instance walk)
 * cite: acan.c:409-414    -- per-type DEVacLoad orchestration (default = per-instance walk)
 * cite: ckttemp.c:28-33   -- per-type DEVtemperature orchestration (default = per-instance walk)
 */

import type { FamilyHandler } from "../family-registry.js";
import type { LoadContext } from "../load-context.js";
import type { TempContext } from "../temp-context.js";
import type { ComplexSparseSolverStamp } from "../complex-sparse-solver.js";

/**
 * Context object passed to the AC stamp handler by the dispatcher.
 * Carries the complex solver, angular frequency, and the DC-OP LoadContext
 * (needed by elements whose small-signal stamps read internal device state
 * stored in the LoadContext's state vectors).
 *
 * cite: acan.c:409-414 -- DEVacLoad(ckt) receives the full CKTcircuit;
 *   solver, omega, and loadCtx are the three CKTcircuit fields accessed by
 *   every AC-stamp method in this codebase.
 */
export interface AcHandlerCtx {
  solver: ComplexSparseSolverStamp;
  omega: number;
  loadCtx: LoadContext;
}

/**
 * Default load handler -- trivial per-instance walk.
 *
 * For every element in the bucket, calls `el.load(ctx)`.
 *
 * cite: cktload.c:61-75 -- `for (i = 0; i < DEVmaxnum; i++) DEVices[i]->DEVload(ckt)`
 *   where each DEVload is, for simple devices, a trivial per-instance walk.
 */
export const defaultLoadHandler: FamilyHandler = {
  run(ctx: unknown, instances): void {
    const loadCtx = ctx as LoadContext;
    for (const el of instances) {
      el.load(loadCtx);
    }
  },
};

/**
 * Default AC stamp handler -- trivial per-instance walk.
 *
 * For every element in the bucket, calls `el.stampAc?.(solver, omega, loadCtx)`.
 * The `stampAc` method is optional on AnalogElement; elements that do not
 * implement it are silently skipped (no-op), matching ngspice's NULL function-
 * pointer guard at acan.c:410 (`if (DEVices[i]->DEVacLoad == NULL) continue`).
 *
 * cite: acan.c:409-414 -- per-type DEVacLoad loop.
 */
export const defaultStampAcHandler: FamilyHandler = {
  run(ctx: unknown, instances): void {
    const { solver, omega, loadCtx } = ctx as AcHandlerCtx;
    for (const el of instances) {
      el.stampAc?.(solver, omega, loadCtx);
    }
  },
};

/**
 * Default temperature handler -- trivial per-instance walk.
 *
 * Mirrors ngspice ckttemp.c:28-33: `for (i = 0; i < DEVmaxnum; i++)`
 * `  DEVices[i]->DEVtemperature(ckt)`.
 * For every element in the bucket, calls `el.computeTemperature?.(ctx)`.
 * The `computeTemperature` method is optional on AnalogElement; elements
 * that do not declare it are silently skipped (no-op), matching ngspice's
 * NULL function-pointer guard at ckttemp.c:29.
 *
 * cite: ckttemp.c:28-33 -- per-type DEVtemperature loop.
 */
export const defaultTemperatureHandler: FamilyHandler = {
  run(ctx: unknown, instances): void {
    const tempCtx = ctx as TempContext;
    for (const el of instances) {
      el.computeTemperature?.(tempCtx);
    }
  },
};
