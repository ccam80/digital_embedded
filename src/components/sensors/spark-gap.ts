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
 *   nodeIndices[0] = n_pos
 *   nodeIndices[1] = n_neg
 *   branchIndex    = -1
 *
 * Stamping:
 *   stamp()        — no-op
 *   stampNonlinear — stamps linearized conductance at current operating point
 *   updateOperatingPoint — tracks terminal voltage for resistance computation
 */

import type { AnalogElement } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-12;

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

export class SparkGapElement implements AnalogElement {
  readonly nodeIndices: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = false;

  private readonly _vBreakdown: number;
  private readonly _rOn: number;
  private readonly _rOff: number;
  private readonly _iHold: number;

  /** True when the spark gap is in the conducting state. */
  private _conducting: boolean = false;

  /** Terminal voltage from the most recent NR solution. */
  private _vTerminal: number = 0;

  /**
   * @param nodeIndices - [n_pos, n_neg]
   * @param vBreakdown  - Breakdown voltage in volts
   * @param rOn         - On-state resistance in ohms
   * @param rOff        - Off-state resistance in ohms
   * @param iHold       - Holding current in amps; below this the gap extinguishes
   */
  constructor(
    nodeIndices: number[],
    vBreakdown: number,
    rOn: number,
    rOff: number,
    iHold: number,
  ) {
    this.nodeIndices = nodeIndices;
    this._vBreakdown = Math.max(vBreakdown, 1e-6);
    this._rOn = Math.max(rOn, MIN_RESISTANCE);
    this._rOff = Math.max(rOff, 1);
    this._iHold = Math.max(iHold, 1e-12);
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
      return firingResistance(absV, this._vBreakdown, this._rOff, this._rOn);
    }

    // In conducting state: current is V / rOn (on-state conduction)
    const absI = absV / Math.max(this._rOn, MIN_RESISTANCE);
    return extinctionResistance(absI, this._iHold, this._rOn, this._rOff);
  }

  /** True if the gap is currently conducting — exposed for testing. */
  get conducting(): boolean {
    return this._conducting;
  }

  stamp(_solver: SparseSolver): void {
    // All contributions are in stampNonlinear.
  }

  stampNonlinear(solver: SparseSolver): void {
    const nPos = this.nodeIndices[0];
    const nNeg = this.nodeIndices[1];

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

  updateOperatingPoint(voltages: Float64Array): void {
    const nPos = this.nodeIndices[0];
    const nNeg = this.nodeIndices[1];
    const vPos = nPos > 0 ? voltages[nPos - 1] : 0;
    const vNeg = nNeg > 0 ? voltages[nNeg - 1] : 0;
    this._vTerminal = vPos - vNeg;

    const absV = Math.abs(this._vTerminal);

    // Update discrete state with hysteresis
    if (!this._conducting && absV > this._vBreakdown) {
      this._conducting = true;
    } else if (this._conducting) {
      const R = this._rOn;
      const absI = absV / Math.max(R, MIN_RESISTANCE);
      if (absI < this._iHold) {
        this._conducting = false;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

export function createSparkGapElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  const vBreakdown = props.getOrDefault<number>("vBreakdown", 1000);
  const rOn = props.getOrDefault<number>("rOn", 5);
  const rOff = props.getOrDefault<number>("rOff", 1e10);
  const iHold = props.getOrDefault<number>("iHold", 0.01);
  return new SparkGapElement(nodeIds, vBreakdown, rOn, rOff, iHold);
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
    },
    {
      direction: PinDirection.OUTPUT,
      label: "neg",
      defaultBitWidth: 1,
      position: { x: 1, y: 0 },
      isNegatable: false,
      isClockCapable: false,
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
    return { x: this.position.x, y: this.position.y - 0.3, width: 1, height: 0.6 };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Left electrode
    ctx.drawLine(0, 0, 0.35, 0);
    ctx.drawLine(0.35, -0.25, 0.35, 0.25);

    // Right electrode
    ctx.drawLine(0.65, 0, 1, 0);
    ctx.drawLine(0.65, -0.25, 0.65, 0.25);

    // Spark symbol (zigzag between electrodes)
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0.35, y: 0 },
        { op: "lineTo", x: 0.45, y: -0.1 },
        { op: "lineTo", x: 0.55, y: 0.1 },
        { op: "lineTo", x: 0.65, y: 0 },
      ],
    });

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 0.5, -0.35, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Spark Gap — voltage-triggered switch with hysteresis.\n" +
      "Fires when voltage exceeds breakdown; stays conducting until current drops below holding threshold."
    );
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SPARK_GAP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "vBreakdown",
    type: PropertyType.FLOAT,
    label: "Breakdown Voltage (V)",
    defaultValue: 1000,
    min: 1e-3,
    description: "Voltage at which the spark gap fires",
  },
  {
    key: "rOn",
    type: PropertyType.FLOAT,
    label: "On Resistance (Ω)",
    defaultValue: 5,
    min: MIN_RESISTANCE,
    description: "Resistance when gap is conducting",
  },
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
  { xmlName: "vBreakdown", propertyKey: "vBreakdown", convert: (v) => parseFloat(v) },
  { xmlName: "rOn", propertyKey: "rOn", convert: (v) => parseFloat(v) },
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
  engineType: "analog",
  factory: sparkGapCircuitFactory,
  executeFn: () => {},
  pinLayout: buildSparkGapPinDeclarations(),
  propertyDefs: SPARK_GAP_PROPERTY_DEFS,
  attributeMap: SPARK_GAP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Spark Gap — voltage-triggered switch with hysteresis. " +
    "Fires at breakdown voltage; stays on until current drops below holding threshold.",
  analogFactory: createSparkGapElement,
  requiresBranchRow: false,
};
