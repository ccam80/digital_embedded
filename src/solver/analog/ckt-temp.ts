/**
 * cktTemp — per-type temperature pass orchestrator.
 *
 * Mirrors ngspice ckttemp.c:28-33:
 *   for (i = 0; i < DEVmaxnum; i++) {
 *     if (DEVices[i] && DEVices[i]->DEVtemperature && ckt->CKThead[i])
 *       DEVices[i]->DEVtemperature(ckt->CKThead[i], ckt);
 *   }
 *
 * Instead of a flat device walk, the dispatcher iterates family buckets in
 * ascending min(ngspiceLoadOrder) order and dispatches each bucket to its
 * registered handler or the defaultTemperatureHandler (which performs the
 * per-instance optional-call walk matching ngspice's NULL function-pointer
 * guard at ckttemp.c:29). Elements without `computeTemperature?` are silently
 * skipped, so the pass costs only the dispatcher iteration when no elements
 * opt in.
 */

import type { CKTCircuitContext } from "./ckt-context.js";
import type { DeviceFamily } from "./ngspice-load-order.js";
import type { AnalogElement } from "./element.js";
import { runByDeviceFamily } from "./family-dispatch.js";
import { defaultTemperatureHandler } from "./loaders/default-loaders.js";

/**
 * Run the per-type DEVtemperature pass for a compiled circuit.
 *
 * cite: ckttemp.c:28-33 — `for (i=0; i<DEVmaxnum; i++) DEVices[i]->DEVtemperature(ckt)`
 *
 * @param ctx            - CKTCircuitContext supplying the lazy `tempCtx` accessor
 *                         (cktTemp / cktNomTemp in Kelvin).
 * @param elementsByFamily - Compile-time family→instances map from the compiled
 *                         analog circuit. Stable reference per compilation; the
 *                         WeakMap sort-cache in family-dispatch.ts ensures the
 *                         bucket sort runs exactly once per circuit, not on every
 *                         temperature pass invocation.
 */
export function cktTemp(
  ctx: CKTCircuitContext,
  elementsByFamily: ReadonlyMap<DeviceFamily, readonly AnalogElement[]>,
): void {
  runByDeviceFamily(
    elementsByFamily,
    "computeTemperature",
    ctx.tempCtx,
    defaultTemperatureHandler,
  );
}
