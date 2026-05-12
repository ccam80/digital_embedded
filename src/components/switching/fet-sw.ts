/**
 * FetSW — FET-based analog switch driven by a sibling logic-level driver.
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import { PoolBackedAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";
import { PropertyBag } from "../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// State schema- the SW leaf carries no per-step internal state of its own.
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("FetSW", []);

// ---------------------------------------------------------------------------
// Param defs
// ---------------------------------------------------------------------------

const FET_SW_PARAM_DEFS: ParamDef[] = [
  { key: "Ron",        default: 1 },
  { key: "Roff",       default: 1e9 },
  { key: "invertCtrl", default: 0 },
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
  readonly deviceFamily: DeviceFamily = "SW";
  readonly stateSchema = SCHEMA;
  readonly stateSize = 0;

  private _ron: number;
  private _roff: number;
  private _invertCtrl: boolean;

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

  load(_ctx: LoadContext): void {
    // Phase 3 supplies the new body (control-node read).
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0];
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
