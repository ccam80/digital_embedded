/**
 * InternalZeroVoltSense — internal-only 0V voltage-source sense element.
 *
 * Per Composite M4 (phase-composite-architecture.md), J-025
 * (contracts_group_02.md). Promoted from VsenseSubElement in optocoupler.ts.
 *
 * Used as the current-sense branch in the Optocoupler netlist. Stamps a 0V
 * VSRC to inject a branch row whose current equals the LED current, readable
 * by the sibling InternalCccs via siblingBranch resolution.
 *
 * Template C variant: branch-bearing, stateless, 2 pins. Subset of the
 * canonical Template C exemplar (transmission-segment-l.ts) — delete state
 * schema, delete pool plumbing, keep branch alloc and 4-handle VSRC stamp.
 *
 * Stamp math: 0V VSRC (vsrcload.c). Four matrix entries + zero RHS:
 *   +1 at (pos, b), -1 at (neg, b)   — KCL rows
 *   +1 at (b, pos), -1 at (b, neg)   — KVL row (V_pos - V_neg = 0)
 */

import { AbstractAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const INTERNAL_ZERO_VOLT_SENSE_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "pos", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "neg", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// InternalZeroVoltSenseElement
// ---------------------------------------------------------------------------

export class InternalZeroVoltSenseElement extends AbstractAnalogElement implements AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VSRC;

  // Cached matrix-entry handles — mirror vsrcsetup.c TSTALLOC sequence for
  // a standard two-node voltage source with one branch row.
  private _hPB = -1;
  private _hNB = -1;
  private _hBP = -1;
  private _hBN = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, _props: PropertyBag) {
    super(pinNodes);
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;

    // vsrcsetup.c — CKTmkCur (idempotent guard).
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "branch");
    }
    const b = this.branchIndex;

    // vsrcsetup.c — TSTALLOC sequence for 0V VSRC.
    this._hPB = solver.allocElement(posNode, b);
    this._hNB = solver.allocElement(negNode, b);
    this._hBP = solver.allocElement(b, posNode);
    this._hBN = solver.allocElement(b, negNode);
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    // vsrcload.c — stamp +1/-1 entries; RHS is zero (enforced voltage = 0).
    solver.stampElement(this._hPB, +1);
    solver.stampElement(this._hNB, -1);
    solver.stampElement(this._hBP, +1);
    solver.stampElement(this._hBN, -1);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const I = rhs[this.branchIndex];
    return [I, -I];
  }

  setParam(_key: string, _value: number): void {
    // No hot-loadable params.
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const InternalZeroVoltSenseDefinition: ComponentDefinition = {
  name: "InternalZeroVoltSense",
  typeId: -1,
  internalOnly: true,
  pinLayout: INTERNAL_ZERO_VOLT_SENSE_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [],
      params: {},
      branchCount: 1,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new InternalZeroVoltSenseElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
