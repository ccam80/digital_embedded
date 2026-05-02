/**
 * RelayCoupling - coil-current -> switch-state behavioural leaf.
 *
 * No MNA pins. Reads the coil's branch current (resolved siblingBranch),
 * compares against pull-in / drop-out thresholds, writes the switch's
 * CLOSED pool slot (resolved siblingState).
 *
 * ngspice peer: behavioural - no direct ngspice analogue (digiTS-specific
 * coupling).
 *
 * Per Composite M7 (phase-composite-architecture.md), J-095
 * (contracts_group_07.md).
 */

import { defineStateSchema } from "../../solver/analog/state-schema.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { StatePoolRef } from "../../solver/analog/state-pool.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { PropertyBag, type PoolSlotRef } from "../../core/properties.js";

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA = defineStateSchema("RelayCoupling", []); // no internal state

// ---------------------------------------------------------------------------
// RelayCouplingElement
// ---------------------------------------------------------------------------

export class RelayCouplingElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHEMA;
  readonly poolBacked = true as const;
  readonly stateSize = 0;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private readonly _coilBranchLabel: string;
  private readonly _switchClosedRef: PoolSlotRef;
  private _pullInI: number;
  private _dropOutI: number;
  private _coilBranchIndex = -1;
  private _pool!: StatePoolRef;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);

    // siblingBranch resolution: compiler stamps "${parentLabel}:${subName}"
    // into the regular prop partition (compiler.ts:391-394).
    this._coilBranchLabel = props.getOrDefault<string>("coilBranch", "");
    if (!this._coilBranchLabel) {
      throw new Error(
        "RelayCoupling: requires coilBranch siblingBranch param.",
      );
    }

    // siblingState resolution: compiler writes a PoolSlotRef struct via
    // PropertyBag.set (compiler.ts siblingState resolver).
    this._switchClosedRef = props.get<PoolSlotRef>("switchClosed");

    this._pullInI = props.hasModelParam("pullInI") ? props.getModelParam<number>("pullInI") : 0.05;
    this._dropOutI = props.hasModelParam("dropOutI") ? props.getModelParam<number>("dropOutI") : 0.02;
  }

  setup(ctx: SetupContext): void {
    this._coilBranchIndex = ctx.findBranch(this._coilBranchLabel);
    if (this._coilBranchIndex === 0) {
      throw new Error(
        `RelayCoupling: ctx.findBranch("${this._coilBranchLabel}") returned 0; ` +
          `the coil inductor sub-element must declare branchCount: 1.`,
      );
    }
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    // stateSize is 0 - no own slots to initialise.
  }

  load(ctx: LoadContext): void {
    const i = ctx.rhsOld[this._coilBranchIndex];
    const s1 = this._pool.states[1]; // accepted history
    const s0 = this._pool.states[0]; // current step's writes

    const slot = this._switchClosedRef.element._stateBase + this._switchClosedRef.slotIdx;

    const wasClosed = s1[slot] >= 0.5;
    let nowClosed = wasClosed;
    if (wasClosed && Math.abs(i) < this._dropOutI) nowClosed = false;
    if (!wasClosed && Math.abs(i) >= this._pullInI) nowClosed = true;

    s0[slot] = nowClosed ? 1 : 0; // bottom-of-load history write
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return [];
  }

  setParam(key: string, value: number): void {
    if (key === "pullInI") this._pullInI = value;
    else if (key === "dropOutI") this._dropOutI = value;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const RelayCouplingDefinition: ComponentDefinition = {
  name: "RelayCoupling",
  typeId: -1,
  internalOnly: true,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "pullInI", default: 0.05 },
        { key: "dropOutI", default: 0.02 },
      ],
      params: { pullInI: 0.05, dropOutI: 0.02 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new RelayCouplingElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
