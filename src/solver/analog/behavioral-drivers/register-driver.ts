/**
 * BehavioralRegisterDriverElement — bus-wide edge-triggered register driver
 * leaf. See and-driver.ts for the normalized-bit driver-chain architecture.
 *
 * Control inputs (C, en) are normalized {0, 1} V; D is a wide-bus pin
 * carrying a packed N-bit integer voltage (digital-engine bus convention,
 * unchanged by the normalization pass). Output bits stamp at {0, 1} V.
 *
 * Per Composite M12 (phase-composite-architecture.md), J-154
 * (contracts_group_10.md).
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
import { detectRisingEdge } from "./edge-detect.js";
import { allocNortonStamp, stampNortonValue } from "../stamp-helpers.js";

const REGISTER_SCHEMAS = new Map<number, StateSchema>();

function getRegisterSchema(bitWidth: number): StateSchema {
  let cached = REGISTER_SCHEMAS.get(bitWidth);
  if (cached !== undefined) return cached;

  const slots: SlotDescriptor[] = [
    {
      name: "LAST_CLOCK",
      doc: "Clock voltage at last accepted timestep — compared against current rhsOld[C] for rising-edge detection. NaN sentinel on the first sample skips edge detection so a circuit starting with the clock high does not produce a spurious edge.",
    },
    {
      name: "STORED_VALUE",
      doc: "Packed N-bit integer latch. Updated on rising clock edge when en is high by sampling the D bus.",
    },
  ];

  const schema = defineStateSchema(`BehavioralRegisterDriver_${bitWidth}b`, slots);
  REGISTER_SCHEMAS.set(bitWidth, schema);
  return schema;
}

export function buildRegisterDriverPinLayout(props: PropertyBag): PinDeclaration[] {
  const N = props.getModelParam<number>("bitWidth");
  const decls: PinDeclaration[] = [
    { direction: PinDirection.INPUT,  label: "D",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "C",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
    { direction: PinDirection.INPUT,  label: "en",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
  for (let i = 0; i < N; i++) {
    decls.push({
      direction: PinDirection.OUTPUT, label: `ctrl_bit_${i}`,
      defaultBitWidth: 1, position: { x: 0, y: 0 },
      isNegatable: false, isClockCapable: false, kind: "signal",
    });
  }
  return decls;
}

export class BehavioralRegisterDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  private readonly _bitWidth: number;
  private readonly _mask: number;
  private readonly _slotLastClock: number;
  private readonly _slotStoredValue: number;
  private readonly _dNode: number;
  private readonly _cNode: number;
  private readonly _enNode: number;
  private readonly _gndNode: number;

  private _firstSample: boolean = true;

  private _handlesByBit: readonly (readonly [number, number, number, number])[] = [];
  private _ctrlBitNodes: number[] = [];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._bitWidth = props.getModelParam<number>("bitWidth");
    this._mask = this._bitWidth >= 32 ? 0xFFFFFFFF : ((1 << this._bitWidth) - 1);

    this.stateSchema = getRegisterSchema(this._bitWidth);
    this.stateSize = this.stateSchema.size;
    this._slotLastClock  = this.stateSchema.indexOf.get("LAST_CLOCK")!;
    this._slotStoredValue = this.stateSchema.indexOf.get("STORED_VALUE")!;

    this._dNode   = pinNodes.get("D")!;
    this._cNode   = pinNodes.get("C")!;
    this._enNode  = pinNodes.get("en")!;
    this._gndNode = pinNodes.get("gnd")!;
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);

    this._ctrlBitNodes = [];
    const handles: (readonly [number, number, number, number])[] = [];
    for (let i = 0; i < this._bitWidth; i++) {
      const node = this.pinNodes.get(`ctrl_bit_${i}`)!;
      this._ctrlBitNodes.push(node);
      handles.push(allocNortonStamp(ctx.solver, node, this._gndNode));
    }
    this._handlesByBit = handles;
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const gnd    = rhsOld[this._gndNode];
    const vClock = rhsOld[this._cNode]  - gnd;
    const vD     = rhsOld[this._dNode]  - gnd;
    const vEn    = rhsOld[this._enNode] - gnd;

    const prevClock = s1[base + this._slotLastClock];
    let stored = s1[base + this._slotStoredValue];
    const en = vEn >= 0.5 ? 1 : 0;

    if (!this._firstSample && detectRisingEdge(prevClock, vClock, 0.5)) {
      if (en) {
        const sampledD = (vD >>> 0) >>> 0;
        stored = (sampledD & this._mask) >>> 0;
      }
    }
    this._firstSample = false;

    s0[base + this._slotLastClock]   = vClock;
    s0[base + this._slotStoredValue] = stored;

    for (let i = 0; i < this._bitWidth; i++) {
      const bit = (stored >>> i) & 1;
      stampNortonValue(ctx, this._handlesByBit[i], this._ctrlBitNodes[i], this._gndNode, 1, bit);
    }
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(_key: string, _value: number): void {
    // No hot-loadable params; bitWidth is structural.
  }
}

export const BehavioralRegisterDriverDefinition: ComponentDefinition = {
  name: "BehavioralRegisterDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildRegisterDriverPinLayout,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "bitWidth", default: 8 },
      ],
      params: { bitWidth: 8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralRegisterDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
