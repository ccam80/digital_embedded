/**
 * DACDriver — internal-only hybrid pin+stamp+state driver leaf for the N-bit
 * DAC composite.
 *
 * Emitted by the `DAC` parent's `buildDacNetlist`
 * (`dac.ts`) as the single sub-element `drv`.
 *
 * Canonical Template D exemplar — combines Template C's matrix-stamping body
 * with Template A's state-bearing latch machinery. Reads N digital input
 * voltages from `rhsOld[D_i] - rhsOld[GND]` and quantizes each at the
 * logic-HIGH boundary (the dPin DIPL's Kleene 0.5 indeterminate resolves to
 * logic LOW); reads `rhsOld[VREF] - rhsOld[GND]` for the reference;
 * computes output target; stamps a VSRC-style branch row that enforces
 * V_OUT - V_GND = target.
 *
 * Schema is variable-arity (N from `bits` param). Module-scope memoised
 * factory `getDacSchema(bits)` per the counter-driver.ts pattern.
 *
 * Pin order (FIXED, matches parent buildDacNetlist drvPins):
 *   [0] VREF, [1] OUT, [2] GND, [3..N+2] D0..D(N-1)
 *
 * Branch stamp: VSRC TSTALLOC shape (vsrcsetup.c):
 *   +1 at (OUT, br), -1 at (GND, br)   — KCL rows
 *   +1 at (br, OUT), -1 at (br, GND)   — KVL row (V_OUT - V_GND = target)
 * load() writes rhs[br] += target.
 */

import {
  defineStateSchema,
  type StateSchema,
  type SlotDescriptor,
} from "../../solver/analog/state-schema.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import { PoolBackedAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";
import { PropertyBag } from "../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// Memoised arity-indexed schema factory
// ---------------------------------------------------------------------------
//
// Slot layout for N bits:
//   [0 .. N-1]   LATCHED_BIT_0 .. LATCHED_BIT_(N-1)   — per-bit latch state
//   [N]          OUTPUT_TARGET_V                        — stamped target voltage

const DAC_SCHEMAS = new Map<number, StateSchema>();

