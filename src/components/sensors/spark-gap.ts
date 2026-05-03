/**
 * Spark Gap - voltage-triggered variable resistance with hysteresis.
 *
 * Behaviour:
 *   - Blocking state: R = rOff (1GOhm+) until |V| > vBreakdown
 *   - Conducting state: R = rOn (1-10Ohm) until |I| < iHold
 *   - Hysteresis: once fired, stays conducting until holding current drops
 *
 * Smooth resistance transition:
 *   To avoid step discontinuities that prevent NR convergence, the resistance
 *   blends continuously via a tanh soft transition:
 *
 *   Firing transition (blocking -> conducting):
 *     R_fire(V) = rOff + (rOn - rOff) * 0.5 * (1 + tanh((|V| - vBreakdown) / w_v))
 *     where w_v = 0.05 * vBreakdown
 *
 *   Extinction transition (conducting -> blocking):
 *     R_ext(I) = rOn + (rOff - rOn) * 0.5 * (1 + tanh((iHold - |I|) / w_i))
 *     where w_i = 0.05 * iHold
 *
 *   The effective resistance is the blend appropriate to the current state.
 *   State variable CONDUCTING switches based on thresholds to avoid chattering.
 *
 * MNA topology:
 *   _pinNodes["pos"] = n_pos
 *   _pinNodes["neg"] = n_neg
 *   branchIndex    = -1
 *
 * Unified load() pipeline:
 *   load(ctx)        stamps linearized conductance at the current operating point
 *                     every NR iteration; resistance is computed from the hysteretic
 *                     CONDUCTING state read from s1; bottom-of-load updates s0.
 */

import type { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { StatePoolRef } from "../../solver/analog/state-pool.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { defineModelParams } from "../../core/model-params.js";
import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-12;

// ---------------------------------------------------------------------------
// State-pool schema
// ---------------------------------------------------------------------------

export const SPARK_GAP_SCHEMA = defineStateSchema("SparkGapElement", [
  { name: "CONDUCTING", doc: "Conducting state: 1 = conducting, 0 = blocking", init: { kind: "zero" } },
]) satisfies StateSchema;

const SLOT_CONDUCTING = 0;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: SPARK_GAP_PARAM_DEFS, defaults: SPARK_GAP_DEFAULTS } = defineModelParams({
  primary: {
    vBreakdown: { default: 1000, unit: "V",   description: "Voltage at which the spark gap fires" },
    rOn:        { default: 5,    unit: "Ohm", description: "Resistance when gap is conducting" },
  },
  secondary: {
    rOff:  { default: 1e10, unit: "Ohm", description: "Resistance when gap is blocking" },
    iHold: { default: 0.01, unit: "A",   description: "Minimum current to sustain conduction" },
  },
});

// ---------------------------------------------------------------------------
// Smooth resistance helpers
// ---------------------------------------------------------------------------

/**
 * Smooth firing transition: blocks at low V, conducts at high V.
 * Blends from rOff -> rOn as |V| crosses vBreakdown.
 */
function firingResistance(absV: number, vBreakdown: number, rOff: number, rOn: number): number {
  const w = 0.05 * Math.max(vBreakdown, 1e-6);
  const blend = 0.5 * (1 + Math.tanh((absV - vBreakdown) / w));
  return rOff + (rOn - rOff) * blend;
}

/**
 * Smooth extinction transition: conducts at high I, blocks at low I.
 * Blends from rOn -> rOff as |I| drops below iHold.
 */
function extinctionResistance(absI: number, iHold: number, rOn: number, rOff: number): number {
  const w = 0.05 * Math.max(iHold, 1e-12);
  const blend = 0.5 * (1 + Math.tanh((iHold - absI) / w));
  return rOn + (rOff - rOn) * blend;
}

/**
 * Apply hysteresis state transition and return updated conducting flag (0 or 1).
 */
function applyHysteresis(conductingOld: number, absV: number, vBreakdown: number, iHold: number, rOn: number): number {
  if (!conductingOld) {
    return absV > vBreakdown ? 1 : 0;
  }
  // In conducting state: current is V / rOn
  const absI = absV / Math.max(rOn, MIN_RESISTANCE);
  return absI < iHold ? 0 : 1;
}

// ---------------------------------------------------------------------------
// SparkGapElement - MNA implementation
// ---------------------------------------------------------------------------

