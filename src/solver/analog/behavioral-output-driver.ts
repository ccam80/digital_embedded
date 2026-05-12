/**
 * BehavioralOutputDriver — Norton-equivalent behaviourally-driven source.
 * Stamps a controlled Norton (current source in parallel with 1/rOut shunt) at
 * (pos, neg). Phase 3 wires the control inputs (‘ctrl’, optional ‘en’) and the
 * bit-extraction logic.
 */

import {
  defineStateSchema,
  type StateSchema,
} from "./state-schema.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "./ngspice-load-order.js";
import { PoolBackedAnalogElement, type AnalogElement } from "./element.js";
import type { SetupContext } from "./setup-context.js";
import type { LoadContext } from "./load-context.js";
import { allocNortonStamp } from "./stamp-helpers.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralOutputDriver", [
  {
    name: "DRIVE_V",
    doc: "Driven Norton-source target voltage this step (vOH or vOL post bit-extraction; 0 when disabled). Bottom-of-load write; diagnostic readout only.",
  },
]);

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const BEHAVIORAL_OUTPUT_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.OUTPUT, label: "pos", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "neg", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// Param defs
// ---------------------------------------------------------------------------

const BEHAVIORAL_OUTPUT_DRIVER_PARAM_DEFS: ParamDef[] = [
  { key: "vOH",      default: 5 },
  { key: "vOL",      default: 0 },
  { key: "rOut",     default: 100 },
];

const BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS: Record<string, number> = {
  vOH: 5,
  vOL: 0,
  rOut: 100,
};

// ---------------------------------------------------------------------------
// BehavioralOutputDriverElement
// ---------------------------------------------------------------------------

export class BehavioralOutputDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _vOH: number;
  private _vOL: number;
  private _rOut: number;

  // Norton conductance stamp handles- 4-tuple [hPP, hNN, hPN, hNP] at (pos, neg).
  private _handles: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._vOH  = props.hasModelParam("vOH")  ? props.getModelParam<number>("vOH")  : BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS["vOH"]!;
    this._vOL  = props.hasModelParam("vOL")  ? props.getModelParam<number>("vOL")  : BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS["vOL"]!;
    this._rOut = props.hasModelParam("rOut") ? props.getModelParam<number>("rOut") : BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS["rOut"]!;
  }

  setup(ctx: SetupContext): void {
    const posNode = this.pinNodes.get("pos")!;
    const negNode = this.pinNodes.get("neg")!;

    this._stateBase = ctx.allocStates(this.stateSize);

    // Norton stamp- 4 conductance entries (no branch row needed).
    this._handles = allocNortonStamp(ctx.solver, posNode, negNode);
  }

  setParam(key: string, value: number): void {
    if (key === "rOut") {
      this._rOut = value;
    } else if (key === "vOH") {
      this._vOH = value;
    } else if (key === "vOL") {
      this._vOL = value;
    }
  }

  load(_ctx: LoadContext): void {
    // Phase 3 supplies the new body (control-node read + Norton stamp).
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0];
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
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
      params: BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS,
      branchCount: 0,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new BehavioralOutputDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
