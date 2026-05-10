/**
 * IND_FAMILY 3-pass load handler.
 *
 * Mirrors the complete body of ngspice indload.c INDload (lines 35-127),
 * which is structured as three sequential device-type sweeps under the
 * MUTUAL compile flag:
 *
 *   Pass 1 (indload.c:38-50):  IND flux init
 *     Loop all INDmodel/INDinstance: if !(MODEDC|MODEINITPRED), write
 *     CKTstate0[INDflux] from CKTrhsOld[INDbrEq] (or UIC seed).
 *
 *   Pass 2 (indload.c:58-76):  MUT coupling
 *     Loop all MUTmodel/MUTinstance:
 *       - flux augmentation (gated on !(MODEDC|MODEINITPRED)):
 *           CKTstate0[ind1->INDflux] += MUTfactor * CKTrhsOld[ind2->INDbrEq]
 *           CKTstate0[ind2->INDflux] += MUTfactor * CKTrhsOld[ind1->INDbrEq]
 *       - matrix stamps (unconditional):
 *           *(MUTbr1br2) -= MUTfactor * CKTag[0]
 *           *(MUTbr2br1) -= MUTfactor * CKTag[0]
 *
 *   Pass 3 (indload.c:90-127): IND NIintegrate + 5-stamp
 *     Loop all INDmodel/INDinstance again: run NIintegrate companion model
 *     and stamp the 5 matrix/RHS entries.
 *
 * The 3-pass ordering is critical: MUT must augment partner flux AFTER IND
 * flux-init (Pass 1) but BEFORE IND NIintegrate (Pass 3). The default
 * per-instance handler iterates all IND and MUT elements in flat array order,
 * which can interleave them arbitrarily -- MUT augmentation might run AFTER
 * an IND has already NIintegrate'd, losing the coupling. This specialist
 * handler enforces the correct ordering by sweeping each type separately.
 *
 * Trouble-node tracking note: this handler is dispatched by runByDeviceFamily
 * as a registered specialist, replacing the makeTroubleTrackingHandler default
 * for IND_FAMILY. The trouble-node reset (ctx.troubleNode = null on noncon > 0)
 * is the responsibility of the default handler passed to runByDeviceFamily for
 * all other families; for IND_FAMILY, any uncaught exception propagates
 * naturally through the runByDeviceFamily call site in ckt-load.ts, which the
 * NR loop catches to assign CKTtroubleNode -- exactly as ngspice does at the
 * DEVload function-pointer level.
 */

import type { FamilyHandler } from "../family-registry.js";
import type { LoadContext } from "../load-context.js";
import type { AnalogElement } from "../element.js";
import { AnalogInductorElement } from "../../../components/passives/inductor.js";
import { MutualInductorElement } from "../../../components/passives/mutual-inductor.js";

/**
 * Shape of MutualInductorElement after task 4.1.2 adds loadCouplingPass().
 * Used for the instanceof-narrowed cast in Pass 2 so this file compiles
 * independently of wave-4.1 task ordering.
 *
 * cite: indload.c:64-76 -- MUT coupling pass called from IndFamilyLoadHandler.
 */
interface MutWithCouplingPass extends MutualInductorElement {
  loadCouplingPass(ctx: LoadContext): void;
}

/**
 * IND_FAMILY specialist load handler implementing the 3-pass indload.c
 * structure. Registered in FAMILY_REGISTRY by task 4.3.1.
 *
 * cite: indload.c:35-127 -- INDload full function body (MUTUAL build).
 */
export const IndFamilyLoadHandler: FamilyHandler = {
  /**
   * Run all three passes for all IND_FAMILY elements in the bucket.
   *
   * @param ctx     LoadContext (typed as unknown at the FamilyHandler
   *                interface boundary; narrowed to LoadContext here).
   * @param elements  All AnalogElement instances in the IND_FAMILY bucket,
   *                  in flat-array order preserved by the compiler (task 1.1.8).
   *                  Contains a mix of AnalogInductorElement (IND) and
   *                  MutualInductorElement (MUT) entries.
   */
  run(ctx: unknown, elements: readonly AnalogElement[]): void {
    const lctx = ctx as LoadContext;

    // ------------------------------------------------------------------
    // Pass 1: IND flux init  indload.c:38-50
    //
    // for each INDmodel, for each INDinstance:
    //   if (!(ckt->CKTmode & (MODEDC|MODEINITPRED))) {
    //     state0[INDflux] = INDinduct/m * rhsOld[INDbrEq]   // or UIC seed
    //   }
    //
    // Only IND elements have loadFluxInit (declared optional on AnalogElement
    // base in element.ts:138). MUT elements are skipped by the instanceof guard.
    // ------------------------------------------------------------------
    for (const el of elements) {
      if (el instanceof AnalogInductorElement) {
        // cite: indload.c:43-50 -- flux-from-current init, gated on
        //   !(MODEDC|MODEINITPRED). Extracted into loadFluxInit() by task 4.1.1.
        el.loadFluxInit?.(lctx);
      }
    }

    // ------------------------------------------------------------------
    // Pass 2: MUT coupling  indload.c:64-76
    //
    // for each MUTmodel, for each MUTinstance:
    //   if (!(ckt->CKTmode & (MODEDC|MODEINITPRED))) {
    //     state0[ind1->INDflux] += MUTfactor * rhsOld[ind2->INDbrEq]  // indload.c:65-67
    //     state0[ind2->INDflux] += MUTfactor * rhsOld[ind1->INDbrEq]  // indload.c:69-71
    //   }
    //   *(MUTbr1br2) -= MUTfactor * CKTag[0]  // indload.c:74 (unconditional)
    //   *(MUTbr2br1) -= MUTfactor * CKTag[0]  // indload.c:75 (unconditional)
    //
    // IND elements are skipped in this pass.
    // The flux augmentation (guarded) and matrix stamps (unconditional) are
    // both encapsulated in MutualInductorElement.loadCouplingPass() added by
    // task 4.1.2. Cast to MutWithCouplingPass for type-safe dispatch.
    // ------------------------------------------------------------------
    for (const el of elements) {
      if (el instanceof MutualInductorElement) {
        // cite: indload.c:64-76 -- MUT coupling pass.
        (el as MutWithCouplingPass).loadCouplingPass(lctx);
      }
    }

    // ------------------------------------------------------------------
    // Pass 3: IND NIintegrate + 5-stamp  indload.c:90-127
    //
    // for each INDmodel, for each INDinstance:
    //   req/veq via NIintegrate(ckt, &req, &veq, INDinduct/m, INDflux)
    //   *(CKTrhs + INDbrEq) += veq
    //   *(INDposIbrptr) += 1
    //   *(INDnegIbrptr) -= 1
    //   *(INDibrPosptr) += 1
    //   *(INDibrNegptr) -= 1
    //   *(INDibrIbrptr) -= req
    //
    // By this point, state0[INDflux] has been augmented by Pass 2 for any
    // IND that has a MUT sibling, so NIintegrate integrates the coupled flux.
    // MUT elements are skipped in this pass.
    // ------------------------------------------------------------------
    for (const el of elements) {
      if (el instanceof AnalogInductorElement) {
        // cite: indload.c:90-127 -- NIintegrate companion model + 5-stamp.
        el.load(lctx);
      }
    }
  },
};
