/**
 * BehavioralMuxDriverElement — selector-indexed pick driver leaf for the
 * N-input MUX (where N = 2^selectorBits). See and-driver.ts for the
 * normalized-bit driver-chain architecture.
 *
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
import { allocNortonStamp, stampNortonValue } from "../stamp-helpers.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";

const SCHEMA: StateSchema = defineStateSchema("BehavioralMuxDriver", []);

function buildMuxDriverPinLayout(props: PropertyBag): PinDeclaration[] {
  const K = props.getModelParam<number>("selectorBits");
  const N = 1 << K;
  const decls: PinDeclaration[] = [];

  for (let i = 0; i < N; i++) {
    decls.push({
      direction: PinDirection.INPUT, label: `data_${i}`,
      defaultBitWidth: 1, position: { x: 0, y: 0 },
      isNegatable: false, isClockCapable: false, kind: "signal",
    });
  }
  for (let i = 0; i < K; i++) {
    decls.push({
      direction: PinDirection.INPUT, label: `sel_${i}`,
      defaultBitWidth: 1, position: { x: 0, y: 0 },
      isNegatable: false, isClockCapable: false, kind: "signal",
    });
  }
  decls.push({
    direction: PinDirection.OUTPUT, label: "ctrl_out",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  });
  decls.push({
    direction: PinDirection.INPUT, label: "gnd",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  });
  return decls;
}

export class BehavioralMuxDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _selectorBits: number;
  private readonly _dataCount: number;
  private readonly _selNodes: number[];
  private readonly _dataNodes: number[];
  private readonly _gndNode: number;
  private _ctrlOutNode: number;
  private _handles: readonly [number, number, number, number];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._selectorBits = props.getModelParam<number>("selectorBits");
    this._dataCount = 1 << this._selectorBits;

    this._selNodes = new Array(this._selectorBits);
    for (let i = 0; i < this._selectorBits; i++) {
      this._selNodes[i] = pinNodes.get(`sel_${i}`)!;
    }
    this._dataNodes = new Array(this._dataCount);
    for (let i = 0; i < this._dataCount; i++) {
      this._dataNodes[i] = pinNodes.get(`data_${i}`)!;
    }
    this._gndNode = pinNodes.get("gnd")!;
    this._ctrlOutNode = pinNodes.get("ctrl_out")!;
    this._handles = [-1, -1, -1, -1];
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    this._ctrlOutNode = this.pinNodes.get("ctrl_out")!;
    this._handles = allocNortonStamp(ctx.solver, this._ctrlOutNode, this._gndNode);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const gnd = rhsOld[this._gndNode];
    const sel: number[] = [];
    for (let i = 0; i < this._selectorBits; i++) {
      sel.push(rhsOld[this._selNodes[i]] - gnd);
    }
    let result = 0;
    for (let i = 0; i < this._dataCount; i++) {
      let weight = 1;
      for (let b = 0; b < this._selectorBits; b++) {
        const sb = sel[b]!;
        weight *= ((i >>> b) & 1) === 1 ? sb : (1 - sb);
      }
      result += weight * (rhsOld[this._dataNodes[i]] - gnd);
    }
    stampNortonValue(ctx, this._handles, this._ctrlOutNode, this._gndNode, 1, result);
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(_key: string, _value: number): void {
    // No hot-loadable params; selectorBits is structural.
  }
}

export const BehavioralMuxDriverDefinition: ComponentDefinition = {
  name: "BehavioralMuxDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildMuxDriverPinLayout,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "selectorBits", default: 1 },
      ],
      params: { selectorBits: 1 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralMuxDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
