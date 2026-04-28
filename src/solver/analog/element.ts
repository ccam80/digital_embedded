/**
 * Re-exports of the canonical analog element types defined in
 * `src/core/analog-types.ts`. Solver-side code may import either path.
 *
 * Reactivity is method-presence: an element is "reactive" iff
 *   typeof el.getLteTimestep === "function"
 * There is no Core / non-Core split, no boolean device-class flags, and
 * no post-compile type promotion. See `core/analog-types.ts` for the full
 * `AnalogElement` and `PoolBackedAnalogElement` contracts.
 */

export type {
  AnalogElement,
  PoolBackedAnalogElement,
  ComplexSparseSolver,
  IntegrationMethod,
  SparseSolverStamp,
  StatePoolRef,
} from "../../core/analog-types.js";
export { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";

import type { AnalogElement, PoolBackedAnalogElement } from "../../core/analog-types.js";

export type { LoadContext } from "./load-context.js";

/** Runtime type-guard discriminating pool-backed elements from leaf
 *  AnalogElements. The single `poolBacked: true` literal is the only flag
 *  that survives the cleanup. */
export function isPoolBacked(el: AnalogElement): el is PoolBackedAnalogElement {
  return (el as Partial<PoolBackedAnalogElement>).poolBacked === true;
}
