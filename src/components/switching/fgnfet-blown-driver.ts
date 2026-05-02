/**
 * FGNFETBlownDriver- OTP fuse clamp. When params.blown===true, stamps
 * a strong conductance G_blown=1 between FG and S, forcing V_GS_eff~=0
 * regardless of CG; when false, no-op.
 */

import type { AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

const FGNFET_BLOWN_DRIVER_PARAM_DEFS: ParamDef[] = [
  { key: "blown", default: 0 },
];

const FGNFET_BLOWN_DRIVER_DEFAULTS: Record<string, number> = { blown: 0 };

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const FGNFET_BLOWN_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "pos", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "neg", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// FGNFETBlownDriverElement
// ---------------------------------------------------------------------------

export class FGNFETBlownDriverElement implements AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private _blown: boolean;

  private _hPP = -1;
  private _hNN = -1;
  private _hPN = -1;
  private _hNP = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._blown = props.hasModelParam("blown")
      ? props.getModelParam<number>("blown") !== 0
      : false;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const pos = this._pinNodes.get("pos")!;
    const neg = this._pinNodes.get("neg")!;

    this._hPP = solver.allocElement(pos, pos);
    this._hNN = solver.allocElement(neg, neg);
    this._hPN = solver.allocElement(pos, neg);
    this._hNP = solver.allocElement(neg, pos);
  }

  setParam(key: string, value: number): void {
    if (key === "blown") this._blown = value !== 0;
  }

  load(ctx: LoadContext): void {
    stampBlownClamp(ctx, this._hPP, this._hNN, this._hPN, this._hNP, this._blown);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    if (!this._blown) return [0, 0];
    const v = rhs[this._pinNodes.get("pos")!] - rhs[this._pinNodes.get("neg")!];
    return [+v, -v];
  }
}

// ---------------------------------------------------------------------------
// stampBlownClamp- shared helper used by both FGNFET and FGPFET blown drivers
// ---------------------------------------------------------------------------

export function stampBlownClamp(
  ctx: LoadContext,
  hPP: number, hNN: number, hPN: number, hNP: number,
  blown: boolean,
): void {
  if (!blown) return;
  const G = 1;
  ctx.solver.stampElement(hPP, +G);
  ctx.solver.stampElement(hNN, +G);
  ctx.solver.stampElement(hPN, -G);
  ctx.solver.stampElement(hNP, -G);
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const FGNFETBlownDriverDefinition: ComponentDefinition = {
  name: "FGNFETBlownDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: FGNFET_BLOWN_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: FGNFET_BLOWN_DRIVER_PARAM_DEFS,
      params: FGNFET_BLOWN_DRIVER_DEFAULTS,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new FGNFETBlownDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
