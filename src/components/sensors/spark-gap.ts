/**
 * Spark Gap — voltage-triggered variable resistance with hysteresis.
 *
 * Behaviour:
 *   - Blocking state: R = rOff (≈ 1GΩ+) until |V| > vBreakdown
 *   - Conducting state: R = rOn (≈ 1-10Ω) until |I| < iHold
 *   - Hysteresis: once fired, stays conducting until holding current drops
 *
 * Smooth resistance transition:
 *   To avoid step discontinuities that prevent NR convergence, the resistance
 *   blends continuously via a tanh soft transition:
 *
 *   Firing transition (blocking → conducting):
 *     R_fire(V) = rOff + (rOn - rOff) * 0.5 * (1 + tanh((|V| - vBreakdown) / w_v))
 *     where w_v = 0.05 * vBreakdown
 *
 *   Extinction transition (conducting → blocking):
 *     R_ext(I) = rOn + (rOff - rOn) * 0.5 * (1 + tanh((iHold - |I|) / w_i))
 *     where w_i = 0.05 * iHold
 *
 *   The effective resistance is the blend appropriate to the current state.
 *   State variable `_conducting` switches based on thresholds to avoid chattering.
 *
 * MNA topology:
 *   pinNodeIds[0] = n_pos
 *   pinNodeIds[1] = n_neg
 *   branchIndex    = -1
 *
 * Stamping:
 *   stamp()        — no-op
 *   stampNonlinear — stamps linearized conductance at current operating point
 *   updateOperatingPoint — tracks terminal voltage for resistance computation
 */

import type { AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
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
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: SPARK_GAP_PARAM_DEFS, defaults: SPARK_GAP_DEFAULTS } = defineModelParams({
  primary: {
    vBreakdown: { default: 1000, unit: "V",  description: "Voltage at which the spark gap fires" },
    rOn:        { default: 5,    unit: "Ω",  description: "Resistance when gap is conducting" },
  },
  secondary: {
    rOff:  { default: 1e10, unit: "Ω",  description: "Resistance when gap is blocking" },
    iHold: { default: 0.01, unit: "A",  description: "Minimum current to sustain conduction" },
  },
});

// ---------------------------------------------------------------------------
// Smooth resistance helpers
// ---------------------------------------------------------------------------

/**
 * Smooth firing transition: blocks at low V, conducts at high V.
 * Blends from rOff → rOn as |V| crosses vBreakdown.
 */
function firingResistance(absV: number, vBreakdown: number, rOff: number, rOn: number): number {
  const w = 0.05 * Math.max(vBreakdown, 1e-6);
  const blend = 0.5 * (1 + Math.tanh((absV - vBreakdown) / w));
  return rOff + (rOn - rOff) * blend;
}

/**
 * Smooth extinction transition: conducts at high I, blocks at low I.
 * Blends from rOn → rOff as |I| drops below iHold.
 */
function extinctionResistance(absI: number, iHold: number, rOn: number, rOff: number): number {
  const w = 0.05 * Math.max(iHold, 1e-12);
  const blend = 0.5 * (1 + Math.tanh((iHold - absI) / w));
  return rOn + (rOff - rOn) * blend;
}

// ---------------------------------------------------------------------------
// SparkGapElement — MNA implementation
// ---------------------------------------------------------------------------

export class SparkGapElement implements AnalogElementCore {
  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = false;

  private readonly _p: Record<string, number>;

  /** True when the spark gap is in the conducting state. */
  private _conducting: boolean = false;

