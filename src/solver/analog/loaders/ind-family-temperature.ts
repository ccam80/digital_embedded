/**
 * IND_FAMILY temperature handler.
 *
 * Two passes — ORDER MATTERS:
 *
 *   Pass 1 (indtemp.c:69-72):  IND.computeTemperature(ctx)
 *     Sets effective INDinduct = nominalInduct * (1 + tc1*ΔT + tc2*ΔT²) * scale / m
 *     ngspice: factor = 1.0 + tc1*difference + tc2*difference*difference;
 *              INDinduct = INDinduct * factor * INDscale;
 *              INDinduct = INDinduct / INDm;
 *
 *   Pass 2 (muttemp.c:35-41):  MUT.computeTemperature(ctx)
 *     Reads partner inductors' temp-corrected inductances, sets
 *     MUTfactor = MUTcoupling * sqrt(ind1 * ind2)
 *     ngspice: ind1 = here->MUTind1->INDinduct;
 *              ind2 = here->MUTind2->INDinduct;
 *              here->MUTfactor = here->MUTcoupling * sqrt(ind1 * ind2);
 *
 * Pass 1 MUST complete before Pass 2: MUT reads each partner's
 * inductance which Pass 1 has just temperature-corrected.
 *
 * cite: ckttemp.c:28-33 — DEVices[i]->DEVtemperature(ckt) loop structure.
 */

import type { FamilyHandler } from "../family-registry.js";
import type { TempContext } from "../temp-context.js";
import type { AnalogElement } from "../element.js";
import { AnalogInductorElement } from "../../../components/passives/inductor.js";
import { MutualInductorElement } from "../../../components/passives/mutual-inductor.js";

export const IndFamilyTempHandler: FamilyHandler = {
  run(ctx: unknown, instances: readonly AnalogElement[]): void {
    const tempCtx = ctx as TempContext;

    // Pass 1 (indtemp.c:69-72): IND.computeTemperature — updates effective inductance
    // factor = 1.0 + tc1*difference + tc2*difference*difference;
    // INDinduct = INDinduct * factor * INDscale / INDm;
    for (const el of instances) {
      if (el instanceof AnalogInductorElement) {
        el.computeTemperature?.(tempCtx);
      }
    }

    // Pass 2 (muttemp.c:35-41): MUT.computeTemperature — reads partner inductances
    // MUTfactor = MUTcoupling * sqrt(ind1 * ind2)
    // Depends on Pass 1 having updated INDinduct for all partner IND instances.
    for (const el of instances) {
      if (el instanceof MutualInductorElement) {
        el.computeTemperature?.(tempCtx);
      }
    }
  },
};
