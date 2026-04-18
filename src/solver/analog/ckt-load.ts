/**
 * cktLoad — single-pass device load.
 *
 * Matches ngspice cktload.c:29-158. One call to element.load() per device
 * per NR iteration. No separate updateOperatingPoint, stampNonlinear, or
 * stampReactiveCompanion passes.
 */

import type { CKTCircuitContext } from "./ckt-context.js";

/**
 * Large conductance used to enforce nodeset and IC node voltages.
 * Matches ngspice cktload.c:96-136: 1e10 siemens pin to a voltage source.
 *
 * Variable mapping (ngspice → ours):
 *   cktload.c:113 (1e10 conductance) → CKTNS_PIN
 */
const CKTNS_PIN = 1e10;

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
  // Only in DC mode during initJct or initFix.
  // Both nodesets and ICs receive srcFact scaling on the RHS target voltage,
  // matching ngspice CKTnodeset/CKTic enforcement.
  //
  // Variable mapping (ngspice cktload.c → ours):
  //   ckt->CKTnodeset       → ctx.nodesets
  //   ckt->CKTnodeValues    → ctx.ics
  //   1e10 (conductance)    → CKTNS_PIN
  //   *ckt->CKTrhs += ...   → ctx.solver.stampRHS(node, val)
  //   CKTsrcFact            → ctx.srcFact
  if (ctx.isDcOp && (ctx.initMode === "initJct" || ctx.initMode === "initFix")) {
    for (const [node, value] of ctx.nodesets) {
      ctx.solver.stampElement(ctx.solver.allocElement(node, node), CKTNS_PIN);
      ctx.solver.stampRHS(node, CKTNS_PIN * value * ctx.srcFact);
    }
    for (const [node, value] of ctx.ics) {
      ctx.solver.stampElement(ctx.solver.allocElement(node, node), CKTNS_PIN);
      ctx.solver.stampRHS(node, CKTNS_PIN * value * ctx.srcFact);
    }
  }

  // Step 5: finalize matrix
  ctx.solver.finalize();
}
