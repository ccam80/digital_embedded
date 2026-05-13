/**
 * BehavioralButtonLEDDriverElement- pure threshold-classification driver leaf
 * for the ButtonLED component.
 *
 * Reads the LED input voltage (relative to gnd) from rhsOld and threshold-
 * classifies it against per-instance vIH / vIL with hysteresis (hold-on-
 * indeterminate). Stamps a Norton source at ctrl_out encoding the button state.
 *
 * Pin layout (MUST match the drv connectivity row in buildButtonLEDNetlist):
 *   ctrl_out(0) - button output control net (Norton stamp target)
 *   in(1)       - LED input net (voltage observed for threshold classification)
 *   gnd(2)      - ground reference
 *
 * Per Composite M10 (phase-composite-architecture.md).
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../state-schema.js";
import { logicLevel } from "./edge-detect.js";
import { allocNortonStamp, stampNortonValue } from "../stamp-helpers.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../ngspice-load-order.js";
import { PoolBackedAnalogElement } from "../element.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralButtonLEDDriver", [
  {
    name: "LAST_OUT",
    doc: "Held output bit (0 or 1) for hysteresis-on-indeterminate. Bottom-of-load write.",
  },
]);

const SLOT_LAST_OUT = SCHEMA.indexOf.get("LAST_OUT")!;

// ---------------------------------------------------------------------------
// Pin layout- fixed 3-pin (Template A), module-level const
// ---------------------------------------------------------------------------
//
// Order MUST match the drv connectivity row in buildButtonLEDNetlist:
//   [ctrl_out_net, in_net, gnd_net] => indices [0, 1, 2].

const BUTTON_LED_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  {
    direction: PinDirection.OUTPUT, label: "ctrl_out",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
  {
    direction: PinDirection.INPUT, label: "in",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
  {
    direction: PinDirection.INPUT, label: "gnd",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// BehavioralButtonLEDDriverElement
// ---------------------------------------------------------------------------

export class BehavioralButtonLEDDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _inNode: number;
  private readonly _gndNode: number;
  private readonly _ctrlOutNode: number;
  private _vIH: number;
  private _vIL: number;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;
  private _handles: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._ctrlOutNode = pinNodes.get("ctrl_out")!;
    this._inNode      = pinNodes.get("in")!;
    this._gndNode     = pinNodes.get("gnd")!;
    this._vIH  = props.getModelParam<number>("vIH");
    this._vIL  = props.getModelParam<number>("vIL");
    this._rOut = props.getModelParam<number>("rOut");
    this._vOH  = props.getModelParam<number>("vOH");
    this._vOL  = props.getModelParam<number>("vOL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    this._handles = allocNortonStamp(ctx.solver, this._ctrlOutNode, this._gndNode);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const vIn = rhsOld[this._inNode] - rhsOld[this._gndNode];
    const prevOut = s1[base + SLOT_LAST_OUT] as 0 | 1;
    const bit = logicLevel(vIn, this._vIH, this._vIL, prevOut);

    stampNortonValue(ctx, this._handles, this._ctrlOutNode, this._gndNode, this._rOut, bit ? this._vOH : this._vOL);
    s0[base + SLOT_LAST_OUT] = bit;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
    else if (key === "rOut") this._rOut = value;
    else if (key === "vOH") this._vOH = value;
    else if (key === "vOL") this._vOL = value;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralButtonLEDDriverDefinition: ComponentDefinition = {
  name: "BehavioralButtonLEDDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: BUTTON_LED_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
        { key: "rOut", default: 100 },
        { key: "vOH", default: 5 },
        { key: "vOL", default: 0 },
      ],
      params: { vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralButtonLEDDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
