/**
 * BehavioralDriverDriverElement — pure-truth-function driver leaf for the
 * Driver tri-state buffer. See and-driver.ts for the normalized-bit driver-
 * chain architecture.
 *
 * Reads `in` and `sel` (normalized {0, 1} V), stamps Norton sources at
 * ctrl_out (data level) and ctrl_en (enable level — high when sel is high).
 *
 * DriverInvSel uses a sibling driver (driver-inv-driver.ts) with inverted
 * sel polarity; the rest of the shape is identical.
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../state-schema.js";
import { allocNortonStamp, stampNortonValue } from "../stamp-helpers.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../ngspice-load-order.js";
import { PoolBackedAnalogElement } from "../element.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";

const SCHEMA: StateSchema = defineStateSchema("BehavioralDriverDriver", []);

const DRIVER_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "in",       defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "sel",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_en",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

export class BehavioralDriverDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _ctrlOutNode: number;
  private readonly _ctrlEnNode: number;
  private readonly _gndNode: number;
  private _handlesOut: readonly [number, number, number, number] = [-1, -1, -1, -1];
  private _handlesEn:  readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, _props: PropertyBag) {
    super(pinNodes);
    this._ctrlOutNode = pinNodes.get("ctrl_out")!;
    this._ctrlEnNode  = pinNodes.get("ctrl_en")!;
    this._gndNode     = pinNodes.get("gnd")!;
  }

  setup(ctx: SetupContext): void {
    this._stateBase   = ctx.allocStates(this.stateSize);
    this._handlesOut  = allocNortonStamp(ctx.solver, this._ctrlOutNode, this._gndNode);
    this._handlesEn   = allocNortonStamp(ctx.solver, this._ctrlEnNode,  this._gndNode);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const gnd  = rhsOld[this._gndNode];
    const dataOut    = rhsOld[this.pinNodes.get("in")!]  - gnd >= 0.5 ? 1 : 0;
    const enableHigh = rhsOld[this.pinNodes.get("sel")!] - gnd >= 0.5 ? 1 : 0;

    stampNortonValue(ctx, this._handlesOut, this._ctrlOutNode, this._gndNode, 1, dataOut);
    stampNortonValue(ctx, this._handlesEn,  this._ctrlEnNode,  this._gndNode, 1, enableHigh);
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(_key: string, _value: number): void {
    // No hot-loadable params.
  }
}

export const BehavioralDriverDriverDefinition: ComponentDefinition = {
  name: "BehavioralDriverDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: DRIVER_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [],
      params: {},
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralDriverDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
