/**
 * BehavioralDFlipflopDriverElement — pure-truth-function driver leaf for the
 * edge-triggered D flip-flop. See and-driver.ts for the normalized-bit
 * driver-chain architecture.
 *
 * Reads C and D as normalized {0, 1} V. Edge-detects on C against 0.5 V;
 * on rising edge samples D into Q. Stamps ctrl_q at q, ctrl_nq at 1−q.
 *
 * Per Composite M14 (phase-composite-architecture.md), J-142 (contracts_group_10.md).
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
import { detectRisingEdge } from "./edge-detect.js";
import { allocNortonStamp, stampNortonValue } from "../stamp-helpers.js";

const SCHEMA: StateSchema = defineStateSchema("BehavioralDFlipflopDriver", [
  {
    name: "LAST_CLOCK",
    doc: "Clock voltage at last accepted timestep — compared against current rhsOld[C] for rising-edge detection. NaN sentinel on the first sample skips edge detection so a circuit starting with the clock high does not produce a spurious edge.",
  },
  {
    name: "Q",
    doc: "Latched output bit (0 or 1). Updated only on a rising clock edge from the D input.",
  },
]);

const SLOT_LAST_CLOCK = SCHEMA.indexOf.get("LAST_CLOCK")!;
const SLOT_Q          = SCHEMA.indexOf.get("Q")!;

const D_FF_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "D",       defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "C",       defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_q",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_nq", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd",     defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

export class BehavioralDFlipflopDriverElement extends PoolBackedAnalogElement {
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
    const vD     = rhsOld[this.pinNodes.get("D")!] - gnd;

    const prevClock = s1[base + SLOT_LAST_CLOCK];
    let q: 0 | 1 = s1[base + SLOT_Q] >= 0.5 ? 1 : 0;

    if (!this._firstSample && detectRisingEdge(prevClock, vClock, 0.5)) {
      q = vD >= 0.5 ? 1 : 0;
    }
    this._firstSample = false;

    stampNortonValue(ctx, this._handlesQ,  this._ctrlQNode,  this._gndNode, 1, q);
    stampNortonValue(ctx, this._handlesNq, this._ctrlNqNode, this._gndNode, 1, q ? 0 : 1);

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

export const BehavioralDFlipflopDriverDefinition: ComponentDefinition = {
  name: "BehavioralDFlipflopDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: D_FF_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [],
      params: {},
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralDFlipflopDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
