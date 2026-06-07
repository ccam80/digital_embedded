/**
 * BehavioralOutputDriver — Norton-equivalent behaviourally-driven source leaves.
 *
 * Two distinct element classes share the DRIVE_V state slot and Norton-stamp
 * pattern but differ in pin layout and tri-state capability:
 *
 *   BehavioralOutputDriverElement (3-port, non-tri-state)
 *     Pins: pos OUTPUT, neg INPUT, ctrl INPUT
 *     Reads vCtrl relative to neg; threshold-selects vOH or vOL;
 *     always stamps the Norton source.
 *
 *   BehavioralOutputDriverTriStateElement (4-port, tri-state)
 *     Pins: pos OUTPUT, neg INPUT, ctrl INPUT, en INPUT
 *     When en is high: same Norton stamp as the 3-port variant.
 *     When en is low:  stamps a 1/rHiZ conductance with I=0 (high-Z).
 *     Carries a hot-loadable rHiZ param (default 1 GΩ).
 *
 * Source spec §3.3 (non-tri-state consumer leaf) and §3.5 (tri-state consumer
 * leaf) of spec/sibling-state-excision.md.
 */

import {
  defineStateSchema,
  type StateSchema,
} from "./state-schema.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "./ngspice-load-order.js";
import { PoolBackedAnalogElement, type AnalogElement } from "./element.js";
import type { SetupContext } from "./setup-context.js";
import type { LoadContext } from "./load-context.js";
import { allocNortonStamp, stampNortonValue, stampNortonAt } from "./stamp-helpers.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// State schema (shared by both classes)
// ---------------------------------------------------------------------------

export const SCHEMA: StateSchema = defineStateSchema("BehavioralOutputDriver", [
  {
    name: "DRIVE_V",
    doc: "Driven Norton-source target voltage this step (vOH or vOL after threshold selection; 0 when disabled). Bottom-of-load write; diagnostic readout only.",
  },
]);

const SLOT_DRIVE_V = SCHEMA.indexOf.get("DRIVE_V")!;

// ---------------------------------------------------------------------------
// Pin layouts
// ---------------------------------------------------------------------------

const BEHAVIORAL_OUTPUT_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.OUTPUT, label: "pos",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "neg",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "ctrl", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

const BEHAVIORAL_OUTPUT_DRIVER_TRISTATE_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.OUTPUT, label: "pos",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "neg",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "ctrl", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "en",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// Param defs
// ---------------------------------------------------------------------------

const BEHAVIORAL_OUTPUT_DRIVER_PARAM_DEFS: ParamDef[] = [
  { key: "vOH",  default: 5 },
  { key: "vOL",  default: 0 },
  { key: "rOut", default: 100 },
];

const BEHAVIORAL_OUTPUT_DRIVER_TRISTATE_PARAM_DEFS: ParamDef[] = [
  { key: "vOH",  default: 5 },
  { key: "vOL",  default: 0 },
  { key: "rOut", default: 100 },
  { key: "rHiZ", default: 1e9 },
];

// ---------------------------------------------------------------------------
// BehavioralOutputDriverElement (3-port, non-tri-state)
// ---------------------------------------------------------------------------

export class BehavioralOutputDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _vOH: number;
  private _vOL: number;
  private _rOut: number;

  private readonly _ctrlNode: number;
  private readonly _gndNode: number;

  private _handles: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._ctrlNode = pinNodes.get("ctrl")!;
    this._gndNode  = pinNodes.get("neg")!;
    // All keys are declared in BEHAVIORAL_OUTPUT_DRIVER_PARAM_DEFS — read directly.
    this._vOH  = props.getModelParam<number>("vOH");
    this._vOL  = props.getModelParam<number>("vOL");
    this._rOut = props.getModelParam<number>("rOut");
  }

  setup(ctx: SetupContext): void {
    const posNode = this.pinNodes.get("pos")!;
    const negNode = this.pinNodes.get("neg")!;
    this._stateBase = ctx.allocStates(this.stateSize);
    this._handles = allocNortonStamp(ctx.solver, posNode, negNode);
  }

  setParam(key: string, value: number): void {
    if (key === "rOut")      this._rOut = value;
    else if (key === "vOH") this._vOH = value;
    else if (key === "vOL") this._vOL = value;
  }

  load(ctx: LoadContext): void {
    const posNode   = this.pinNodes.get("pos")!;
    const negNode   = this.pinNodes.get("neg")!;
    const rhsOld    = ctx.rhsOld;
    const s0        = this._pool.states[0];
    const stateBase = this._stateBase;

    const vCtrl = rhsOld[this._ctrlNode] - rhsOld[this._gndNode];
    const mid   = (this._vOH + this._vOL) / 2;
    const target = vCtrl > mid ? this._vOH : this._vOL;

    stampNortonValue(ctx, this._handles, posNode, negNode, this._rOut, target);
    s0[stateBase + SLOT_DRIVE_V] = target;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const posNode = this.pinNodes.get("pos")!;
    const negNode = this.pinNodes.get("neg")!;
    const target  = this._pool.states[1][this._stateBase + SLOT_DRIVE_V];
    const G       = 1 / this._rOut;
    const vOut    = rhs[posNode] - rhs[negNode];
    const iOut    = G * (target - vOut);
    return [iOut, -iOut, 0];
  }
}

