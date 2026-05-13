/**
 * BehavioralDriverDriverElement- pure-truth-function driver leaf for the
 * Driver tri-state buffer.
 *
 * Reads `in` and `sel` voltages from rhsOld (relative to gnd), threshold-
 * classifies each against per-instance vIH / vIL with hold-on-indeterminate,
 * and stamps Norton sources at ctrl_out (data level) and ctrl_en (enable level).
 *
 * DriverInvSel uses a sibling driver (driver-inv-driver.ts) with inverted
 * sel polarity; the rest of the shape is identical.
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

const SCHEMA: StateSchema = defineStateSchema("BehavioralDriverDriver", [
  {
    name: "LAST_OUT",
    doc: "Held output data bit (0 or 1) for hysteresis-on-indeterminate. Bottom-of-load write.",
  },
  {
    name: "LAST_EN",
    doc: "Held enable bit (0 or 1) for hysteresis-on-indeterminate. Bottom-of-load write.",
  },
]);

const SLOT_LAST_OUT = SCHEMA.indexOf.get("LAST_OUT")!;
const SLOT_LAST_EN  = SCHEMA.indexOf.get("LAST_EN")!;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------
//
// Order MUST match the buildDriverNetlist drv connectivity row `[0, 1, 4, 5, 3]`
// mapping to ports `[in, sel, ctrl_out, ctrl_en, gnd]`. The compiler stores
// each pin label against the resolved node from connectivity[i] (compiler.ts:447-462).

const DRIVER_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "in",       defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "sel",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_en",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// BehavioralDriverDriverElement
// ---------------------------------------------------------------------------

export class BehavioralDriverDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _ctrlOutNode: number;
  private readonly _ctrlEnNode: number;
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;
  private _handlesOut: readonly [number, number, number, number] = [-1, -1, -1, -1];
  private _handlesEn:  readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._ctrlOutNode = pinNodes.get("ctrl_out")!;
    this._ctrlEnNode  = pinNodes.get("ctrl_en")!;
    this._gndNode     = pinNodes.get("gnd")!;
    this._vIH  = props.hasModelParam("vIH")  ? props.getModelParam<number>("vIH")  : 2.0;
    this._vIL  = props.hasModelParam("vIL")  ? props.getModelParam<number>("vIL")  : 0.8;
    this._rOut = props.hasModelParam("rOut") ? props.getModelParam<number>("rOut") : 100;
    this._vOH  = props.hasModelParam("vOH")  ? props.getModelParam<number>("vOH")  : 5;
    this._vOL  = props.hasModelParam("vOL")  ? props.getModelParam<number>("vOL")  : 0;
  }

  setup(ctx: SetupContext): void {
    this._stateBase   = ctx.allocStates(this.stateSize);
    this._handlesOut  = allocNortonStamp(ctx.solver, this._ctrlOutNode, this._gndNode);
    this._handlesEn   = allocNortonStamp(ctx.solver, this._ctrlEnNode,  this._gndNode);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const gnd  = rhsOld[this._gndNode];
    const vIn  = rhsOld[this.pinNodes.get("in")!]  - gnd;
    const vSel = rhsOld[this.pinNodes.get("sel")!] - gnd;

    const prevOut = s1[base + SLOT_LAST_OUT] as 0 | 1;
    const prevEn  = s1[base + SLOT_LAST_EN]  as 0 | 1;

    const dataOut   = logicLevel(vIn,  this._vIH, this._vIL, prevOut);
    const enableHigh = logicLevel(vSel, this._vIH, this._vIL, prevEn);

    stampNortonValue(ctx, this._handlesOut, this._ctrlOutNode, this._gndNode, this._rOut, dataOut   ? this._vOH : this._vOL);
    stampNortonValue(ctx, this._handlesEn,  this._ctrlEnNode,  this._gndNode, this._rOut, enableHigh ? this._vOH : this._vOL);

    s0[base + SLOT_LAST_OUT] = dataOut;
    s0[base + SLOT_LAST_EN]  = enableHigh;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if      (key === "vIH")  this._vIH  = value;
    else if (key === "vIL")  this._vIL  = value;
    else if (key === "rOut") this._rOut = value;
    else if (key === "vOH")  this._vOH  = value;
    else if (key === "vOL")  this._vOL  = value;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralDriverDriverDefinition: ComponentDefinition = {
  name: "BehavioralDriverDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: DRIVER_DRIVER_PIN_LAYOUT,
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
        new BehavioralDriverDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
