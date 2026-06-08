/**
 * BehavioralRSFlipflopDriverElement — pure-truth-function driver leaf for the
 * edge-triggered RS flip-flop. See and-driver.ts for the normalized-bit
 * driver-chain architecture.
 *
 * On rising clock edge:
 *   S=0, R=0 → hold
 *   S=1, R=0 → q=1
 *   S=0, R=1 → q=0
 *   S=1, R=1 → forbidden, hold (no diagnostic in pool-backed model)
 *
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

const SCHEMA: StateSchema = defineStateSchema("BehavioralRSFlipflopDriver", [
  { name: "LAST_CLOCK", doc: "Clock voltage at last accepted timestep. NaN sentinel on first sample skips edge detection." },
  { name: "Q",          doc: "Latched output bit." },
]);

const SLOT_LAST_CLOCK = SCHEMA.indexOf.get("LAST_CLOCK")!;
const SLOT_Q          = SCHEMA.indexOf.get("Q")!;

const RS_FF_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "S",       defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "C",       defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
  { direction: PinDirection.INPUT,  label: "R",       defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_q",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_nq", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd",     defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

export class BehavioralRSFlipflopDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _firstSample: boolean = true;

  private _ctrlQNode: number = 0;
  private _ctrlNqNode: number = 0;
  private _gndNode: number = 0;
  private _handlesQ: readonly [number, number, number, number] = [-1, -1, -1, -1];
  private _handlesNq: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, _props: PropertyBag) {
    super(pinNodes);
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

    const gnd    = rhsOld[this._gndNode];
    const vClock = rhsOld[this.pinNodes.get("C")!] - gnd;
    const vS     = rhsOld[this.pinNodes.get("S")!] - gnd;
    const vR     = rhsOld[this.pinNodes.get("R")!] - gnd;

    const prevClock  = s1[base + SLOT_LAST_CLOCK];
    const risingEdge = this._firstSample ? 0 : vClock * (1 - prevClock);
    this._firstSample = false;
    const state = s1[base + SLOT_Q];
    let clockedNext: number;
    if (vR + vS > 1) {
      clockedNext = 0.5;
    } else {
      clockedNext = vS * 1 + vR * 0 + (1 - vR - vS + vR * vS) * state;
    }
    const q = state * (1 - risingEdge) + clockedNext * risingEdge;

    stampNortonValue(ctx, this._handlesQ,  this._ctrlQNode,  this._gndNode, 1, q);
    stampNortonValue(ctx, this._handlesNq, this._ctrlNqNode, this._gndNode, 1, 1 - q);

    s0[base + SLOT_LAST_CLOCK] = vClock;
    s0[base + SLOT_Q]          = q;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(_key: string, _value: number): void {
    // No hot-loadable params.
  }
}

export const BehavioralRSFlipflopDriverDefinition: ComponentDefinition = {
  name: "BehavioralRSFlipflopDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: RS_FF_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [],
      params: {},
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralRSFlipflopDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
