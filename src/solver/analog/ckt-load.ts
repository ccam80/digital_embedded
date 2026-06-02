/**
 * cktLoad- single-pass device load.
 *
 * Matches ngspice cktload.c:29-158. One call to element.load() per device
 * per NR iteration. No separate updateOperatingPoint, stampNonlinear, or
 * stampReactiveCompanion passes.
 */

import type { CKTCircuitContext } from "./ckt-context.js";
import { setRHS } from "./stamp-helpers.js";
import {
  MODEDC,
  MODEINITJCT,
  MODEINITFIX,
  MODETRANOP,
  MODEUIC,
} from "./ckt-mode.js";
import { runByDeviceFamily } from "./family-dispatch.js";
import type { FamilyHandler } from "./family-registry.js";
import type { AnalogElement } from "./element.js";
import type { LoadContext } from "./load-context.js";

/**
 * Large conductance soft-pin used only in the currents=1 branch of the
 * nodeset/IC apply- when a current-type (branch) column shares the
 * constrained node's row, ZeroNoncurRow returns 1 and the row keeps a 1e10
 * diagonal large-conductance pin rather than the exact 1·v=value constraint.
 *
 * Variable mapping (ngspice → ours):
 *   cktload.c:113-115 (nodeset currents=1: *(node->ptr) = 1e10) → CKTNS_PIN
 *   cktload.c:139-141 (IC currents=1:      *(node->ptr) += 1e10) → CKTNS_PIN
 */
const CKTNS_PIN = 1e10;

/**
 * Per-element load with CKTtroubleNode tracking.
 *
 * Preserves per-element granularity for trouble-node assignment.
 * Passed as the `defaultHandler` to `runByDeviceFamily` so that every
 * bucket without a registered specialist handler executes the
 * `el.load(ctx)` + noncon-check body.
 *
 * cite: cktload.c:61-75 -- per-type DEVload loop.
 * cite: cktload.c:64-65 -- CKTtroubleNode reset when noncon rises.
 */
function makeTroubleTrackingHandler(
  ctx: CKTCircuitContext,
): FamilyHandler {
  return {
    run(loadCtx: unknown, instances: readonly AnalogElement[]): void {
      const lctx = loadCtx as LoadContext;
      for (const el of instances) {
        el.load(lctx);
        if (lctx.noncon.value > 0) {
          // cktload.c:64-65 — clear the trouble node and element so a stale
          // blame from a prior iteration does not leak. The device's own
          // convTest (dioconv.c:61) sets CKTtroubleElt; the NR-layer niConvTest
          // sets CKTtroubleNode.
          ctx.troubleNode = null;
          ctx.troubleElt = null;
        }
      }
    },
  };
}

/**
 * Single-pass device load function.
 *
 * Matches ngspice cktload.c:29-158:
 *   1. Clear matrix and RHS (beginAssembly)
 *   2. Propagate per-call scalars to loadCtx (cktMode, voltages, srcFact, gmin)
 *   3. Single device loop- element.load(ctx.loadCtx) with null-guard
 *   4. Apply nodesets (MODEDC + MODEINITJCT|MODEINITFIX gate)
 *   5. Apply ICs (MODETRANOP + !MODEUIC gate)
 *   6. Finalize matrix
 *
 * Variable mapping (ngspice -> ours):
 *   CKTdelta      -> ctx.loadCtx.dt       (set by engine before NR call)
 *   CKTmode       -> ctx.loadCtx.cktMode  (mirrored from ctx.cktMode each call)
 *   CKTag[]       -> ctx.loadCtx.ag        (set by engine via computeNIcomCof)
 *   CKTnoncon     -> ctx.loadCtx.noncon.value  (mutable ref -- elements increment)
 *   CKTsrcFact    -> ctx.loadCtx.srcFact
 *   CKTgmin       -> ctx.loadCtx.cktGmin   (static; set once at construction)
 *   CKTdiagGmin   -> ctx.loadCtx.diagGmin  (gmin-stepping active value)
 *   CKTtroubleNode-> ctx.troubleNode      (zeroed each time noncon rises)
 */