export class SparkGapElement implements PoolBackedAnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;
  readonly poolBacked = true as const;
  readonly stateSchema = SPARK_GAP_SCHEMA;
  readonly stateSize = SPARK_GAP_SCHEMA.size;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();

  private _hPP: number = -1; // (posNode, posNode) - swsetup.c:59
  private _hPN: number = -1; // (posNode, negNode) - swsetup.c:60
  private _hNP: number = -1; // (negNode, posNode) - swsetup.c:61
  private _hNN: number = -1; // (negNode, negNode) - swsetup.c:62

  private _vBreakdown: number;
  private _rOn: number;
  private _rOff: number;
  private _iHold: number;

  private _pool!: StatePoolRef;

  /**
   * @param vBreakdown  - Breakdown voltage in volts
   * @param rOn         - On-state resistance in ohms
   * @param rOff        - Off-state resistance in ohms
   * @param iHold       - Holding current in amps; below this the gap extinguishes
   */
  constructor(
    vBreakdown: number,
    rOn: number,
    rOff: number,
    iHold: number,
  ) {
    this._vBreakdown = Math.max(vBreakdown, 1e-6);
    this._rOn = Math.max(rOn, MIN_RESISTANCE);
    this._rOff = Math.max(rOff, 1);
    this._iHold = Math.max(iHold, 1e-12);
  }

  setup(ctx: SetupContext): void {
    if (this._stateBase === -1) {
      this._stateBase = ctx.allocStates(this.stateSize);
    }

    const solver = ctx.solver;
    const posNode = this._pinNodes.get("pos")!; // SWposNode
    const negNode = this._pinNodes.get("neg")!; // SWnegNode

    // TSTALLOC sequence: swsetup.c:59-62, line-for-line
    this._hPP = solver.allocElement(posNode, posNode); // :59 (SWposNode, SWposNode)
    this._hPN = solver.allocElement(posNode, negNode); // :60 (SWposNode, SWnegNode)
    this._hNP = solver.allocElement(negNode, posNode); // :61 (SWnegNode, SWposNode)
    this._hNN = solver.allocElement(negNode, negNode); // :62 (SWnegNode, SWnegNode)
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(SPARK_GAP_SCHEMA, pool, this._stateBase, {});
  }

  setParam(key: string, value: number): void {
    if (key === "vBreakdown") this._vBreakdown = Math.max(value, 1e-6);
    else if (key === "rOn") this._rOn = Math.max(value, MIN_RESISTANCE);
    else if (key === "rOff") this._rOff = Math.max(value, 1);
    else if (key === "iHold") this._iHold = Math.max(value, 1e-12);
  }

  /**
   * Compute effective resistance given the current conducting state and terminal voltage.
   */
  private resistanceFromState(conducting: number, absV: number): number {
    if (!conducting) {
      return firingResistance(absV, this._vBreakdown, this._rOff, this._rOn);
    }
    const absI = absV / Math.max(this._rOn, MIN_RESISTANCE);
    return extinctionResistance(absI, this._iHold, this._rOn, this._rOff);
  }

  load(ctx: LoadContext): void {
    const base = this._stateBase;
    const s1 = this._pool.states[1];
    const s0 = this._pool.states[0];

    const conductingOld = s1[base + SLOT_CONDUCTING];
    const nPos = this._pinNodes.get("pos")!;
    const nNeg = this._pinNodes.get("neg")!;
    // ngspice DEVload idiom - read CKTrhsOld (prior NR iterate), not CKTrhs.
    // bjtload.c:208-209, dioload.c:139-140 read rhsOld so Jacobian-linearised
    // stamps use the last committed iter's voltages, stable across NR.
    const voltages = ctx.rhsOld;
    const vTerm = voltages[nPos] - voltages[nNeg];
    const absV = Math.abs(vTerm);

    const R = this.resistanceFromState(conductingOld, absV);
    const G = 1 / Math.max(R, MIN_RESISTANCE);

    ctx.solver.stampElement(this._hPP,  G);
    ctx.solver.stampElement(this._hPN, -G);
    ctx.solver.stampElement(this._hNP, -G);
    ctx.solver.stampElement(this._hNN,  G);

    // ngspice CKTstate0 idiom - bjtload.c:744-746, dioload.c:325-326
    const conductingNew = applyHysteresis(conductingOld, absV, this._vBreakdown, this._iHold, this._rOn);
    s0[base + SLOT_CONDUCTING] = conductingNew;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const nPos = this._pinNodes.get("pos")!;
    const nNeg = this._pinNodes.get("neg")!;
    const vPos = rhs[nPos];
    const vNeg = rhs[nNeg];
    const s1 = this._pool.states[1];
    const conducting = s1[this._stateBase + SLOT_CONDUCTING];
    const absV = Math.abs(vPos - vNeg);
    const G = 1 / Math.max(this.resistanceFromState(conducting, absV), MIN_RESISTANCE);
    const I = G * (vPos - vNeg);
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

export function createSparkGapElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): SparkGapElement {
  const p: Record<string, number> = {
    vBreakdown: props.getModelParam<number>("vBreakdown"),
    rOn:        props.getModelParam<number>("rOn"),
    rOff:       props.getOrDefault<number>("rOff",       SPARK_GAP_DEFAULTS.rOff),
    iHold:      props.getOrDefault<number>("iHold",      SPARK_GAP_DEFAULTS.iHold),
  };
  const el = new SparkGapElement(p.vBreakdown, p.rOn, p.rOff, p.iHold);
  el._pinNodes = new Map(pinNodes);
  return el;
}

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

function buildSparkGapPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "pos",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "neg",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// SparkGapCircuitElement - editor/visual layer
// ---------------------------------------------------------------------------

export class SparkGapCircuitElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SparkGap", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildSparkGapPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.5,
      width: 4.0,
      height: 1.0,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vPos = signals?.getPinVoltage("pos");
    const vNeg = signals?.getPinVoltage("neg");

    ctx.save();
    ctx.setLineWidth(1);

    // Electrode arrows - body, stays COMPONENT
    ctx.setColor("COMPONENT");
    ctx.drawPolygon(
      [
        { x: 1.75, y: 0 },
        { x: 1.25, y: -0.5 },
        { x: 1.25, y: 0.5 },
      ],
      true,
    );
    ctx.drawPolygon(
      [
        { x: 2.25, y: 0 },
        { x: 2.75, y: 0.5 },
        { x: 2.75, y: -0.5 },
      ],
      true,
    );

    // pos lead
    drawColoredLead(ctx, signals, vPos, 0, 0, 1.25, 0);

    // neg lead
    drawColoredLead(ctx, signals, vNeg, 2.75, 0, 4, 0);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SPARK_GAP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "rOff",
    type: PropertyType.FLOAT,
    label: "Off Resistance (Ohm)",
    defaultValue: 1e10,
    min: 1,
    description: "Resistance when gap is blocking",
  },
  {
    key: "iHold",
    type: PropertyType.FLOAT,
    label: "Holding Current (A)",
    defaultValue: 0.01,
    min: 1e-12,
    description: "Minimum current to sustain conduction; gap extinguishes below this",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional component label",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const SPARK_GAP_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "vBreakdown", propertyKey: "vBreakdown", modelParam: true, convert: (v) => parseFloat(v) },
  { xmlName: "rOn", propertyKey: "rOn", modelParam: true, convert: (v) => parseFloat(v) },
  { xmlName: "rOff", propertyKey: "rOff", convert: (v) => parseFloat(v) },
  { xmlName: "iHold", propertyKey: "iHold", convert: (v) => parseFloat(v) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// SparkGapDefinition
// ---------------------------------------------------------------------------

function sparkGapCircuitFactory(props: PropertyBag): SparkGapCircuitElement {
  return new SparkGapCircuitElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const SparkGapDefinition: StandaloneComponentDefinition = {
  name: "SparkGap",
  typeId: -1,
  factory: sparkGapCircuitFactory,
  pinLayout: buildSparkGapPinDeclarations(),
  propertyDefs: SPARK_GAP_PROPERTY_DEFS,
  attributeMap: SPARK_GAP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Spark Gap - voltage-triggered switch with hysteresis. " +
    "Fires at breakdown voltage; stays on until current drops below holding threshold.",
  modelRegistry: {
    behavioral: {
      kind: "inline",
      factory: createSparkGapElement,
      paramDefs: SPARK_GAP_PARAM_DEFS,
      params: SPARK_GAP_DEFAULTS,
    },
  },
  models: {},
  defaultModel: "behavioral",
};
