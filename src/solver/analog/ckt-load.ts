/**
 * cktLoad — single-pass device load replacing MNAAssembler.stampAll().
 *
 * Matches ngspice cktload.c:29-158. One call to element.load() per device
 * per NR iteration. No separate updateOperatingPoint, stampNonlinear, or
 * stampReactiveCompanion passes.
 */

import type { CKTCircuitContext } from "./ckt-context.js";

/**
 * Single-pass device load function.
 *
 * Matches ngspice cktload.c:29-158:
 *   1. Clear matrix and RHS (beginAssembly)
 *   2. Update per-iteration load context fields
 *   3. Single device loop — element.load(ctx.loadCtx)
 *   4. Apply nodesets/ICs (DC mode, initJct or initFix only)
 *   5. Finalize matrix
 *
 * Variable mapping (ngspice -> ours):
 *   CKTdelta      -> ctx.loadCtx.dt       (set by engine before NR call)
 *   CKTmode       -> ctx.loadCtx.initMode  (set by engine / NR loop)
 *   CKTag[]       -> ctx.loadCtx.ag        (set by engine via computeNIcomCof)
 *   CKTnoncon     -> ctx.loadCtx.noncon.value  (mutable ref -- elements increment)
 *   CKTsrcFact    -> ctx.loadCtx.srcFact
 *   CKTgmin       -> ctx.loadCtx.gmin
 *
 * @param ctx       - Circuit context carrying all solver state and buffers.
 * @param iteration - Current NR iteration index (0-based).
 */
export function cktLoad(ctx: CKTCircuitContext, iteration: number): void {
  // Step 1: clear matrix and RHS (ngspice cktload.c:34-47)
  ctx.solver.beginAssembly(ctx.matrixSize);

  // Step 2: update per-iteration load context fields
  ctx.loadCtx.iteration = iteration;
  ctx.loadCtx.voltages = ctx.rhsOld;
  ctx.loadCtx.initMode = ctx.initMode;
  ctx.loadCtx.srcFact = ctx.srcFact;
  ctx.loadCtx.gmin = ctx.diagonalGmin;
  ctx.loadCtx.isDcOp = ctx.isDcOp;
  ctx.loadCtx.isTransient = ctx.isTransient;
  ctx.loadCtx.noncon.value = 0;

  // Step 3: single device loop (ngspice cktload.c:71-95, calls DEVload)
  for (const element of ctx.elements) {
    element.load(ctx.loadCtx);
  }
  ctx.noncon = ctx.loadCtx.noncon.value;

  // Step 4: apply nodesets/ICs inside cktLoad (ngspice cktload.c:96-136)
  // Only in DC mode during initJct or initFix
  if (ctx.isDcOp && (ctx.initMode === "initJct" || ctx.initMode === "initFix")) {
    for (const [node, value] of ctx.nodesets) {
      ctx.solver.stamp(node, node, 1e10);
      ctx.solver.stampRHS(node, 1e10 * value);
    }
  }

  // Step 5: finalize matrix
  ctx.solver.finalize();
}