// ---------------------------------------------------------------------------
// BehavioralOutputDriverTriStateElement (4-port, tri-state)
// ---------------------------------------------------------------------------

export class BehavioralOutputDriverTriStateElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _vOH: number;
  private _vOL: number;
  private _rOut: number;
  private _rHiZ: number;

  private readonly _ctrlNode: number;
  private readonly _gndNode: number;
  private readonly _enNode: number;

  private _handles: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._ctrlNode = pinNodes.get("ctrl")!;
    this._gndNode  = pinNodes.get("neg")!;
    this._enNode   = pinNodes.get("en")!;
    // All keys are declared in BEHAVIORAL_OUTPUT_DRIVER_TRISTATE_PARAM_DEFS — read directly.
    this._vOH  = props.getModelParam<number>("vOH");
    this._vOL  = props.getModelParam<number>("vOL");
    this._rOut = props.getModelParam<number>("rOut");
    this._rHiZ = props.getModelParam<number>("rHiZ");
  }

  setup(ctx: SetupContext): void {
    const posNode = this.pinNodes.get("pos")!;
    const negNode = this.pinNodes.get("neg")!;
    this._stateBase = ctx.allocStates(this.stateSize);
    this._handles = allocNortonStamp(ctx.solver, posNode, negNode);
  }

  setParam(key: string, value: number): void {
    if (key === "rOut")       this._rOut = value;
    else if (key === "vOH")  this._vOH = value;
    else if (key === "vOL")  this._vOL = value;
    else if (key === "rHiZ") this._rHiZ = value;
  }

  load(ctx: LoadContext): void {
    const posNode   = this.pinNodes.get("pos")!;
    const negNode   = this.pinNodes.get("neg")!;
    const rhsOld    = ctx.rhsOld;
    const s0        = this._pool.states[0];
    const stateBase = this._stateBase;

    const vCtrl  = rhsOld[this._ctrlNode] - rhsOld[this._gndNode];
    const vEn    = rhsOld[this._enNode]   - rhsOld[this._gndNode];
    const mid    = (this._vOH + this._vOL) / 2;
    const enabled = vEn > mid;
    const target  = vCtrl > mid ? this._vOH : this._vOL;

    if (enabled) {
      stampNortonValue(ctx, this._handles, posNode, negNode, this._rOut, target);
    } else {
      stampNortonAt(ctx, this._handles, posNode, negNode, 1 / this._rHiZ, 0);
    }

    s0[stateBase + SLOT_DRIVE_V] = enabled ? target : 0;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const posNode  = this.pinNodes.get("pos")!;
    const negNode  = this.pinNodes.get("neg")!;
    const driveV   = this._pool.states[1][this._stateBase + SLOT_DRIVE_V];
    const enabled  = driveV !== 0;
    const G        = enabled ? 1 / this._rOut : 1 / this._rHiZ;
    const target   = enabled ? driveV : 0;
    const vOut     = rhs[posNode] - rhs[negNode];
    const iOut     = G * (target - vOut);
    return [iOut, -iOut, 0, 0];
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinitions
// ---------------------------------------------------------------------------

export const BehavioralOutputDriverDefinition: ComponentDefinition = {
  name: "BehavioralOutputDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: BEHAVIORAL_OUTPUT_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: BEHAVIORAL_OUTPUT_DRIVER_PARAM_DEFS,
      params: {},
      branchCount: 0,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new BehavioralOutputDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};

export const BehavioralOutputDriverTriStateDefinition: ComponentDefinition = {
  name: "BehavioralOutputDriverTriState",
  typeId: -1,
  internalOnly: true,
  pinLayout: BEHAVIORAL_OUTPUT_DRIVER_TRISTATE_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: BEHAVIORAL_OUTPUT_DRIVER_TRISTATE_PARAM_DEFS,
      params: {},
      branchCount: 0,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new BehavioralOutputDriverTriStateElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
