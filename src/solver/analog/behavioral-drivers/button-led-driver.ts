/**
 * BehavioralButtonLEDDriverElement- pure threshold-classification driver leaf
 * for the ButtonLED component.
 *
 * Reads the LED input voltage (relative to gnd) from rhsOld, threshold-
 * classifies it against per-instance vIH / vIL with hysteresis (hold-on-
 * indeterminate), and writes the result to OUTPUT_LOGIC_LEVEL. That slot is
 * consumed via siblingState by the parent composite's outPin
 * DigitalOutputPinLoaded sub-element.
 *
 * No MNA stamps. Template A (3-pin, 1-slot, fixed pin count).
 *
 * Pin layout (MUST match the drv connectivity row in buildButtonLEDNetlist):
 *   out(0)  - button output net (included for parent-port symmetry; not read)
 *   in(1)   - LED input net (voltage observed for threshold classification)
 *   gnd(2)  - ground reference
 *
 * Per Composite M10 (phase-composite-architecture.md).
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../state-schema.js";
import { NGSPICE_LOAD_ORDER } from "../ngspice-load-order.js";
import { AbstractPoolBackedAnalogElement } from "../element.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";
import { logicLevel } from "./edge-detect.js";

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralButtonLEDDriver", [
  {
    name: "OUTPUT_LOGIC_LEVEL",
    doc: "Threshold-classified LED input level (0 or 1) consumed via siblingState by the parent composite's outPin DigitalOutputPinLoaded sub-element.",
  },
]);

const SLOT_OUT = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL")!;

// ---------------------------------------------------------------------------
// Pin layout- fixed 3-pin (Template A), module-level const
// ---------------------------------------------------------------------------
//
// Order MUST match the drv connectivity row in buildButtonLEDNetlist:
//   [out_net, in_net, gnd_net] => indices [0, 1, 2].
//
// "out" is included for parent-port symmetry. load() does not read it.

const BUTTON_LED_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  {
    direction: PinDirection.OUTPUT, label: "out",
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

export class BehavioralButtonLEDDriverElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _inNode: number;
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._inNode  = pinNodes.get("in")!;
    this._gndNode = pinNodes.get("gnd")!;
    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }

  /**
   * Threshold-classify the LED input voltage with hold-on-indeterminate
   * hysteresis (mirrors buf-driver / not-driver Template A pattern):
   *   v >= vIH  → output 1
   *   v <  vIL  → output 0
   *   otherwise → hold prior output
   */
  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const vIn = rhsOld[this._inNode] - rhsOld[this._gndNode];
    const prev: 0 | 1 = s1[base + SLOT_OUT] >= 0.5 ? 1 : 0;

    const level = logicLevel(vIn, this._vIH, this._vIL, prev);

    s0[base + SLOT_OUT] = level;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this._pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
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
      ],
      params: { vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralButtonLEDDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
