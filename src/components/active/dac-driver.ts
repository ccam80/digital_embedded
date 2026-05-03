/**
 * DACDriver — internal-only hybrid pin+stamp+state driver leaf for the N-bit
 * DAC composite.
 *
 * Per Composite M25 (phase-composite-architecture.md), J-022
 * (contracts_group_02.md). Emitted by the `DAC` parent's `buildDacNetlist`
 * (`dac.ts`) as the single sub-element `drv`.
 *
 * Canonical Template D exemplar — combines Template C's matrix-stamping body
 * with Template A's state-bearing latch machinery. Reads N digital input
 * voltages from `rhsOld[D_i] - rhsOld[GND]`; latches each at threshold 0.5;
 * reads `rhsOld[VREF] - rhsOld[GND]` for the reference; computes output
 * target; stamps a VSRC-style branch row that enforces V_OUT - V_GND = target.
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
  applyInitialValues,
  type StateSchema,
  type SlotDescriptor,
} from "../../solver/analog/state-schema.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { AnalogElement, PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { StatePoolRef } from "../../solver/analog/state-pool.js";
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
      doc: `Latched digital input bit ${i} (0 or 1). Threshold 0.5 applied to rhsOld[D${i}] - rhsOld[GND].`,
      init: { kind: "zero" },
    });
  }
  slots.push({
    name: "OUTPUT_TARGET_V",
    doc: "Target output voltage computed from code and vref this step; stamped into rhs[br].",
    init: { kind: "zero" },
  });

  const schema = defineStateSchema(`DACDriver_${bits}b`, slots);
  DAC_SCHEMAS.set(bits, schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Pin layout — fixed, mirrors parent buildDacNetlist drvPins [0,1,2,3..N+2]
// Positions are placeholders; the driver is internal-only (no canvas render).
// ---------------------------------------------------------------------------

const DAC_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "VREF", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "OUT",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "GND",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

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

export class DACDriverElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly poolBacked = true as const;
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private readonly _bits: number;
  private readonly _bipolar: boolean;
  private readonly _maxCode: number;
  // Slot index for OUTPUT_TARGET_V (LATCHED_BIT_i are at indices 0..bits-1).
  private readonly _slotTarget: number;
  private _pool!: StatePoolRef;

  // VSRC TSTALLOC handles (vsrcsetup.c four-entry sequence).
  private _hOutBr  = -1;  // (OUT, br)
  private _hGndBr  = -1;  // (GND, br)
  private _hBrOut  = -1;  // (br,  OUT)
  private _hBrGnd  = -1;  // (br,  GND)

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._bits    = props.getModelParam<number>("bits");
    this._bipolar = props.getModelParam<number>("bipolar") !== 0;
    this._maxCode = this._bits >= 32 ? 0xFFFFFFFF : ((1 << this._bits) - 1);

    this.stateSchema = getDacSchema(this._bits);
    this.stateSize   = this.stateSchema.size;
    this._slotTarget = this.stateSchema.indexOf.get("OUTPUT_TARGET_V")!;
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);

    const solver  = ctx.solver;
    const outNode = this._pinNodes.get("OUT")!;
    const gndNode = this._pinNodes.get("GND")!;

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

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(this.stateSchema, pool, this._stateBase, {});
  }

  setParam(_key: string, _value: number): void {
    // bits and bipolar are structural (drive schema size and _maxCode);
    // not hot-loadable.
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0   = this._pool.states[0];
    const base = this._stateBase;

    const gndNode  = this._pinNodes.get("GND")!;
    const vrefNode = this._pinNodes.get("VREF")!;
    const gnd  = rhsOld[gndNode];
    const vref = rhsOld[vrefNode] - gnd;

    // Read and threshold-latch each digital input bit.
    const inputs: boolean[] = [];
    for (let i = 0; i < this._bits; i++) {
      const diNode = this._pinNodes.get(`D${i}`)!;
      const v = rhsOld[diNode] - gnd;
      inputs.push(v >= 0.5);
    }

    // Assemble binary code from latched inputs (LSB = D0).
    const code = inputs.reduce((acc, b, i) => acc + (b ? (1 << i) : 0), 0);

    // Compute target voltage.
    // Unipolar: target = vref * code / (2^N - 1)
    // Bipolar:  target = vref * (2 * code / (2^N - 1) - 1)  =>  shifts by -vref
    const normalized = code / this._maxCode;
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
      s0[base + i] = inputs[i] ? 1 : 0;
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
  pinLayout: DAC_DRIVER_PIN_LAYOUT,
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
