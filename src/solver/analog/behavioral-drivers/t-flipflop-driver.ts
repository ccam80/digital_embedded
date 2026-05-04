/**
 * BehavioralTFlipflopDriverElement- pure-truth-function driver leaf for the
 * edge-triggered T flip-flop.
 *
 * Two modes, selected by the `forceToggle` param:
 *   forceToggle=0 (default, withEnable=true): on rising clock edge, toggle Q
 *                 when T >= vIH (high), hold when T < vIL (low). Indeterminate
 *                 T holds Q.
 *   forceToggle=1 (withEnable=false): on rising clock edge, ALWAYS toggle Q.
 *                 T input is ignored; the parent netlist wires T to gnd as a
 *                 placeholder so the pin layout stays uniform.
 *
 * Q / ~Q levels are written to OUTPUT_LOGIC_LEVEL_Q / OUTPUT_LOGIC_LEVEL_NQ
 * for siblingState consumption by the qPin / nqPin DigitalOutputPinLoaded
 * sub-elements.
 *
 * Per Composite M15 (phase-composite-architecture.md), J-159.
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
import { detectRisingEdge } from "./edge-detect.js";

const SCHEMA: StateSchema = defineStateSchema("BehavioralTFlipflopDriver", [
  { name: "LAST_CLOCK",            doc: "Clock voltage at last accepted timestep. NaN sentinel on the first sample skips edge detection." },
  { name: "Q",                     doc: "Latched output bit (0 or 1)." },
  { name: "OUTPUT_LOGIC_LEVEL_Q",  doc: "Q output level consumed via siblingState by qPin." },
  { name: "OUTPUT_LOGIC_LEVEL_NQ", doc: "~Q output level consumed via siblingState by nqPin." },
]);

const SLOT_LAST_CLOCK = SCHEMA.indexOf.get("LAST_CLOCK")!;
const SLOT_Q          = SCHEMA.indexOf.get("Q")!;
const SLOT_OUT_Q      = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL_Q")!;
const SLOT_OUT_NQ     = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL_NQ")!;

const T_FF_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "T",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "C",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "Q",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "~Q",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

export class BehavioralTFlipflopDriverElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _vIH: number;
  private readonly _forceToggle: 0 | 1;

  private _firstSample: boolean = true;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._vIH = props.getModelParam<number>("vIH");
    this._forceToggle = props.hasModelParam("forceToggle")
      ? (props.getModelParam<number>("forceToggle") >= 0.5 ? 1 : 0)
      : 0;
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const gnd    = rhsOld[this._pinNodes.get("gnd")!];
    const vClock = rhsOld[this._pinNodes.get("C")!] - gnd;
    const vT     = rhsOld[this._pinNodes.get("T")!] - gnd;

    const prevClock = s1[base + SLOT_LAST_CLOCK];
    let q = s1[base + SLOT_Q] >= 0.5 ? 1 : 0;

    if (!this._firstSample && detectRisingEdge(prevClock, vClock, this._vIH)) {
      if (this._forceToggle === 1) {
        // withEnable=false: unconditionally toggle on every rising edge.
        q = 1 - q;
      } else if (vT >= this._vIH) {
        // withEnable=true: T high → toggle. T low (vT < vIL) and T
        // indeterminate (vIL <= vT < vIH) both hold q (no else branch).
        q = 1 - q;
      }
    }
    this._firstSample = false;

    s0[base + SLOT_LAST_CLOCK] = vClock;
    s0[base + SLOT_Q]          = q;
    s0[base + SLOT_OUT_Q]      = q;
    s0[base + SLOT_OUT_NQ]     = 1 - q;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this._pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "vIH") this._vIH = value;
  }
}

export const BehavioralTFlipflopDriverDefinition: ComponentDefinition = {
  name: "BehavioralTFlipflopDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: T_FF_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vIH",         default: 2.0 },
        { key: "vIL",         default: 0.8 },
        { key: "forceToggle", default: 0 },
      ],
      params: { vIH: 2.0, vIL: 0.8, forceToggle: 0 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralTFlipflopDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