function getDacSchema(bits: number): StateSchema {
  let cached = DAC_SCHEMAS.get(bits);
  if (cached !== undefined) return cached;

  const slots: SlotDescriptor[] = [];
  for (let i = 0; i < bits; i++) {
    slots.push({
      name: `LATCHED_BIT_${i}`,
      doc: `Quantized input bit ${i}: rhsOld[D${i}] - rhsOld[GND] resolved at the logic-HIGH boundary to {0, 1}.`,
    });
  }
  slots.push({
    name: "OUTPUT_TARGET_V",
    doc: "Target output voltage computed from code and vref this step; stamped into rhs[br].",
  });

  const schema = defineStateSchema(`DACDriver_${bits}b`, slots);
  DAC_SCHEMAS.set(bits, schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Pin layout — fixed, mirrors parent buildDacNetlist drvPins [0,1,2,3..N+2]
// Positions are placeholders; the driver is internal-only (no canvas render).
// ---------------------------------------------------------------------------

/**
 * Build the pin layout for an N-bit DACDriver.
 * Pin order MUST match parent buildDacNetlist drvPins: VREF, OUT, GND, D0..D(N-1).
 */
function buildDacDriverPinLayout(bits: number): PinDeclaration[] {
  const layout: PinDeclaration[] = [
    { direction: PinDirection.INPUT,  label: "VREF", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "OUT",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "GND",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
  for (let i = 0; i < bits; i++) {
    layout.push({ direction: PinDirection.INPUT, label: `D${i}`, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" });
  }
  return layout;
}

// ---------------------------------------------------------------------------
// Param defs
// ---------------------------------------------------------------------------

const DAC_DRIVER_PARAM_DEFS: ParamDef[] = [
  { key: "bits",    default: 8 },
  { key: "bipolar", default: 0 },
];

const DAC_DRIVER_DEFAULTS: Record<string, number> = {
  bits:    8,
  bipolar: 0,
};

// ---------------------------------------------------------------------------
// DACDriverElement
// ---------------------------------------------------------------------------

export class DACDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  private readonly _bits: number;
  private readonly _bipolar: boolean;
  private readonly _levels: number;
  // Slot index for OUTPUT_TARGET_V (LATCHED_BIT_i are at indices 0..bits-1).
  private readonly _slotTarget: number;

  // VSRC TSTALLOC handles (vsrcsetup.c four-entry sequence).
  private _hOutBr  = -1;  // (OUT, br)
  private _hGndBr  = -1;  // (GND, br)
  private _hBrOut  = -1;  // (br,  OUT)
  private _hBrGnd  = -1;  // (br,  GND)

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._bits    = props.getModelParam<number>("bits");
    this._bipolar = props.getModelParam<number>("bipolar") !== 0;
    this._levels = 2 ** this._bits;

    this.stateSchema = getDacSchema(this._bits);
    this.stateSize   = this.stateSchema.size;
    this._slotTarget = this.stateSchema.indexOf.get("OUTPUT_TARGET_V")!;
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);

    const solver  = ctx.solver;
    const outNode = this.pinNodes.get("OUT")!;
    const gndNode = this.pinNodes.get("GND")!;

    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label ?? "dac", "branch");
    }
    const br = this.branchIndex;

    // VSRC TSTALLOC sequence (vsrcsetup.c), four entries.
    this._hOutBr = solver.allocElement(outNode, br);
    this._hGndBr = solver.allocElement(gndNode, br);
    this._hBrOut = solver.allocElement(br,      outNode);
    this._hBrGnd = solver.allocElement(br,      gndNode);
  }

  setParam(_key: string, _value: number): void {
    // bits and bipolar are structural (drive schema size and _levels);
    // not hot-loadable.
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0   = this._pool.states[0];
    const base = this._stateBase;

    const gndNode  = this.pinNodes.get("GND")!;
    const vrefNode = this.pinNodes.get("VREF")!;
    const gnd  = rhsOld[gndNode];
    const vref = rhsOld[vrefNode] - gnd;

    // Read each digital input bit and quantize at the logic-HIGH boundary. The
    // dPin DIPL emits the Kleene classifier {0, 0.5, 1}; an indeterminate 0.5
    // (input between vIL and vIH) resolves to logic LOW for code assembly.
    const inputs: number[] = [];
    for (let i = 0; i < this._bits; i++) {
      const diNode = this.pinNodes.get(`D${i}`)!;
      const vraw = rhsOld[diNode] - gnd;
      const v = vraw >= 1 ? 1 : 0;
      inputs.push(v);
    }

    // Assemble the integer code from quantized bits (LSB = D0). Each bit is
    // already 0 or 1, so a sub-threshold input contributes nothing to the code.
    const code = inputs.reduce((acc, v, i) => acc + v * (1 << i), 0);

    // Compute target voltage. The full-scale divisor is 2^N (number of levels),
    // so code = 2^N-1 (all ones) maps to vref·(2^N-1)/2^N — one LSB below vref.
    // Unipolar: target = vref * code / 2^N
    // Bipolar:  target = vref * (2 * code / 2^N - 1)  =>  shifts by -vref
    const normalized = code / this._levels;
    const target = this._bipolar
      ? vref * (2 * normalized - 1)
      : vref * normalized;

    // Stamp VSRC incidence (+1/-1) and RHS.
    const solver = ctx.solver;
    solver.stampElement(this._hOutBr,  1);
    solver.stampElement(this._hGndBr, -1);
    solver.stampElement(this._hBrOut,  1);
    solver.stampElement(this._hBrGnd, -1);
    ctx.rhs[this.branchIndex] += target;

    // Bottom-of-load writes — every slot mutated this step writes to s0 exactly once.
    for (let i = 0; i < this._bits; i++) {
      s0[base + i] = inputs[i];
    }
    s0[base + this._slotTarget] = target;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    // Branch current flows into OUT and returns via GND; digital inputs carry none.
    const I = this.branchIndex >= 0 ? rhs[this.branchIndex] : 0;
    // Pin order: VREF, OUT, GND, D0..D(N-1)
    const currents = new Array(3 + this._bits).fill(0) as number[];
    currents[1] =  I;   // OUT
    currents[2] = -I;   // GND
    return currents;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const DACDriverDefinition: ComponentDefinition = {
  name: "DACDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: (props: PropertyBag) => buildDacDriverPinLayout(props.getModelParam<number>("bits")),
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: DAC_DRIVER_PARAM_DEFS,
      params: DAC_DRIVER_DEFAULTS,
      branchCount: 1,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new DACDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
