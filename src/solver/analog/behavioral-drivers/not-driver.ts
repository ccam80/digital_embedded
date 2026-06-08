/**
 * BehavioralNotDriverElement — pure-truth-function driver leaf for the 1-input
 * NOT gate. See and-driver.ts for the normalized-bit driver-chain architecture.
 *
 * N=1 fixed; truth function: 1 - input.
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

const SCHEMA: StateSchema = defineStateSchema("BehavioralNotDriver", []);

const NOT_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT, label: "in_1",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
  {
    direction: PinDirection.OUTPUT, label: "ctrl_out",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
  {
    direction: PinDirection.INPUT, label: "gnd",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
];

export class BehavioralNotDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _inputNode: number;
  private readonly _gndNode: number;
  private readonly _ctrlOutNode: number;
  private _handles: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, _props: PropertyBag) {
    super(pinNodes);
    this._inputNode = pinNodes.get("in_1")!;
    this._gndNode = pinNodes.get("gnd")!;
    this._ctrlOutNode = pinNodes.get("ctrl_out")!;
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    this._handles = allocNortonStamp(ctx.solver, this._ctrlOutNode, this._gndNode);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const gndV = rhsOld[this._gndNode];
    const v = rhsOld[this._inputNode] - gndV;
    const result = 1 - v;
    stampNortonValue(ctx, this._handles, this._ctrlOutNode, this._gndNode, 1, result);
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(_key: string, _value: number): void {
    // No hot-loadable params.
  }
}

export const BehavioralNotDriverDefinition: ComponentDefinition = {
  name: "BehavioralNotDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: NOT_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [],
      params: {},
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralNotDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
