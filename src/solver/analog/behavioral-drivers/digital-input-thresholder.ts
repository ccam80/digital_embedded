/**
 * DigitalInputThresholderElement — stateless rail-down classifier leaf.
 *
 * Reads V(in) − V(gnd) each NR iteration and Norton-stamps the result node
 * at 1.0 V (HI), 0.0 V (LO), or 0.5 V (indeterminate) according to the
 * vIH / vIL thresholds. Strict > / < comparators: a voltage exactly equal
 * to either threshold lands in the indeterminate 0.5 V band.
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

const SCHEMA: StateSchema = defineStateSchema("DigitalInputThresholder", []);

export const THRESHOLDER_PIN_LAYOUT: PinDeclaration[] = [
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
  {
    direction: PinDirection.OUTPUT, label: "result",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
];

export class DigitalInputThresholderElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _inputNode: number;
  private readonly _gndNode: number;
  private readonly _resultNode: number;
  private _vIH: number;
  private _vIL: number;
  private _handles: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._inputNode = pinNodes.get("in")!;
    this._gndNode = pinNodes.get("gnd")!;
    this._resultNode = pinNodes.get("result")!;
    // vIH/vIL are declared in this model's paramDefs — read directly.
    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    this._handles = allocNortonStamp(ctx.solver, this._resultNode, this._gndNode);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const v = rhsOld[this._inputNode] - rhsOld[this._gndNode];
    const result = v > this._vIH ? 1.0 : v < this._vIL ? 0.0 : 0.5;
    stampNortonValue(ctx, this._handles, this._resultNode, this._gndNode, 1, result);
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
    // Unknown keys are silently ignored (no-op).
  }
}

export const DigitalInputThresholderDefinition: ComponentDefinition = {
  name: "DigitalInputThresholder",
  typeId: -1,
  internalOnly: true,
  pinLayout: THRESHOLDER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
      ],
      params: {},
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new DigitalInputThresholderElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
