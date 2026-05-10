/**
 * IND_FAMILY AC stamp handler.
 *
 * Two-pass AC load matching ngspice INDacLoad (indacld.c) and MUTacLoad
 * (mutacld.c), both invoked via the per-type DEVacLoad slot
 * (acan.c:409-414).
 *
 * Pass 1 (indacld.c:29-35):
 *   For each IND instance:
 *     val = ω · (INDinduct / m)
 *     *(INDposIbrptr)   += 1          — real, B sub-matrix
 *     *(INDnegIbrptr)   -= 1          — real, B sub-matrix
 *     *(INDibrPosptr)   += 1          — real, C sub-matrix (KVL incidence)
 *     *(INDibrNegptr)   -= 1          — real, C sub-matrix (KVL incidence)
 *     *(INDibrIbrptr+1) -= val        — imaginary, branch diagonal (reactance)
 *   The +1 suffix addresses the imaginary part of the complex matrix element.
 *
 * Pass 2 (mutacld.c:27-30):
 *   For each MUT instance:
 *     val = ω · MUTfactor
 *     *(MUTbr1br2+1) -= val          — imaginary off-diagonal coupling
 *     *(MUTbr2br1+1) -= val          — imaginary off-diagonal coupling
 *
 * AC analysis is fully linearised — there is no NR iteration coupling between
 * passes, and no flux-history state is read or written. Pass order is therefore
 * immaterial: both passes stamp independent entries into the complex matrix and
 * both must complete before the AC solve.
 *
 * cite: indacld.c:29-35  — INDacLoad per-instance stamp
 * cite: mutacld.c:27-30  — MUTacLoad per-instance stamp
 * cite: acan.c:409-414   — per-type DEVacLoad dispatch loop
 */

import type { FamilyHandler } from "../family-registry.js";
import type { AcHandlerCtx } from "./default-loaders.js";
import { AnalogInductorElement } from "../../../components/passives/inductor.js";
import { MutualInductorElement } from "../../../components/passives/mutual-inductor.js";

/**
 * IND_FAMILY AC stamp handler.
 *
 * Registered against the `"IND"` family and the `"stampAc"` callback in
 * `family-registry.ts` by task 4.3.1. Never reads FAMILY_REGISTRY — it is
 * one of the registered values.
 */
export const IndFamilyStampAcHandler: FamilyHandler = {
  run(ctx: unknown, elements): void {
    const acCtx = ctx as AcHandlerCtx;

    // Pass 1: IND AC stamp — indacld.c:29-35
    // Each IND contributes 4 real connectivity stamps (±1 at B/C sub-matrix
    // positions) and 1 imaginary branch-diagonal stamp (−ω·L/m).
    for (const el of elements) {
      if (el instanceof AnalogInductorElement) {
        el.stampAc(acCtx.solver, acCtx.omega, acCtx.loadCtx);
      }
    }

    // Pass 2: MUT AC coupling — mutacld.c:27-30
    // Each MUT contributes 2 imaginary off-diagonal stamps:
    //   *(MUTbr1br2+1) -= ω·MUTfactor
    //   *(MUTbr2br1+1) -= ω·MUTfactor
    for (const el of elements) {
      if (el instanceof MutualInductorElement) {
        el.stampAcCoupling(acCtx.solver, acCtx.omega, acCtx.loadCtx);
      }
    }
  },
};
