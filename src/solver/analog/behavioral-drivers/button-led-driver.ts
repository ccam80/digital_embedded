/**
 * BehavioralButtonLEDDriverElement — pure threshold-classification driver leaf
 * for the ButtonLED component. See and-driver.ts for the normalized-bit
 * driver-chain architecture.
 *
 * Reads the LED input voltage (relative to gnd) and threshold-classifies at
 * 0.5 V. Stamps a Norton source at ctrl_out encoding the button state.
 *
 * Pin layout (MUST match the drv connectivity row in buildButtonLEDNetlist):
 *   ctrl_out(0) - button output control net (Norton stamp target)
 *   in(1)       - LED input net (voltage observed for threshold classification)
 *   gnd(2)      - ground reference
 *
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

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralButtonLEDDriver", []);

// ---------------------------------------------------------------------------
// Pin layout — fixed 3-pin (Template A), module-level const
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
  private _handles: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, _props: PropertyBag) {
    super(pinNodes);
    this._ctrlOutNode = pinNodes.get("ctrl_out")!;
    this._inNode      = pinNodes.get("in")!;
    this._gndNode     = pinNodes.get("gnd")!;
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    this._handles = allocNortonStamp(ctx.solver, this._ctrlOutNode, this._gndNode);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const vIn = rhsOld[this._inNode] - rhsOld[this._gndNode];
    stampNortonValue(ctx, this._handles, this._ctrlOutNode, this._gndNode, 1, vIn);
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(_key: string, _value: number): void {
    // No hot-loadable params.
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
      paramDefs: [],
      params: {},
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag) =>
        new BehavioralButtonLEDDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
