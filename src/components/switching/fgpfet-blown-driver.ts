/**
 * FGPFETBlownDriver- OTP fuse clamp for P-channel floating-gate MOSFET.
 * When params.blown===true, stamps a strong conductance G_blown=1 between
 * FG and S, forcing V_GS_eff~=0 regardless of CG; when false, no-op.
 */

import { AbstractAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";
import { stampBlownClamp } from "./fgnfet-blown-driver.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

const FGPFET_BLOWN_DRIVER_PARAM_DEFS: ParamDef[] = [
  { key: "blown", default: 0 },
];

const FGPFET_BLOWN_DRIVER_DEFAULTS: Record<string, number> = { blown: 0 };

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const FGPFET_BLOWN_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "pos", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "neg", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// FGPFETBlownDriverElement
// ---------------------------------------------------------------------------

export class FGPFETBlownDriverElement extends AbstractAnalogElement implements AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;

  private _blown: boolean;

  private _hPP = -1;
  private _hNN = -1;
  private _hPN = -1;
  private _hNP = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
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
// ComponentDefinition
// ---------------------------------------------------------------------------

export const FGPFETBlownDriverDefinition: ComponentDefinition = {
  name: "FGPFETBlownDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: FGPFET_BLOWN_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: FGPFET_BLOWN_DRIVER_PARAM_DEFS,
      params: FGPFET_BLOWN_DRIVER_DEFAULTS,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new FGPFETBlownDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
