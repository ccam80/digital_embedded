/**
 * `CompositeElement` — abstract base class for analog elements composed of
 * sub-elements: behavioral gates, flip-flops, multi-element composites, and
 * bridge adapters.
 *
 * Concrete composites previously hand-rolled the same per-lifecycle forwarding
 * pattern (`for (const c of children) c.setup(ctx)`) ~6 times each and the
 * duplication had rotted unevenly across the ~16 composite classes. This base
 * collapses that duplication. Subclasses declare `ngspiceLoadOrder` and
 * `stateSchema`, build their child array, implement `getSubElements()`, and
 * implement `getPinCurrents` / `setParam`. All other lifecycle methods forward
 * to children via method-presence guards.
 *
 * Spec reference: setup-load-cleanup.md §A.15.
 */

import type { AnalogElement, PoolBackedAnalogElement, IntegrationMethod, StatePoolRef } from "../../core/analog-types.js";
import type { SetupContext } from "./setup-context.js";
import type { LoadContext } from "./load-context.js";
import type { LteParams } from "./ckt-terr.js";
import type { StateSchema } from "./state-schema.js";

/**
 * Abstract base for any analog element that owns sub-elements. The base-class
 * lifecycle forwarders use `typeof child.method === "function"` guards so that
 * child arrays may include elements satisfying only a subset of `AnalogElement`
 * (e.g. `DigitalInputPinModel` which has only `setup` and `load`).
 */
export abstract class CompositeElement implements PoolBackedAnalogElement {
  // --- contract fields each subclass must initialize -----------------------

  abstract readonly ngspiceLoadOrder: number;
  abstract readonly stateSchema: StateSchema;

  label: string = "";
  _pinNodes: Map<string, number> = new Map();
  _stateBase: number = -1;
  branchIndex: number = -1;
  readonly poolBacked = true as const;

  // --- the only abstract behavioural method --------------------------------

  /** Returns every child element this composite owns: pin-model children,
   *  internal sub-elements, etc. The returned array may include children that
   *  satisfy only a subset of `AnalogElement` (e.g. `DigitalInputPinModel`
   *  which has only `setup` and `load`). The base-class forwarders use
   *  `typeof child.method === "function"` guards before calling each
   *  lifecycle method. */
  protected abstract getSubElements(): readonly AnalogElement[];

  // --- subclass-supplied per-element behaviour -----------------------------

  abstract getPinCurrents(rhs: Float64Array): number[];
  abstract setParam(key: string, value: number): void;

  // --- forwarded lifecycle (concrete, base-class implementations) ----------

  /** Sum of pool-backed children's `stateSize`. Returns 0 when no children
   *  carry state — the empty-children case is handled correctly by this
   *  default and subclasses do not need to override it. */
  get stateSize(): number {
    let total = 0;
    for (const c of this.getSubElements()) {
      const pb = c as Partial<PoolBackedAnalogElement>;
      if (pb.poolBacked) total += pb.stateSize ?? 0;
    }
    return total;
  }

  setup(ctx: SetupContext): void {
    for (const c of this.getSubElements()) {
      if (typeof c.setup === "function") c.setup(ctx);
    }
  }

  load(ctx: LoadContext): void {
    for (const c of this.getSubElements()) {
      if (typeof c.load === "function") c.load(ctx);
    }
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: LteParams,
  ): number {
    let min = Infinity;
    for (const c of this.getSubElements()) {
      if (typeof c.getLteTimestep === "function") {
        const proposed = c.getLteTimestep(dt, deltaOld, order, method, lteParams);
        if (proposed < min) min = proposed;
      }
    }
    return min;
  }

  checkConvergence(ctx: LoadContext): boolean {
    for (const c of this.getSubElements()) {
      if (typeof c.checkConvergence === "function") {
        if (!c.checkConvergence(ctx)) return false;
      }
    }
    return true;
  }

  acceptStep(simTime: number, addBp: (t: number) => void, atBp: boolean): void {
    for (const c of this.getSubElements()) {
      if (typeof c.acceptStep === "function") c.acceptStep(simTime, addBp, atBp);
    }
  }

  nextBreakpoint(after: number): number | null {
    let earliest: number | null = null;
    for (const c of this.getSubElements()) {
      if (typeof c.nextBreakpoint === "function") {
        const t = c.nextBreakpoint(after);
        if (t !== null && (earliest === null || t < earliest)) earliest = t;
      }
    }
    return earliest;
  }

  initState(pool: StatePoolRef): void {
    let cumulative = this._stateBase;
    for (const c of this.getSubElements()) {
      const pb = c as Partial<PoolBackedAnalogElement> & { _stateBase?: number };
      if (pb.poolBacked && typeof pb.initState === "function") {
        pb._stateBase = cumulative;
        pb.initState(pool);
        cumulative += pb.stateSize ?? 0;
      }
    }
  }
}
