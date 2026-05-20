/**
 * BehavioralCounterPresetDriverElement — edge-triggered up/down counter with
 * parallel-load preset, enable, clear, and direction inputs. See and-driver.ts
 * for the normalized-bit driver-chain architecture.
 *
 * Control inputs (en, C, dir, ld, clr) are normalized {0, 1} V; "in" is a
 * wide-bus pin carrying a packed N-bit integer (digital-engine bus convention,
 * unchanged by the normalization pass). Output bits and ovf stamp at {0, 1} V.
 *
 * Per Composite M12 (J-140, contracts_group_10.md).
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
import { allocNortonStamp, stampNortonValue } from "../stamp-helpers.js";

const COUNTER_PRESET_SCHEMAS = new Map<number, StateSchema>();

function getCounterPresetSchema(bitWidth: number): StateSchema {
  let cached = COUNTER_PRESET_SCHEMAS.get(bitWidth);
  if (cached !== undefined) return cached;

  const slots: SlotDescriptor[] = [
    {
      name: "LAST_CLOCK",
      doc: "Clock voltage at last accepted timestep. NaN sentinel on first sample prevents spurious edges when clock boots high.",
    },
  ];
  for (let i = 0; i < bitWidth; i++) {
    slots.push({
      name: `COUNT_BIT${i}`,
      doc: `Internal counter latch bit ${i} (LSB=0). Read-modify-written each load().`,
    });
  }

  const schema = defineStateSchema(`BehavioralCounterPresetDriver_${bitWidth}b`, slots);
  COUNTER_PRESET_SCHEMAS.set(bitWidth, schema);
  return schema;
}

export function buildCounterPresetDriverPinLayout(props: PropertyBag): PinDeclaration[] {
  const N = props.getModelParam<number>("bitWidth");
  const decls: PinDeclaration[] = [
    { direction: PinDirection.INPUT,  label: "en",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "C",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
    { direction: PinDirection.INPUT,  label: "dir", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "in",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "ld",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "clr", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
  for (let i = 0; i < N; i++) {
    decls.push({
      direction: PinDirection.OUTPUT, label: `ctrl_bit_${i}`,
      defaultBitWidth: 1, position: { x: 0, y: 0 },
      isNegatable: false, isClockCapable: false, kind: "signal",
    });
  }
  decls.push({
    direction: PinDirection.OUTPUT, label: "ctrl_ovf",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  });
  return decls;
}

export class BehavioralCounterPresetDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  private readonly _bitWidth: number;
  private readonly _slotLastClock: number;
  private readonly _slotCountBase: number;
  private readonly _enNode: number;
  private readonly _cNode: number;
  private readonly _dirNode: number;
  private readonly _inNode: number;
  private readonly _ldNode: number;
  private readonly _clrNode: number;
  private readonly _gndNode: number;

  private _firstSample: boolean = true;

  private _handlesByBit: readonly (readonly [number, number, number, number])[] = [];
  private _handlesOvf: readonly [number, number, number, number] = [-1, -1, -1, -1];
  private _ctrlBitNodes: number[] = [];
  private _ctrlOvfNode: number = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._bitWidth = props.getModelParam<number>("bitWidth");

    this.stateSchema = getCounterPresetSchema(this._bitWidth);
    this.stateSize = this.stateSchema.size;
    this._slotLastClock  = this.stateSchema.indexOf.get("LAST_CLOCK")!;
    this._slotCountBase  = this.stateSchema.indexOf.get("COUNT_BIT0")!;

    this._enNode  = pinNodes.get("en")!;
    this._cNode   = pinNodes.get("C")!;
    this._dirNode = pinNodes.get("dir")!;
    this._inNode  = pinNodes.get("in")!;
    this._ldNode  = pinNodes.get("ld")!;
    this._clrNode = pinNodes.get("clr")!;
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

    this._ctrlOvfNode = this.pinNodes.get("ctrl_ovf")!;
    this._handlesOvf = allocNortonStamp(ctx.solver, this._ctrlOvfNode, this._gndNode);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;
    const gnd    = rhsOld[this._gndNode];
    const vClock = rhsOld[this._cNode]   - gnd;
    const vEn    = rhsOld[this._enNode]  - gnd;
    const vDir   = rhsOld[this._dirNode] - gnd;
    const vLd    = rhsOld[this._ldNode]  - gnd;
    const vClr   = rhsOld[this._clrNode] - gnd;

    const prevClock  = s1[base + this._slotLastClock];
    const risingEdge = this._firstSample ? 0 : vClock * (1 - prevClock);
    this._firstSample = false;
    const enEff  = vEn * (1 - vClr);
    const ld     = vLd * risingEdge;
    const dirUp  = 1 - vDir;
    const dirDn  = vDir;
    const inPacked = (rhsOld[this._inNode] - gnd) >>> 0;
    let carryUp = enEff;
    let carryDn = enEff;
    for (let i = 0; i < this._bitWidth; i++) {
      const state_i = s1[base + this._slotCountBase + i];
      const loadBit = ((inPacked >>> i) & 1) >>> 0;
      const t_i     = dirUp * carryUp + dirDn * carryDn;
      const tEff    = t_i * risingEdge * (1 - ld);
      const clocked = state_i * (1 - tEff) + (1 - state_i) * tEff;
      const loaded  = state_i * (1 - ld)   + loadBit  * ld;
      const next_i  = (1 - vClr) * ((1 - ld) * clocked + ld * loaded);
      s0[base + this._slotCountBase + i] = next_i;
      stampNortonValue(ctx, this._handlesByBit[i], this._ctrlBitNodes[i], this._gndNode, 1, next_i);
      carryUp = carryUp * state_i;        // up-overflow: all lower bits were 1
      carryDn = carryDn * (1 - state_i);  // down-underflow: all lower bits were 0
    }
    const ovf = (dirUp * carryUp + dirDn * carryDn) * (1 - vClr) * (1 - ld);
    stampNortonValue(ctx, this._handlesOvf, this._ctrlOvfNode, this._gndNode, 1, ovf);
    s0[base + this._slotLastClock] = vClock;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(_key: string, _value: number): void {
    // No hot-loadable params; bitWidth is structural.
  }
}

export const BehavioralCounterPresetDriverDefinition: ComponentDefinition = {
  name: "BehavioralCounterPresetDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildCounterPresetDriverPinLayout,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "bitWidth", default: 4 },
      ],
      params: { bitWidth: 4 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralCounterPresetDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
