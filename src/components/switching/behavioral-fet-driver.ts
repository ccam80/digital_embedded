/**
 * BehavioralFETDriver- behavioral driver leaf for the NFET / PFET / TransGate
 * composites. Reads V(G) - V(S), thresholds against Vth, and classifies the gate logic level.
 *
 * Polarity:
 *   "n" (NFET):  on-condition is `vGS > Vth` (gate-source voltage exceeds threshold).
 *   "p" (PFET):  on-condition is `vGS < -Vth` (gate-source voltage falls below -Vth).
 *
 * The polarity is encoded as a number per the SubcircuitElementParam
 * 4-arm union contract (booleans must be 0/1). 1 = N-channel, 0 = P-channel.
 *
 * Pins: G (gate), S (source), ctrl_out (Norton output driving FetSW ctrl input).
 *
 * Norton stamp at ctrl_out:
 *   on  -> vTarget = vOH, G = 1/rOut, I = G * vOH
 *   off -> vTarget = vOL, G = 1/rOut, I = G * vOL
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import { PoolBackedAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";
import { PropertyBag } from "../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { allocNortonStamp, stampNortonValue } from "../../solver/analog/stamp-helpers.js";

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralFETDriver", []);


// ---------------------------------------------------------------------------
// Param defs
// ---------------------------------------------------------------------------

const BEHAVIORAL_FET_DRIVER_PARAM_DEFS: ParamDef[] = [
  { key: "Vth",      default: 2.5 },
  { key: "isNType",  default: 1 }, // 1 = N-channel, 0 = P-channel
  { key: "rOut",     default: 100 },
  { key: "vOH",      default: 5.0 },
  { key: "vOL",      default: 0.0 },
];

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const BEHAVIORAL_FET_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT, label: "G",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
  {
    direction: PinDirection.INPUT, label: "S",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
  {
    direction: PinDirection.OUTPUT, label: "ctrl_out",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// BehavioralFETDriverElement
// ---------------------------------------------------------------------------

export class BehavioralFETDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _gateNode: number;
  private readonly _sourceNode: number;
  private _vth: number;
  private _isNType: boolean;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;

  private _ctrlOutNode = -1;
  private _gndNode = 0;
  private _handles: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._gateNode   = pinNodes.get("G")!;
    this._sourceNode = pinNodes.get("S")!;
    // All keys are declared in BEHAVIORAL_FET_DRIVER_PARAM_DEFS — read directly.
    this._vth = props.getModelParam<number>("Vth");
    this._isNType = props.getModelParam<number>("isNType") !== 0;
    this._rOut = props.getModelParam<number>("rOut");
    this._vOH = props.getModelParam<number>("vOH");
    this._vOL = props.getModelParam<number>("vOL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    this._ctrlOutNode = this.pinNodes.get("ctrl_out")!;
    this._gndNode = 0;
    this._handles = allocNortonStamp(ctx.solver, this._ctrlOutNode, this._gndNode);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;

    const vG = rhsOld[this._gateNode];
    const vS = rhsOld[this._sourceNode];
    const vGS = vG - vS;

    // N-channel: on when vGS > Vth (gate higher than source by threshold).
    // P-channel: on when vGS < -Vth (gate lower than source by threshold).
    const on = this._isNType ? vGS > this._vth : vGS < -this._vth;

    const vTarget = on ? this._vOH : this._vOL;
    stampNortonValue(ctx, this._handles, this._ctrlOutNode, this._gndNode, this._rOut, vTarget);
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "Vth") this._vth = value;
    else if (key === "isNType") this._isNType = value !== 0;
    else if (key === "rOut") this._rOut = value;
    else if (key === "vOH") this._vOH = value;
    else if (key === "vOL") this._vOL = value;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralFETDriverDefinition: ComponentDefinition = {
  name: "BehavioralFETDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: BEHAVIORAL_FET_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: BEHAVIORAL_FET_DRIVER_PARAM_DEFS,
      params: {},
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new BehavioralFETDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
