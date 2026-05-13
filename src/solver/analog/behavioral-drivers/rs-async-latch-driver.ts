/**
 * BehavioralRSAsyncLatchDriverElement- pure-truth-function driver leaf for the
 * level-sensitive RS latch (no clock).
 *
 * Every load() pass:
 *   S=0, R=0 â†’ hold
 *   S=1, R=0 â†’ q=1, ~q=0
 *   S=0, R=1 â†’ q=0, ~q=1
 *   S=1, R=1 â†’ forbidden state Q=~Q=0 (matches parent's digital `executeRSAsync`
 *              behavior; both outputs forced low when both inputs are high).
 *
 * Per Composite M17 (phase-composite-architecture.md), J-155
 * (contracts_group_10.md).
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../state-schema.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../ngspice-load-order.js";
import { PoolBackedAnalogElement } from "../element.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";
import { allocNortonStamp, stampNortonValue } from "../stamp-helpers.js";

const SCHEMA: StateSchema = defineStateSchema("BehavioralRSAsyncLatchDriver", [
  { name: "Q", doc: "Latched output bit." },
]);

const SLOT_Q = SCHEMA.indexOf.get("Q")!;

const RS_AS_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "S",       defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "R",       defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_q",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_nq", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd",     defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

export class BehavioralRSAsyncLatchDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _vIH: number;
  private _vIL: number;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;

  private _firstSample: boolean = true;

  private _ctrlQNode: number = 0;
  private _ctrlNqNode: number = 0;
  private _gndNode: number = 0;
  private _handlesQ: readonly [number, number, number, number] = [-1, -1, -1, -1];
  private _handlesNq: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._vIH = props.hasModelParam("vIH") ? props.getModelParam<number>("vIH") : 2.0;
    this._vIL = props.hasModelParam("vIL") ? props.getModelParam<number>("vIL") : 0.8;
    this._rOut = props.getModelParam<number>("rOut");
    this._vOH = props.getModelParam<number>("vOH");
    this._vOL = props.getModelParam<number>("vOL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    this._ctrlQNode  = this.pinNodes.get("ctrl_q")!;
    this._ctrlNqNode = this.pinNodes.get("ctrl_nq")!;
    this._gndNode    = this.pinNodes.get("gnd")!;
    this._handlesQ  = allocNortonStamp(ctx.solver, this._ctrlQNode,  this._gndNode);
    this._handlesNq = allocNortonStamp(ctx.solver, this._ctrlNqNode, this._gndNode);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const gnd = rhsOld[this._gndNode];
    const vS  = rhsOld[this.pinNodes.get("S")!] - gnd;
    const vR  = rhsOld[this.pinNodes.get("R")!] - gnd;

    let q: number;
    if (this._firstSample) {
      q = 0;
      this._firstSample = false;
    } else {
      q = s1[base + SLOT_Q] >= 0.5 ? 1 : 0;
    }

    const sHigh = vS >= this._vIH;
    const sLow  = vS <  this._vIL;
    const rHigh = vR >= this._vIH;
    const rLow  = vR <  this._vIL;

    if ((sHigh || sLow) && (rHigh || rLow)) {
      if (sHigh && rHigh) {
        // Forbidden state: both outputs forced LOW (matches parent executeRSAsync).
        q = 0;
      } else if (sHigh) {
        q = 1;
      } else if (rHigh) {
        q = 0;
      }
      // both low → hold
    }

    stampNortonValue(ctx, this._handlesQ,  this._ctrlQNode,  this._gndNode, this._rOut, q ? this._vOH : this._vOL);
    stampNortonValue(ctx, this._handlesNq, this._ctrlNqNode, this._gndNode, this._rOut, q ? this._vOL : this._vOH);

    s0[base + SLOT_Q] = q;
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

export const BehavioralRSAsyncLatchDriverDefinition: ComponentDefinition = {
  name: "BehavioralRSAsyncLatchDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: RS_AS_DRIVER_PIN_LAYOUT,
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
        new BehavioralRSAsyncLatchDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
