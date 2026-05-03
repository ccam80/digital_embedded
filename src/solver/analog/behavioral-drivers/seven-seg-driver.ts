/**
 * BehavioralSevenSegDriverElement- observation-only driver leaf for the
 * seven-segment display.
 *
 * Reads eight segment-input voltages (a, b, c, d, e, f, g, dp) from rhsOld
 * relative to gnd, threshold-classifies each against vIH/vIL hysteresis, and
 * writes the resulting logic level to the corresponding SEG_* observation slot.
 * Those slots are consumed by the parent composite's draw() function to
 * determine which segments to illuminate — they are NOT consumed via
 * siblingState by any DigitalOutputPinLoaded sub-element (no electrical output
 * pins exist on this component; the display itself is the consumer).
 *
 * Diverges from the d-flipflop canonical in:
 *   - pinLayout: 8 INPUT-only segment pins + 1 INPUT gnd (no OUTPUT pins)
 *   - schema: 8 observation-only SEG_* slots (no OUTPUT_LOGIC_LEVEL_* consumer slots)
 *   - load(): 8 independent threshold classifications, no edge detection, no latching
 *   - no siblingState consumer-side handling in the parent netlist
 *
 * Per Composite M13 (phase-composite-architecture.md), J-157
 * (contracts_group_10.md). Math migrated line-for-line from the old
 * SevenSegAnalogElement.load() in behavioral-remaining.ts (the composite read
 * each segment node voltage and classified it; here we do the same with pool
 * slots instead of sub-element delegation).
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../state-schema.js";
import { NGSPICE_LOAD_ORDER } from "../ngspice-load-order.js";
import type { PoolBackedAnalogElement } from "../element.js";
import type { StatePoolRef } from "../state-pool.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";
import { logicLevel } from "./edge-detect.js";

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralSevenSegDriver", [
  {
    name: "SEG_A",
    doc: "Observation-only logic level (0 or 1) for segment a. Written each load(); read by the parent component's draw() to determine illumination.",
  },
  {
    name: "SEG_B",
    doc: "Observation-only logic level (0 or 1) for segment b.",
  },
  {
    name: "SEG_C",
    doc: "Observation-only logic level (0 or 1) for segment c.",
  },
  {
    name: "SEG_D",
    doc: "Observation-only logic level (0 or 1) for segment d.",
  },
  {
    name: "SEG_E",
    doc: "Observation-only logic level (0 or 1) for segment e.",
  },
  {
    name: "SEG_F",
    doc: "Observation-only logic level (0 or 1) for segment f.",
  },
  {
    name: "SEG_G",
    doc: "Observation-only logic level (0 or 1) for segment g.",
  },
  {
    name: "SEG_DP",
    doc: "Observation-only logic level (0 or 1) for the decimal point segment (dp).",
  },
]);

const SLOT_SEG_A  = SCHEMA.indexOf.get("SEG_A")!;
const SLOT_SEG_B  = SCHEMA.indexOf.get("SEG_B")!;
const SLOT_SEG_C  = SCHEMA.indexOf.get("SEG_C")!;
const SLOT_SEG_D  = SCHEMA.indexOf.get("SEG_D")!;
const SLOT_SEG_E  = SCHEMA.indexOf.get("SEG_E")!;
const SLOT_SEG_F  = SCHEMA.indexOf.get("SEG_F")!;
const SLOT_SEG_G  = SCHEMA.indexOf.get("SEG_G")!;
const SLOT_SEG_DP = SCHEMA.indexOf.get("SEG_DP")!;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------
//
// Order MUST match the buildSevenSegNetlist drv connectivity row
// `[0, 1, 2, 3, 4, 5, 6, 7, netGnd(8)]` mapping to ports
// `[a, b, c, d, e, f, g, dp, gnd]`. The compiler reads pinLayout[i].label
// and stores it in _pinNodes against the resolved node from connectivity[i].
//
// All 9 pins are INPUT direction. There are no OUTPUT pins on this driver;
// the display rendering is the sole consumer of the SEG_* observation slots.

const SEVEN_SEG_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT, label: "a",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT, label: "b",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT, label: "c",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT, label: "d",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT, label: "e",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT, label: "f",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT, label: "g",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT, label: "dp",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT, label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// BehavioralSevenSegDriverElement
// ---------------------------------------------------------------------------

export class BehavioralSevenSegDriverElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHEMA;
  readonly poolBacked = true as const;
  readonly stateSize = SCHEMA.size;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private _vIH: number;
  private _vIL: number;
  private _pool!: StatePoolRef;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const gnd = rhsOld[this._pinNodes.get("gnd")!];
    const vA  = rhsOld[this._pinNodes.get("a")!]  - gnd;
    const vB  = rhsOld[this._pinNodes.get("b")!]  - gnd;
    const vC  = rhsOld[this._pinNodes.get("c")!]  - gnd;
    const vD  = rhsOld[this._pinNodes.get("d")!]  - gnd;
    const vE  = rhsOld[this._pinNodes.get("e")!]  - gnd;
    const vF  = rhsOld[this._pinNodes.get("f")!]  - gnd;
    const vG  = rhsOld[this._pinNodes.get("g")!]  - gnd;
    const vDP = rhsOld[this._pinNodes.get("dp")!] - gnd;

    // Threshold-classify each segment voltage with vIH/vIL hysteresis.
    // logicLevel holds the previous value when the input sits in the
    // indeterminate band (same convention as d-flipflop driver).
    const segA  = logicLevel(vA,  this._vIH, this._vIL, s1[base + SLOT_SEG_A]  >= 0.5 ? 1 : 0);
    const segB  = logicLevel(vB,  this._vIH, this._vIL, s1[base + SLOT_SEG_B]  >= 0.5 ? 1 : 0);
    const segC  = logicLevel(vC,  this._vIH, this._vIL, s1[base + SLOT_SEG_C]  >= 0.5 ? 1 : 0);
    const segD  = logicLevel(vD,  this._vIH, this._vIL, s1[base + SLOT_SEG_D]  >= 0.5 ? 1 : 0);
    const segE  = logicLevel(vE,  this._vIH, this._vIL, s1[base + SLOT_SEG_E]  >= 0.5 ? 1 : 0);
    const segF  = logicLevel(vF,  this._vIH, this._vIL, s1[base + SLOT_SEG_F]  >= 0.5 ? 1 : 0);
    const segG  = logicLevel(vG,  this._vIH, this._vIL, s1[base + SLOT_SEG_G]  >= 0.5 ? 1 : 0);
    const segDP = logicLevel(vDP, this._vIH, this._vIL, s1[base + SLOT_SEG_DP] >= 0.5 ? 1 : 0);

    // Bottom-of-load writes- every slot mutated this step writes to s0
    // exactly once (no pre-stamp s0 mutations).
    s0[base + SLOT_SEG_A]  = segA;
    s0[base + SLOT_SEG_B]  = segB;
    s0[base + SLOT_SEG_C]  = segC;
    s0[base + SLOT_SEG_D]  = segD;
    s0[base + SLOT_SEG_E]  = segE;
    s0[base + SLOT_SEG_F]  = segF;
    s0[base + SLOT_SEG_G]  = segG;
    s0[base + SLOT_SEG_DP] = segDP;
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

export const BehavioralSevenSegDriverDefinition: ComponentDefinition = {
  name: "BehavioralSevenSegDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: SEVEN_SEG_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
      ],
      params: { vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralSevenSegDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
