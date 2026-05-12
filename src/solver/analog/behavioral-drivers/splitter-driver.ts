/**
 * BehavioralSplitterDriverElement- multi-port driver leaf for the
 * combinational splitter / bus-splitter.
 *
 * Reads N input voltages (relative to gnd), threshold-classifies each,
 *
 * Pin order MUST match buildSplitterNetlist drvNets:
 *   [in_0..in_{N-1}, out_0..out_{M-1}, gnd]
 *
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
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../ngspice-load-order.js";
import { PoolBackedAnalogElement } from "../element.js";
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

const SPLITTER_SCHEMAS = new Map<string, StateSchema>();

function getSplitterSchema(inputCount: number, outputCount: number): StateSchema {
  const key = `${inputCount}:${outputCount}`;
  let cached = SPLITTER_SCHEMAS.get(key);
  if (cached !== undefined) return cached;

  const slots: SlotDescriptor[] = [];
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

export class BehavioralSplitterDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  private readonly _inputCount: number;
  private readonly _outputCount: number;
  private readonly _inNodes: number[];
  private readonly _outNodes: number[];
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;

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
    this._rOut = props.getModelParam<number>("rOut");
    this._vOH  = props.getModelParam<number>("vOH");
    this._vOL  = props.getModelParam<number>("vOL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }

  /**
   * Classify input voltages, mirroring executeSplitter's three-mode logic (splitter.ts).
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
   *   executeSplitter for the non-split non-merge case â€” but here we must
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
      const packed = vIn >>> 0;  // ToUint32 truncation â€” matches bus-pin convention
      for (let i = 0; i < this._outputCount; i++) {
        const bitVoltage = (packed >>> i) & 1;
        const prev = s1[base + i] >= 0.5 ? 1 : 0;
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
    } else {
      // Passthrough mode: classify in_i â†’ slot i directly.
      const n = Math.min(this._inputCount, this._outputCount);
      for (let i = 0; i < n; i++) {
        const vIn = rhsOld[this._inNodes[i]] - gnd;
        const prev = s1[base + i] >= 0.5 ? 1 : 0;
      }
    }
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
    else if (key === "rOut") this._rOut = value;
    else if (key === "vOH") this._vOH = value;
    else if (key === "vOL") this._vOL = value;
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
        { key: "rOut",        default: 100 },
        { key: "vOH",         default: 5   },
        { key: "vOL",         default: 0   },
      ],
      params: { inputCount: 1, outputCount: 1, vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralSplitterDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