export function cktLoad(ctx: CKTCircuitContext): void {
  // Step 1: clear matrix and RHS (ngspice cktload.c:52-56).
  //   size = SMPmatSize(ckt->CKTmatrix);
  //   for (i = 0; i <= size; i++) ckt->CKTrhs[i] = 0;
  //   SMPclear(ckt->CKTmatrix);
  // Note: ngspice cktload.c:57-58- CKTnoncon is NOT reset here in the
  // default build; it only runs under `#ifdef STEPDEBUG`. NR owner
  // (newtonRaphson) is responsible for `ctx.noncon = 0` before the call.
  ctx.rhs.fill(0);
  ctx.solver._resetForAssembly();

  // Step 2: propagate per-call context scalars to loadCtx.
  ctx.loadCtx.cktMode  = ctx.cktMode;   // single source of truth (F3/F4).
  ctx.loadCtx.srcFact  = ctx.srcFact;
  ctx.loadCtx.diagGmin = ctx.diagonalGmin;
  // H1 (Phase 2.5 W2.2): sync the limiting-event collector into the device-
  // facing LoadContext on every cktLoad call. Devices push into
  // ctx.limitingCollector (the LoadContext param they receive) when they
  // invoke pnjlim/fetlim/limvds- without this propagation, the outer
  // CKTCircuitContext.limitingCollector set by analog-engine.ts (:449/:790/
  // :884) would be invisible to device code, so harness assertions that
  // look at the collector would see zero events.
  //
  // ngspice reference: niiter.c:657-660 resets ni_limit_count at the top of
  // every NR iteration (`ckt->CKTnoncon = 0; ni_limit_reset();`) BEFORE
  // CKTload runs. The NR loop in newton-raphson.ts already performs the
  // `.length = 0` reset at iteration top (lines 323-325); this sync wires
  // the per-iteration state through to the device-facing ctx. Pairing the
  // sync with the other per-call scalar propagations in cktLoad guarantees
  // every invocation- NR loop, dcopFinalize (dcop.c:153), or UIC early-
  // exit (niiter.c:628-637)- sees a consistent collector reference on the
  // LoadContext handed to devices.
  ctx.loadCtx.limitingCollector = ctx.limitingCollector;

  // Step 3: per-type device load (ngspice cktload.c:61-75).
  // runByDeviceFamily iterates family buckets in ascending min(ngspiceLoadOrder)
  // order, matching ngspice's `for i in DEVmaxnum: DEVices[i]->DEVload(ckt)`.
  // The default handler here is a locally-constructed wrapper that preserves
  // the per-element CKTtroubleNode tracking per cktload.c:64-65.
  runByDeviceFamily(ctx.elementsByFamily, "load", ctx.loadCtx, makeTroubleTrackingHandler(ctx));

  // Step 4a: nodeset enforcement. ngspice cktload.c:108-129.
  // Gate: (CKTmode & MODEDC) && (CKTmode & (MODEINITJCT | MODEINITFIX))
  //- any DC-family analysis (DCOP, TRANOP, DCTRANCURVE) during JCT or FIX.
  //
  // Zero the constrained node's non-current row (zeroNoncurRow); a pure-
  // voltage row gets an exact 1·v=value constraint, a row sharing a branch
  // (current) column keeps the 1e10 soft-pin.
  //
  // Variable mapping (ngspice cktload.c → ours):
  //   ckt->CKTnodes (node->nsGiven) → ctx.nodesets
  //   node->ptr (diagonal)          → ctx.nodesetHandles.get(node)
  //   ZeroNoncurRow(...)            → zeroNoncurRow(ctx, node)
  //   *(node->ptr) = 1e10 / = 1     → zeroElement(diag); stampElement(diag, K)
  //   CKTrhs[node->number] = …      → setRHS(ctx.rhs, node, …)  (assignment)
  //   CKTsrcFact                    → ctx.srcFact
  if ((ctx.cktMode & MODEDC) && (ctx.cktMode & (MODEINITJCT | MODEINITFIX))) {
    for (const [node, value] of ctx.nodesets) {
      const diag = ctx.nodesetHandles.get(node)!;
      if (zeroNoncurRow(ctx, node)) {
        // cktload.c:113-115- currents=1 branch: 1e10·value RHS + diagonal
        // large-conductance soft-pin. *(node->ptr) = 1e10 is an assignment;
        // zeroElement(diag) (already zeroed by zeroNoncurRow, made explicit
        // for order-independence) + stampElement(diag, 1e10) reproduces it.
        ctx.solver.zeroElement(diag);
        ctx.solver.stampElement(diag, CKTNS_PIN);
        setRHS(ctx.rhs, node, CKTNS_PIN * value * ctx.srcFact);
      } else {
        // cktload.c:117-119- pure-voltage branch: exact 1·v = value.
        // *(node->ptr) = 1 (assignment) + CKTrhs[node] = value·srcFact.
        ctx.solver.zeroElement(diag);
        ctx.solver.stampElement(diag, 1.0);
        setRHS(ctx.rhs, node, value * ctx.srcFact);
      }
    }
  }

  // Step 4b: IC enforcement. ngspice cktload.c:131-158.
  // Gate: (CKTmode & MODETRANOP) && !(CKTmode & MODEUIC)
  //- transient-boot DCOP only, and only when UIC was NOT requested.
  //
  // Same row-zero mechanism as nodeset. One deliberate asymmetry vs. nodeset,
  // mirrored literally: the IC currents=1 branch does *(node->ptr) += 1e10
  // (cktload.c:141, accumulate onto the just-zeroed diagonal) where nodeset
  // does = 1e10. After zeroNoncurRow the diagonal is 0, so += 1e10 and = 1e10
  // produce the identical value; zeroElement(diag) + stampElement(diag, 1e10)
  // reproduces both bit-exact.
  //
  // Variable mapping (ngspice cktload.c → ours):
  //   ckt->CKTnodes (node->icGiven) → ctx.ics
  //   node->ptr (diagonal)          → ctx.icHandles.get(node)
  //   ZeroNoncurRow(...)            → zeroNoncurRow(ctx, node)
  //   *(node->ptr) += 1e10 / = 1    → zeroElement(diag); stampElement(diag, K)
  //   CKTrhs[node->number] = …      → setRHS(ctx.rhs, node, …)  (assignment)
  //   CKTsrcFact                    → ctx.srcFact
  if ((ctx.cktMode & MODETRANOP) && !(ctx.cktMode & MODEUIC)) {
    for (const [node, value] of ctx.ics) {
      const diag = ctx.icHandles.get(node)!;
      if (zeroNoncurRow(ctx, node)) {
        // cktload.c:139-141- currents=1: 1e10·ic RHS + (zeroed diag) += 1e10.
        ctx.solver.zeroElement(diag);
        ctx.solver.stampElement(diag, CKTNS_PIN);
        setRHS(ctx.rhs, node, CKTNS_PIN * value * ctx.srcFact);
      } else {
        // cktload.c:145-147- pure-voltage: exact 1·v = ic.
        ctx.solver.zeroElement(diag);
        ctx.solver.stampElement(diag, 1.0);
        setRHS(ctx.rhs, node, value * ctx.srcFact);
      }
    }
  }

  // Step 5: finalize matrix
}

