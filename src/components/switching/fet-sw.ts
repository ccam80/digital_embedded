/**
 * FetSW- analog SW leaf for the NFET / PFET / TransGate composites.
 *
 * Reads its sibling driver's `OUTPUT_LOGIC_LEVEL` slot via siblingState,
 * translates the logic level to gOn / gOff conductance, and stamps the
 * 2x2 conductance matrix at (D, S). Mirrors ngspice's SW device:
 *   ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62 (TSTALLOC)
 *   ref/ngspice/src/spicelib/devices/sw/swload.c       (stamp)
 *
 * Pin keys: "D" -> SWposNode (drain), "S" -> SWnegNode (source).
 *
 * Param `invertCtrl` (0|1, encoded as a number per SubcircuitElementParam
 * contract): when 1, the on-condition is `logic <= 0.5` instead of
 * `logic > 0.5`. Used by the PFET path of the TransGate composite where
 * the gate-control logic is active-low.
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import { PoolBackedAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";
import { PropertyBag, type PoolSlotRef } from "../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// State schema- the SW leaf carries no per-step internal state of its own.
// (The driver leaf owns OUTPUT_LOGIC_LEVEL; this leaf only reads it.)
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("FetSW", []);

// ---------------------------------------------------------------------------
// Param defs
// ---------------------------------------------------------------------------

const FET_SW_PARAM_DEFS: ParamDef[] = [
  { key: "Ron",        default: 1 },
  { key: "Roff",       default: 1e9 },
  { key: "invertCtrl", default: 0 },
  // `inputLogic` is a PoolSlotRef object injected by the parent composite via
  // siblingState; not declared as a numeric ParamDef.
];

const FET_SW_DEFAULTS: Record<string, number> = {
  Ron: 1,
  Roff: 1e9,
  invertCtrl: 0,
};

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const FET_SW_PIN_LAYOUT: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT, label: "D",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
  {
    direction: PinDirection.OUTPUT, label: "S",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// FetSWElement
// ---------------------------------------------------------------------------

export class FetSWElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.SW;
  readonly stateSchema = SCHEMA;
  readonly stateSize = 0;

  private _ron: number;
  private _roff: number;
  private _invertCtrl: boolean;
  private readonly _inputLogicRef: PoolSlotRef;

  // TSTALLOC handles- swsetup.c:59-62
  private _hPP = -1;
  private _hPN = -1;
  private _hNP = -1;
  private _hNN = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._ron = Math.max(
      props.hasModelParam("Ron") ? props.getModelParam<number>("Ron") : FET_SW_DEFAULTS["Ron"]!,
      1e-12,
    );
    this._roff = Math.max(
      props.hasModelParam("Roff") ? props.getModelParam<number>("Roff") : FET_SW_DEFAULTS["Roff"]!,
      1e-12,
    );
    this._invertCtrl =
      (props.hasModelParam("invertCtrl") ? props.getModelParam<number>("invertCtrl") : FET_SW_DEFAULTS["invertCtrl"]!) !== 0;
    this._inputLogicRef = props.get<PoolSlotRef>("inputLogic");
  }

  setup(ctx: SetupContext): void {
    const drainNode = this.pinNodes.get("D")!;
    const sourceNode = this.pinNodes.get("S")!;

    // Port of swsetup.c:59-62- TSTALLOC sequence (line-for-line)
    this._hPP = ctx.solver.allocElement(drainNode, drainNode);
    this._hPN = ctx.solver.allocElement(drainNode, sourceNode);
    this._hNP = ctx.solver.allocElement(sourceNode, drainNode);
    this._hNN = ctx.solver.allocElement(sourceNode, sourceNode);
  }

  load(ctx: LoadContext): void {
    // Read the driver's classified logic level from the prior step (s1
    // per StatePool migration shape; the driver's bottom-of-load write
    // landed in s0 last NR iter, copied into s1 by the engine on accept).
    const s1 = this._pool.states[1];
    const inBase = this._inputLogicRef.element._stateBase;
    const inputLevel = s1[inBase + this._inputLogicRef.slotIdx];

    const high = inputLevel >= 0.5;
    const on = this._invertCtrl ? !high : high;

    const g = on ? 1 / this._ron : 1 / this._roff;

    // Port of swload.c:149-152- stamp through cached handles
    ctx.solver.stampElement(this._hPP, +g);
    ctx.solver.stampElement(this._hPN, -g);
    ctx.solver.stampElement(this._hNP, -g);
    ctx.solver.stampElement(this._hNN, +g);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const drainNode = this.pinNodes.get("D")!;
    const sourceNode = this.pinNodes.get("S")!;
    const s1 = this._pool.states[1];
    const inBase = this._inputLogicRef.element._stateBase;
    const inputLevel = s1[inBase + this._inputLogicRef.slotIdx];
    const high = inputLevel >= 0.5;
    const on = this._invertCtrl ? !high : high;
    const g = on ? 1 / this._ron : 1 / this._roff;
    const I = g * (rhs[drainNode] - rhs[sourceNode]);
    return [I, -I];
  }

  setParam(key: string, value: number): void {
    if (key === "Ron") this._ron = Math.max(value, 1e-12);
    else if (key === "Roff") this._roff = Math.max(value, 1e-12);
    else if (key === "invertCtrl") this._invertCtrl = value !== 0;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const FetSWDefinition: ComponentDefinition = {
  name: "FetSW",
  typeId: -1,
  internalOnly: true,
  pinLayout: FET_SW_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: FET_SW_PARAM_DEFS,
      params: FET_SW_DEFAULTS,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new FetSWElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
