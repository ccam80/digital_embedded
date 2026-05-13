/**
 * BehavioralDemuxDriverElement — combinational driver leaf for the K-bit
 * demultiplexer. See and-driver.ts for the normalized-bit driver-chain
 * architecture.
 *
 * Reads K selector bits + one data input (all normalized {0, 1} V), routes
 * the data to one of N = 2^K output lines. Unselected lines stamp 0; selected
 * stamps `data`.
 *
 * Per Cluster M11 follow-up (j-070-recluster.md), J-144 (contracts_group_10.md).
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

const SCHEMA: StateSchema = defineStateSchema("BehavioralDemuxDriver", []);

function buildDemuxDriverPinLayout(props: PropertyBag): PinDeclaration[] {
  const K = props.getModelParam<number>("selectorBits");
  const N = 1 << K;
  const decls: PinDeclaration[] = [];
  for (let i = 0; i < K; i++) {
    decls.push({
      direction: PinDirection.INPUT, label: `sel_${i}`,
      defaultBitWidth: 1, position: { x: 0, y: 0 },
      isNegatable: false, isClockCapable: false, kind: "signal",
    });
  }
  decls.push({
    direction: PinDirection.INPUT, label: "in",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  });
  decls.push({
    direction: PinDirection.INPUT, label: "gnd",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  });
  for (let i = 0; i < N; i++) {
    decls.push({
      direction: PinDirection.OUTPUT, label: `ctrl_${i}`,
      defaultBitWidth: 1, position: { x: 0, y: 0 },
      isNegatable: false, isClockCapable: false, kind: "signal",
    });
  }
  return decls;
}

export class BehavioralDemuxDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _selectorBits: number;
  private readonly _outCount: number;
  private readonly _selNodes: number[];
  private readonly _inNode: number;
  private readonly _gndNode: number;
  private _ctrlNodes: number[];
  private _handlesByBit: readonly (readonly [number, number, number, number])[];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._selectorBits = props.getModelParam<number>("selectorBits");
    this._outCount = 1 << this._selectorBits;

    this._selNodes = new Array(this._selectorBits);
    for (let i = 0; i < this._selectorBits; i++) {
      this._selNodes[i] = pinNodes.get(`sel_${i}`)!;
    }
    this._inNode  = pinNodes.get("in")!;
    this._gndNode = pinNodes.get("gnd")!;
    this._ctrlNodes = new Array(this._outCount).fill(-1);
    this._handlesByBit = [];
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    const handles: (readonly [number, number, number, number])[] = [];
    for (let i = 0; i < this._outCount; i++) {
      this._ctrlNodes[i] = this.pinNodes.get(`ctrl_${i}`)!;
      handles.push(allocNortonStamp(ctx.solver, this._ctrlNodes[i], this._gndNode));
    }
    this._handlesByBit = handles;
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const gnd = rhsOld[this._gndNode];

    let sel = 0;
    for (let i = 0; i < this._selectorBits; i++) {
      if (rhsOld[this._selNodes[i]!]! - gnd >= 0.5) sel |= 1 << i;
    }
    sel >>>= 0;

    const data = rhsOld[this._inNode] - gnd >= 0.5 ? 1 : 0;

    for (let i = 0; i < this._outCount; i++) {
      const target = i === sel ? data : 0;
      stampNortonValue(ctx, this._handlesByBit[i]!, this._ctrlNodes[i]!, this._gndNode, 1, target);
    }
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(_key: string, _value: number): void {
    // No hot-loadable params; selectorBits is structural.
  }
}

export const BehavioralDemuxDriverDefinition: ComponentDefinition = {
  name: "BehavioralDemuxDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildDemuxDriverPinLayout,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "selectorBits", default: 1 },
      ],
      params: { selectorBits: 1 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralDemuxDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