  /** Terminal voltage from the most recent NR solution. */
  private _vTerminal: number = 0;

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
    this._p = {
      vBreakdown: Math.max(vBreakdown, 1e-6),
      rOn:        Math.max(rOn, MIN_RESISTANCE),
      rOff:       Math.max(rOff, 1),
      iHold:      Math.max(iHold, 1e-12),
    };
  }

  setParam(key: string, value: number): void {
    if (key in this._p) this._p[key] = value;
  }

  /**
   * Compute effective resistance at the current terminal voltage.
   * Uses the state-appropriate smooth transition.
   *
   * Blocking state: resistance blends from rOff toward rOn as |V| approaches breakdown.
   * Conducting state: resistance blends from rOn toward rOff as |I| drops below iHold.
   *   Current is estimated as |V| / rOn (the on-state resistance) so that the extinction
   *   transition is driven by the actual on-state current, not a re-evaluated off-state R.
   */
  resistance(): number {
    const absV = Math.abs(this._vTerminal);

    if (!this._conducting) {
      return firingResistance(absV, this._p.vBreakdown, this._p.rOff, this._p.rOn);
    }

    // In conducting state: current is V / rOn (on-state conduction)
    const absI = absV / Math.max(this._p.rOn, MIN_RESISTANCE);
    return extinctionResistance(absI, this._p.iHold, this._p.rOn, this._p.rOff);
  }

  /** True if the gap is currently conducting — exposed for testing. */
  get conducting(): boolean {
    return this._conducting;
  }

  stamp(_solver: SparseSolver): void {
    // All contributions are in stampNonlinear.
  }

  stampNonlinear(solver: SparseSolver): void {
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];

    const G = 1 / Math.max(this.resistance(), MIN_RESISTANCE);

    if (nPos !== 0 && nNeg !== 0) {
      solver.stamp(nPos - 1, nPos - 1, G);
      solver.stamp(nPos - 1, nNeg - 1, -G);
      solver.stamp(nNeg - 1, nPos - 1, -G);
      solver.stamp(nNeg - 1, nNeg - 1, G);
    } else if (nPos !== 0) {
      solver.stamp(nPos - 1, nPos - 1, G);
    } else if (nNeg !== 0) {
      solver.stamp(nNeg - 1, nNeg - 1, G);
    }
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];
    const vPos = nPos > 0 ? voltages[nPos - 1] : 0;
    const vNeg = nNeg > 0 ? voltages[nNeg - 1] : 0;
    const G = 1 / Math.max(this.resistance(), MIN_RESISTANCE);
    const I = G * (vPos - vNeg);
    return [I, -I];
  }

  updateOperatingPoint(voltages: Readonly<Float64Array>): void {
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];
    const vPos = nPos > 0 ? voltages[nPos - 1] : 0;
    const vNeg = nNeg > 0 ? voltages[nNeg - 1] : 0;
    this._vTerminal = vPos - vNeg;

    const absV = Math.abs(this._vTerminal);

    // Update discrete state with hysteresis
    if (!this._conducting && absV > this._p.vBreakdown) {
      this._conducting = true;
    } else if (this._conducting) {
      const absI = absV / Math.max(this._p.rOn, MIN_RESISTANCE);
      if (absI < this._p.iHold) {
        this._conducting = false;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

export function createSparkGapElement(
  _pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElementCore {
  const p: Record<string, number> = {
    vBreakdown: props.getModelParam<number>("vBreakdown"),
    rOn:        props.getModelParam<number>("rOn"),
    rOff:       props.getOrDefault<number>("rOff",       SPARK_GAP_DEFAULTS.rOff),
    iHold:      props.getOrDefault<number>("iHold",      SPARK_GAP_DEFAULTS.iHold),
  };
  return new SparkGapElement(p.vBreakdown, p.rOn, p.rOff, p.iHold);
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
// SparkGapCircuitElement — editor/visual layer
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

    // Electrode arrows — body, stays COMPONENT
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
    label: "Off Resistance (Ω)",
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

export const SparkGapDefinition: ComponentDefinition = {
  name: "SparkGap",
  typeId: -1,
  factory: sparkGapCircuitFactory,
  pinLayout: buildSparkGapPinDeclarations(),
  propertyDefs: SPARK_GAP_PROPERTY_DEFS,
  attributeMap: SPARK_GAP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Spark Gap — voltage-triggered switch with hysteresis. " +
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
