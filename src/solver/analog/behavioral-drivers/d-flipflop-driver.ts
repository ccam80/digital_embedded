/**
 * BehavioralDFlipflopDriverElement- pure-truth-function driver leaf for the
 * edge-triggered D flip-flop.
 *
 * Reads clock and D voltages from rhsOld, detects rising clock edge against
 * s1[LAST_CLOCK], samples D on the edge using vIH/vIL hysteresis, and writes
 * the latched Q value (and its complement) to OUTPUT_LOGIC_LEVEL_Q /
 * OUTPUT_LOGIC_LEVEL_NQ. Those slots are consumed via siblingState by the
 * D-FF netlist's qPin / nqPin DigitalOutputPinLoaded sub-elements.
 *
 * Strictly 1-bit. Multi-bit D-FF composites instantiate N driver leaves;
 * bit-width scaling is the parent composite's responsibility, not this
 * leaf's.
 *
 * Canonical reference for pure-truth-function driver leaves: every other
 * gate / wiring / sequential / latch driver in this directory mirrors this
 * file's shape (imports, class layout, schema/pin/load() placement, model
 * registry). Only the schema slot list, pin layout, and load() body vary
 * between drivers.
 *
 * Per Composite M14 (phase-composite-architecture.md), J-142
 * (contracts_group_10.md). Threshold values come from per-instance vIH / vIL
 * params rather than the spec-skeleton 0.5 (user override- preserves the
 * recovered originals' CMOS-spec-driven thresholding fidelity).
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
import { detectRisingEdge, logicLevel } from "./edge-detect.js";

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralDFlipflopDriver", [
  {
    name: "LAST_CLOCK",
    doc: "Clock voltage at last accepted timestep- compared against current rhsOld[C] for rising-edge detection. NaN sentinel on the first sample skips edge detection so a circuit starting with the clock high does not produce a spurious edge.",
  },
  {
    name: "Q",
    doc: "Latched output bit (0 or 1). Updated only on a rising clock edge from the D input.",
  },
  {
    name: "OUTPUT_LOGIC_LEVEL_Q",
    doc: "Q output level (0 or 1) consumed via siblingState by the qPin DigitalOutputPinLoaded sub-element.",
  },
  {
    name: "OUTPUT_LOGIC_LEVEL_NQ",
    doc: "~Q output level (1 - Q) consumed via siblingState by the nqPin DigitalOutputPinLoaded sub-element.",
  },
]);

const SLOT_LAST_CLOCK = SCHEMA.indexOf.get("LAST_CLOCK")!;
const SLOT_Q          = SCHEMA.indexOf.get("Q")!;
const SLOT_OUT_Q      = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL_Q")!;
const SLOT_OUT_NQ     = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL_NQ")!;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------
//
// Order MUST match the buildDFlipflopNetlist drv connectivity row
// `[0, 1, 2, 3, 4]` mapping to ports `[D, C, Q, ~Q, gnd]`. The compiler reads
// pinLayout[i].label and stores it in _pinNodes against the resolved node
// from connectivity[i] (compiler.ts:443-446).
//
// Q and ~Q pins are connected to the parent composite's Q / ~Q nets so the
// driver could observe them, but load() does not stamp- the qPin / nqPin
// DigitalOutputPinLoaded sub-elements consume the OUTPUT_LOGIC_LEVEL_*
// slots via siblingState and own the actual VSRC stamps.

const D_FF_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "D",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "C",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "Q",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "~Q",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// BehavioralDFlipflopDriverElement
// ---------------------------------------------------------------------------

export class BehavioralDFlipflopDriverElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _vIH: number;
  private _vIL: number;

  private _firstSample: boolean = true;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
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
    const vClock = rhsOld[this._pinNodes.get("C")!]   - gnd;
    const vD     = rhsOld[this._pinNodes.get("D")!]   - gnd;

    const prevClock = s1[base + SLOT_LAST_CLOCK];
    let q: 0 | 1 = s1[base + SLOT_Q] >= 0.5 ? 1 : 0;

    // Rising-edge detect on clock; on edge, threshold-classify D with
    // vIH/vIL hysteresis (logicLevel holds q when D sits in the indeterminate
    // band). NaN-prev sentinel inside detectRisingEdge skips the first step.
    if (!this._firstSample && detectRisingEdge(prevClock, vClock, this._vIH)) {
      q = logicLevel(vD, this._vIH, this._vIL, q);
    }
    this._firstSample = false;

    // Bottom-of-load writes- every slot mutated this step writes to s0
    // exactly once (no pre-stamp s0 mutations).
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
    else if (key === "vIL") this._vIL = value;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralDFlipflopDriverDefinition: ComponentDefinition = {
  name: "BehavioralDFlipflopDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: D_FF_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
      ],
      params: { vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralDFlipflopDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
