/**
 * BehavioralNandDriverElement — pure-truth-function driver leaf for the N-input
 * NAND gate. See and-driver.ts for the normalized-bit driver-chain architecture.
 *
 * Per Composite M10 (phase-composite-architecture.md), J-150
 * (contracts_group_10.md).
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
import { allocNortonStamp, stampNortonValue } from "../stamp-helpers.js";

const SCHEMA: StateSchema = defineStateSchema("BehavioralNandDriver", []);

function buildNandDriverPinLayout(props: PropertyBag): PinDeclaration[] {
  const N = props.getModelParam<number>("inputCount");
  const decls: PinDeclaration[] = [];
  for (let i = 0; i < N; i++) {
    decls.push({
      direction: PinDirection.INPUT, label: `In_${i + 1}`,
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

export class BehavioralNandDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _inputCount: number;
  private readonly _inputNodes: number[];
  private readonly _gndNode: number;
  private readonly _ctrlOutNode: number;
  private _handles: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._inputCount = props.getModelParam<number>("inputCount");
    this._inputNodes = new Array(this._inputCount);
    for (let i = 0; i < this._inputCount; i++) {
      this._inputNodes[i] = pinNodes.get(`In_${i + 1}`)!;
    }
    this._gndNode = pinNodes.get("gnd")!;
    this._ctrlOutNode = pinNodes.get("ctrl_out")!;
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    this._handles = allocNortonStamp(ctx.solver, this._ctrlOutNode, this._gndNode);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const gndV = rhsOld[this._gndNode];

    let andResult = 1;
    for (let i = 0; i < this._inputCount; i++) {
      const v = rhsOld[this._inputNodes[i]] - gndV;
      if (v < 0.5) {
        andResult = 0;
        break;
      }
    }

    const result = andResult ? 0 : 1;
    stampNortonValue(ctx, this._handles, this._ctrlOutNode, this._gndNode, 1, result);
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(_key: string, _value: number): void {
    // No hot-loadable params; inputCount is structural.
  }
}

export const BehavioralNandDriverDefinition: ComponentDefinition = {
  name: "BehavioralNandDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildNandDriverPinLayout,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "inputCount", default: 2 },
      ],
      params: { inputCount: 2 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralNandDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
