/**
 * BehavioralFETDriver- behavioral driver leaf for the NFET / PFET / TransGate
 * composites. Reads V(G) - V(S), thresholds against Vth, and writes the
 * classified logic level (0 or 1) into its own OUTPUT_LOGIC_LEVEL pool slot.
 *
 * The slot is consumed via siblingState by the parent composite's FetSW
 * sub-element; FetSW translates the slot value to gOn / gOff conductance
 * and stamps the 2x2 admittance at (D, S).
 *
 * Polarity:
 *   "n" (NFET):  on-condition is `vGS > Vth` (gate-source voltage exceeds threshold).
 *   "p" (PFET):  on-condition is `vGS < -Vth` (gate-source voltage falls below -Vth).
 *
 * The polarity is encoded as a number per the SubcircuitElementParam
 * 4-arm union contract (booleans must be 0/1). 1 = N-channel, 0 = P-channel.
 *
 * Pins: G (gate), D (drain, unused for control), S (source).
 *
 * Per Composite recipe: pure behavioural classifier writing
 * OUTPUT_LOGIC_LEVEL at bottom of load(), no MNA stamps.
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

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralFETDriver", [
  {
    name: "OUTPUT_LOGIC_LEVEL",
    doc: "Classified gate logic level (0 or 1) consumed via siblingState by the parent composite's FetSW sub-element.",
  },
]);

const SLOT_OUT = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL")!;

// ---------------------------------------------------------------------------
// Param defs
// ---------------------------------------------------------------------------

const BEHAVIORAL_FET_DRIVER_PARAM_DEFS: ParamDef[] = [
  { key: "Vth",      default: 2.5 },
  { key: "isNType",  default: 1 }, // 1 = N-channel, 0 = P-channel
];

const BEHAVIORAL_FET_DRIVER_DEFAULTS: Record<string, number> = {
  Vth: 2.5,
  isNType: 1,
};

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
    direction: PinDirection.INPUT, label: "D",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
  {
    direction: PinDirection.INPUT, label: "S",
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

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._gateNode   = pinNodes.get("G")!;
    this._sourceNode = pinNodes.get("S")!;
    this._vth =
      props.hasModelParam("Vth") ? props.getModelParam<number>("Vth") : BEHAVIORAL_FET_DRIVER_DEFAULTS["Vth"]!;
    this._isNType =
      (props.hasModelParam("isNType") ? props.getModelParam<number>("isNType") : BEHAVIORAL_FET_DRIVER_DEFAULTS["isNType"]!) !== 0;
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];

    const vG = rhsOld[this._gateNode];
    const vS = rhsOld[this._sourceNode];
    const vGS = vG - vS;

    // N-channel: on when vGS > Vth (gate higher than source by threshold).
    // P-channel: on when vGS < -Vth (gate lower than source by threshold).
    const on = this._isNType ? vGS > this._vth : vGS < -this._vth;

    s0[this._stateBase + SLOT_OUT] = on ? 1 : 0;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "Vth") this._vth = value;
    else if (key === "isNType") this._isNType = value !== 0;
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
      params: BEHAVIORAL_FET_DRIVER_DEFAULTS,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new BehavioralFETDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