/**
 * cktload.c:167-186 (ZeroNoncurRow) — zero the non-current entries of row
 * `row` and report whether any current-type (branch) column shares the row.
 * A pure-voltage row (returns false) is then driven by an exact 1·v=value
 * constraint; a row touched by a branch column (returns true) keeps the 1e10
 * soft-pin. File-private, mirroring the `static` linkage in cktload.c.
 *
 * Mechanism: walk every candidate column; look up the cell (row, col)
 * read-only. If the cell exists, then either the column is a current-type
 * (branch) row- record currents=true, leave the cell- or it is a voltage
 * column- zero that off-diagonal/diagonal cell.
 *
 * Variable mapping (ngspice cktload.c → ours):
 *   matrix                → ctx.solver
 *   nodes (CKTnode list)  → candidate column indices 1 … size
 *   rownum                → row (the constrained node's slot)
 *   n->number             → col (a candidate column slot)
 *   n->type == SP_CURRENT (cktdefs.h:46) → ctx.nodeType(col) === "current"
 *   SMPfindElt(...,0)      → ctx.solver.findElement(row, col)
 *   if (x)                 → handle >= 0
 *   *x = 0.0               → ctx.solver.zeroElement(handle)
 *   return currents        → return currents
 */
function zeroNoncurRow(ctx: CKTCircuitContext, row: number): boolean {
  let currents = false;
  // ngspice walks ckt->CKTnodes keyed by n->number = the external matrix
  // index; digiTS's external indices are the contiguous slots 1 … size, so
  // this visits exactly the same column set (cktload.c:175).
  const size = ctx.solver.size;
  for (let col = 1; col <= size; col++) {
    // cktload.c:176- read-only lookup of cell (rownum, n->number).
    const handle = ctx.solver.findElement(row, col);
    if (handle < 0) continue; // cktload.c:177- !x: cell does not exist, skip.
    if (ctx.nodeType(col) === "current") {
      // cktload.c:178-179- a current-type column shares the row.
      currents = true;
    } else {
      // cktload.c:181- zero the voltage-column entry of this row.
      ctx.solver.zeroElement(handle);
    }
  }
  return currents; // cktload.c:185.
}
