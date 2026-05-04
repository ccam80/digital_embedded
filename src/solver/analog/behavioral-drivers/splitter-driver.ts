/**
 * BehavioralSplitterDriverElement- multi-port driver leaf for the
 * combinational splitter / bus-splitter.
 *
 * Reads N input voltages (relative to gnd), threshold-classifies each,
 * and writes M OUTPUT_LOGIC_LEVEL_<i> slots consumed via siblingState by
 * M sibling DigitalOutputPinLoaded sub-elements in the parent composite.
 *
 * Pin order MUST match buildSplitterNetlist drvNets:
 *   [in_0..in_{N-1}, out_0..out_{M-1}, gnd]
 *
 * Variable-arity schema: one OUTPUT_LOGIC_LEVEL_<i> slot per output port.
 * Schema is memoised by (inputCount, outputCount) key via module-scope Map.
 *
 * Canonical shape reference: counter-driver.ts (A-multi-bit-schema).
 *
 * Per Composite M13 (contracts_group_10.md), J-158.
 * Math migrated line-for-line from the SplitterAnalogElement.load() body
 * that formerly lived in behavioral-remaining.ts (removed during J-070 wave).
 */

import {
  defineStateSchema,
  type StateSchema,
  type SlotDescriptor,
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
// Memoised arity-indexed schema factory
// ---------------------------------------------------------------------------
//
// Key: `${inputCount}:${outputCount}`.
// Slot layout for N inputs, M outputs:
//   [0 .. M-1]   OUTPUT_LOGIC_LEVEL_0 .. OUTPUT_LOGIC_LEVEL_{M-1}   ← consumed-by-pin

const SPLITTER_SCHEMAS = new Map<string, StateSchema>();

function getSplitterSchema(inputCount: number, outputCount: number): StateSchema {
  const key = `${inputCount}:${outputCount}`;
  let cached = SPLITTER_SCHEMAS.get(key);
  if (cached !== undefined) return cached;

  const slots: SlotDescriptor[] = [];
  for (let i = 0; i < outputCount; i++) {
    slots.push({
      name: `OUTPUT_LOGIC_LEVEL_${i}`,
      doc: `Output logic level for output port ${i}; consumed via siblingState by the parent composite's outPin_${i} DigitalOutputPinLoaded sub-element.`,
    });
  }

  const schema = defineStateSchema(`BehavioralSplitterDriver_${inputCount}i_${outputCount}o`, slots);
  SPLITTER_SCHEMAS.set(key, schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Pin layout factory- variable arity
// ---------------------------------------------------------------------------
//
// Pin order MUST match buildSplitterNetlist drvNets exactly:
//   in_0 .. in_{N-1}, out_0 .. out_{M-1}, gnd

function buildSplitterDriverPinLayout(props: PropertyBag): PinDeclaration[] {
  const inputCount = props.getModelParam<number>("inputCount");
  const outputCount = props.getModelParam<number>("outputCount");

  const decls: PinDeclaration[] = [];
  for (let i = 0; i < inputCount; i++) {
    decls.push({
      direction: PinDirection.INPUT,
      label: `in_${i}`,
      defaultBitWidth: 1,
      position: { x: 0, y: i },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    });
  }
  for (let i = 0; i < outputCount; i++) {
    decls.push({
      direction: PinDirection.OUTPUT,
      label: `out_${i}`,
      defaultBitWidth: 1,
      position: { x: 0, y: inputCount + i },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    });
  }
  decls.push({
    direction: PinDirection.INPUT,
    label: "gnd",
    defaultBitWidth: 1,
    position: { x: 0, y: inputCount + outputCount },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  });
  return decls;
}

// ---------------------------------------------------------------------------
// BehavioralSplitterDriverElement
// ---------------------------------------------------------------------------

export class BehavioralSplitterDriverElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  private readonly _inputCount: number;
  private readonly _outputCount: number;
  private readonly _inNodes: number[];
  private readonly _outNodes: number[];
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._inputCount = props.getModelParam<number>("inputCount");
    this._outputCount = props.getModelParam<number>("outputCount");

    this.stateSchema = getSplitterSchema(this._inputCount, this._outputCount);
    this.stateSize = this.stateSchema.size;

    this._inNodes = [];
    for (let i = 0; i < this._inputCount; i++) {
      this._inNodes.push(pinNodes.get(`in_${i}`)!);
    }
    this._outNodes = [];
    for (let i = 0; i < this._outputCount; i++) {
      this._outNodes.push(pinNodes.get(`out_${i}`)!);
    }
    this._gndNode = pinNodes.get("gnd")!;
    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }

  /**
   * Classify input voltages and write OUTPUT_LOGIC_LEVEL_<i> slots, mirroring
   * executeSplitter's three-mode logic (splitter.ts).
   *
   * Split  (inputCount === 1, outputCount >= 1):
   *   in_0 carries a packed integer bus voltage. Extract bit i from the
   *   integer for each output slot i, then hysteresis-classify via logicLevel.
   *   Mirrors executeSplitter's extractBits(wideValue, startBit, 1) per output.
   *
   * Merge  (outputCount === 1, inputCount >= 1):
   *   Each in_i is a narrow (1-bit) bus; classify each to 0|1 and pack into
   *   slot 0 as bit i. Mirrors executeSplitter's insertBits accumulation.
   *
   * Passthrough (inputCount === outputCount, neither mode above applies):
   *   Classify in_i directly to slot i. Mirrors the implicit no-op in
   *   executeSplitter for the non-split non-merge case — but here we must
   *   still drive outputs, so we classify 1:1.
   *
   * vIL for hysteresis is read from props (default 0.8, hot-loadable via setParam).
   * prevBit for each slot reads s1[base + i] (prior step's output slot).
   */
  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;
    const gnd = rhsOld[this._gndNode];
    const vIH = this._vIH;
    const vIL = this._vIL;

    if (this._inputCount === 1 && this._outputCount >= 1) {
      // Split mode: unpack bit i from the wide bus voltage at in_0.
      const vIn = rhsOld[this._inNodes[0]] - gnd;
      const packed = vIn >>> 0;  // ToUint32 truncation — matches bus-pin convention
      for (let i = 0; i < this._outputCount; i++) {
        const bitVoltage = (packed >>> i) & 1;
        const prev = s1[base + i] >= 0.5 ? 1 : 0;
        s0[base + i] = logicLevel(bitVoltage, vIH, vIL, prev);
      }
    } else if (this._outputCount === 1 && this._inputCount >= 1) {
      // Merge mode: classify each narrow input and pack into slot 0.
      let packed = 0;
      for (let i = 0; i < this._inputCount; i++) {
        const vIn = rhsOld[this._inNodes[i]] - gnd;
        const prev = (s1[base + 0] >>> i) & 1;  // bit i of prior packed output
        const bit = logicLevel(vIn, vIH, vIL, prev as 0 | 1);
        packed |= bit << i;
      }
      s0[base] = packed >>> 0;
    } else {
      // Passthrough mode: classify in_i → slot i directly.
      const n = Math.min(this._inputCount, this._outputCount);
      for (let i = 0; i < n; i++) {
        const vIn = rhsOld[this._inNodes[i]] - gnd;
        const prev = s1[base + i] >= 0.5 ? 1 : 0;
        s0[base + i] = logicLevel(vIn, vIH, vIL, prev);
      }
    }
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

export const BehavioralSplitterDriverDefinition: ComponentDefinition = {
  name: "BehavioralSplitterDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildSplitterDriverPinLayout,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "inputCount",  default: 1   },
        { key: "outputCount", default: 1   },
        { key: "vIH",         default: 2.0 },
        { key: "vIL",         default: 0.8 },
      ],
      params: { inputCount: 1, outputCount: 1, vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralSplitterDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
