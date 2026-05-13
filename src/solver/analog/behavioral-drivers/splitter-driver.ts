/**
 * BehavioralSplitterDriverElement — multi-port driver leaf for the
 * combinational splitter / bus-splitter.
 *
 * The splitter is itself a bus-boundary adapter:
 *   - Split mode    (1 in, M out): in_0 carries a packed-integer bus voltage
 *                   (digital-engine wide-bus convention); extract bit i and
 *                   stamp each ctrl_i at the normalized {0, 1} bit value.
 *   - Merge mode    (N in, 1 out): each in_i is a normalized {0, 1} V bit;
 *                   classify, OR into packed, stamp ctrl_0 at any-bit-set.
 *                   (Existing semantic; not wide-bus encoded.)
 *   - Passthrough   (N in, N out): classify each in_i → stamp matching ctrl_i.
 *
 * Pin order MUST match buildSplitterNetlist drvNets:
 *   [in_0..in_{N-1}, gnd, ctrl_0..ctrl_{M-1}]
 *
 * Per Composite M13 (contracts_group_10.md), J-158.
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../state-schema.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../ngspice-load-order.js";
import { PoolBackedAnalogElement } from "../element.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import { allocNortonStamp, stampNortonValue } from "../stamp-helpers.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";

const SCHEMA: StateSchema = defineStateSchema("BehavioralSplitterDriver", []);

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
  decls.push({
    direction: PinDirection.INPUT,
    label: "gnd",
    defaultBitWidth: 1,
    position: { x: 0, y: inputCount },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  });
  for (let i = 0; i < outputCount; i++) {
    decls.push({
      direction: PinDirection.OUTPUT,
      label: `ctrl_${i}`,
      defaultBitWidth: 1,
      position: { x: 0, y: inputCount + 1 + i },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    });
  }
  return decls;
}

export class BehavioralSplitterDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _inputCount: number;
  private readonly _outputCount: number;
  private readonly _inNodes: number[];
  private readonly _gndNode: number;
  private _ctrlNodes: number[];
  private _handlesByBit: readonly (readonly [number, number, number, number])[];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._inputCount = props.getModelParam<number>("inputCount");
    this._outputCount = props.getModelParam<number>("outputCount");

    this._inNodes = [];
    for (let i = 0; i < this._inputCount; i++) {
      this._inNodes.push(pinNodes.get(`in_${i}`)!);
    }
    this._gndNode = pinNodes.get("gnd")!;
    this._ctrlNodes = new Array(this._outputCount).fill(-1);
    this._handlesByBit = [];
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    const handles: (readonly [number, number, number, number])[] = [];
    for (let i = 0; i < this._outputCount; i++) {
      this._ctrlNodes[i] = this.pinNodes.get(`ctrl_${i}`)!;
      handles.push(allocNortonStamp(ctx.solver, this._ctrlNodes[i], this._gndNode));
    }
    this._handlesByBit = handles;
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const gnd = rhsOld[this._gndNode];

    if (this._inputCount === 1 && this._outputCount >= 1) {
      // Split mode: unpack bit i from the wide-bus voltage at in_0.
      const packed = (rhsOld[this._inNodes[0]] - gnd) >>> 0;
      for (let i = 0; i < this._outputCount; i++) {
        const bit = (packed >>> i) & 1;
        stampNortonValue(ctx, this._handlesByBit[i]!, this._ctrlNodes[i]!, this._gndNode, 1, bit);
      }
    } else if (this._outputCount === 1 && this._inputCount >= 1) {
      // Merge mode: classify each normalized bit input, stamp "any bit set"
      // on ctrl_0. Preserves the pre-normalization stamp pattern
      // (`packed ? vOH : vOL`) at the new {0, 1} levels.
      let anyHigh = 0;
      for (let i = 0; i < this._inputCount; i++) {
        if (rhsOld[this._inNodes[i]] - gnd >= 0.5) {
          anyHigh = 1;
          break;
        }
      }
      stampNortonValue(ctx, this._handlesByBit[0]!, this._ctrlNodes[0]!, this._gndNode, 1, anyHigh);
    } else {
      // Passthrough mode: classify in_i → ctrl_i directly.
      const n = Math.min(this._inputCount, this._outputCount);
      for (let i = 0; i < n; i++) {
        const bit = rhsOld[this._inNodes[i]] - gnd >= 0.5 ? 1 : 0;
        stampNortonValue(ctx, this._handlesByBit[i]!, this._ctrlNodes[i]!, this._gndNode, 1, bit);
      }
    }
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(_key: string, _value: number): void {
    // No hot-loadable params; inputCount and outputCount are structural.
  }

  getParam(_key: string): number | undefined {
    return undefined;
  }
}

export const BehavioralSplitterDriverDefinition: ComponentDefinition = {
  name: "BehavioralSplitterDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildSplitterDriverPinLayout,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "inputCount",  default: 1 },
        { key: "outputCount", default: 1 },
      ],
      params: { inputCount: 1, outputCount: 1 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralSplitterDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
