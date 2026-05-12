/**
 * cktLoad- single-pass device load.
 *
 * Matches ngspice cktload.c:29-158. One call to element.load() per device
 * per NR iteration. No separate updateOperatingPoint, stampNonlinear, or
 * stampReactiveCompanion passes.
 */

import type { CKTCircuitContext } from "./ckt-context.js";
import { stampRHS } from "./stamp-helpers.js";
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
 * Large conductance used to enforce nodeset and IC node voltages.
 * Matches ngspice cktload.c:96-136: 1e10 siemens pin to a voltage source.
 *
 * Variable mapping (ngspice → ours):
 *   cktload.c:113 (1e10 conductance) → CKTNS_PIN
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
          ctx.troubleNode = null;
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

  // Step 4a: nodeset enforcement. ngspice cktload.c:104-129.
  // Gate: (CKTmode & MODEDC) && (CKTmode & (MODEINITJCT | MODEINITFIX))
  //- any DC-family analysis (DCOP, TRANOP, DCTRANCURVE) during JCT or FIX.
  //
  // Variable mapping (ngspice cktload.c → ours):
  //   ckt->CKTnodeset    → ctx.nodesets
  //   1e10 (conductance) → CKTNS_PIN
  //   *ckt->CKTrhs       → ctx.rhs
  //   CKTsrcFact         → ctx.srcFact
  if ((ctx.cktMode & MODEDC) && (ctx.cktMode & (MODEINITJCT | MODEINITFIX))) {
    for (const [node, value] of ctx.nodesets) {
      ctx.solver.stampElement(ctx.nodesetHandles.get(node)!, CKTNS_PIN);
      stampRHS(ctx.rhs, node, CKTNS_PIN * value * ctx.srcFact);
    }
  }

  // Step 4b: IC enforcement. ngspice cktload.c:130-157.
  // Gate: (CKTmode & MODETRANOP) && !(CKTmode & MODEUIC)
  //- transient-boot DCOP only, and only when UIC was NOT requested.
  //
  // Variable mapping (ngspice cktload.c → ours):
  //   ckt->CKTnodeValues → ctx.ics
  //   1e10 (conductance) → CKTNS_PIN
  //   CKTsrcFact         → ctx.srcFact
  if ((ctx.cktMode & MODETRANOP) && !(ctx.cktMode & MODEUIC)) {
    for (const [node, value] of ctx.ics) {
      ctx.solver.stampElement(ctx.icHandles.get(node)!, CKTNS_PIN);
      stampRHS(ctx.rhs, node, CKTNS_PIN * value * ctx.srcFact);
    }
  }

  // Step 5: finalize matrix
}
