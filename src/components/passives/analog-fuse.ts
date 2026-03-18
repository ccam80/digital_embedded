/**
 * Analog fuse — variable-resistance element with thermal I²t energy model.
 *
 * Models a fuse as a resistance that transitions from R_cold (intact) to
 * R_blown (open circuit) when the accumulated I²t energy exceeds the rating.
 *
 * Thermal model:
 *   _thermalEnergy accumulates I²·dt each accepted timestep via updateState().
 *   When _thermalEnergy exceeds i2tRating the fuse is permanently blown.
 *
 * Smooth resistance transition:
 *   To prevent discontinuous resistance changes that would prevent NR convergence,
 *   the resistance is blended through a soft tanh transition over a small energy
 *   range near the blow threshold. The transition width is 5% of i2tRating.
 *
 *   R(e) = R_cold + (R_blown - R_cold) * 0.5 * (1 + tanh((e - i2t) / w))
 *
 *   where w = 0.05 * i2tRating (transition width).
 *   Below threshold R ≈ R_cold; above threshold R ≈ R_blown.
 *
 * MNA topology:
 *   nodeIndices[0] = n_pos  (positive terminal)
 *   nodeIndices[1] = n_neg  (negative terminal)
 *   branchIndex    = -1     (no branch current row)
 *
 * Stamping:
 *   stamp()         — no-op (all contributions are in stampNonlinear)
 *   stampNonlinear  — stamps conductance 1/R(_thermalEnergy)
 *   updateState     — integrates I²·dt using current terminal voltages
 *
 * Diagnostic:
 *   Emits 'fuse-blown' (info) on the timestep when _blown first becomes true.
 */

import type { AnalogElement } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import type { SolverDiagnostic, SolverDiagnosticCode } from "../../core/analog-engine-interface.js";
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
// Smooth resistance helper
// ---------------------------------------------------------------------------

/**
 * Compute blended resistance using a tanh soft transition near the blow threshold.
 * Ensures NR convergence by avoiding a step discontinuity in conductance.
 */
function smoothResistance(
  thermalEnergy: number,
  i2tRating: number,
  rCold: number,
  rBlown: number,
): number {
  const width = 0.05 * i2tRating;
  const x = (thermalEnergy - i2tRating) / Math.max(width, 1e-30);
  const blend = 0.5 * (1 + Math.tanh(x));
  return rCold + (rBlown - rCold) * blend;
}

// ---------------------------------------------------------------------------
// AnalogFuseElement — MNA implementation
// ---------------------------------------------------------------------------

export class AnalogFuseElement implements AnalogElement {
  readonly nodeIndices: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = false;

  private readonly _rCold: number;
  private readonly _rBlown: number;
  private readonly _i2tRating: number;

  private _thermalEnergy: number = 0;
  private _blown: boolean = false;
  private _blownDiagEmitted: boolean = false;

  private _currentVoltage: number = 0;

  private readonly _emitDiagnostic: (diag: SolverDiagnostic) => void;

  /**
   * @param nodeIndices    - [n_pos, n_neg]
   * @param rCold          - Cold (intact) resistance in ohms
   * @param rBlown         - Blown (open) resistance in ohms
   * @param i2tRating      - I²t energy rating in A²·s
   * @param emitDiagnostic - Callback invoked when fuse blows
   */
  constructor(
    nodeIndices: number[],
    rCold: number,
    rBlown: number,
    i2tRating: number,
    emitDiagnostic?: (diag: SolverDiagnostic) => void,
  ) {
    this.nodeIndices = nodeIndices;
    this._rCold = Math.max(rCold, 1e-12);
    this._rBlown = Math.max(rBlown, 1e-6);
    this._i2tRating = Math.max(i2tRating, 1e-30);
    this._emitDiagnostic = emitDiagnostic ?? (() => {});
  }

  stamp(_solver: SparseSolver): void {
    // All conductance contributions are in stampNonlinear (resistance is state-dependent).
  }

  stampNonlinear(solver: SparseSolver): void {
    const nPos = this.nodeIndices[0];
    const nNeg = this.nodeIndices[1];

    const R = smoothResistance(this._thermalEnergy, this._i2tRating, this._rCold, this._rBlown);
    const G = 1 / Math.max(R, MIN_RESISTANCE);

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
    this._currentVoltage = vPos - vNeg;
  }

  updateState(dt: number, voltages: Float64Array): void {
    const nPos = this.nodeIndices[0];
    const nNeg = this.nodeIndices[1];
    const vPos = nPos > 0 ? voltages[nPos - 1] : 0;
    const vNeg = nNeg > 0 ? voltages[nNeg - 1] : 0;
    const vDiff = vPos - vNeg;

    // Compute current from the current resistance state.
    // While intact, use R_cold for the thermal energy integral so that a
    // fixed driving voltage produces the expected I²t accumulation. After
    // blowing, use R_blown so the current collapses to near zero.
    const R_eff = this._blown ? this._rBlown : this._rCold;
    const I = vDiff / Math.max(R_eff, MIN_RESISTANCE);

    // Integrate thermal energy: I²·dt
    this._thermalEnergy += I * I * dt;

    // Check blow condition after integration
    if (!this._blown && this._thermalEnergy >= this._i2tRating) {
      this._blown = true;
    }

    // Emit diagnostic once when fuse first blows
    if (this._blown && !this._blownDiagEmitted) {
      this._blownDiagEmitted = true;
      this._emitDiagnostic({
        code: "fuse-blown" as SolverDiagnosticCode,
        severity: "info",
        summary: "Fuse blown: accumulated I²t energy exceeded rating.",
        explanation:
          "The fuse thermal energy (I²·t integral) exceeded the specified i2tRating. " +
          "The fuse is now permanently open (high resistance). " +
          "Replace the fuse or reduce the current to prevent recurrence.",
        suggestions: [
          {
            text: "Increase i2tRating or reduce load current.",
            automatable: false,
          },
        ],
      });
    }
  }

  /** Current thermal energy state — exposed for testing. */
  get thermalEnergy(): number {
    return this._thermalEnergy;
  }

  /** True if the fuse has blown. */
  get blown(): boolean {
    return this._blown;
  }

  /** Current effective resistance given accumulated thermal energy. */
  get currentResistance(): number {
    return smoothResistance(this._thermalEnergy, this._i2tRating, this._rCold, this._rBlown);
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

export function createAnalogFuseElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  const rCold = props.getOrDefault<number>("rCold", 0.01);
  const rBlown = props.getOrDefault<number>("rBlown", 1e9);
  const i2tRating = props.getOrDefault<number>("i2tRating", 1.0);
  return new AnalogFuseElement(nodeIds, rCold, rBlown, i2tRating);
}

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

function buildAnalogFusePinDeclarations(): PinDeclaration[] {
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
// AnalogFuseCircuitElement — editor/visual layer
// ---------------------------------------------------------------------------

export class AnalogFuseCircuitElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("AnalogFuse", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildAnalogFusePinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 0.25, width: 1, height: 0.5 };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Wavy fuse body
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0, y: 0 },
        { op: "curveTo", cp1x: 0.1, cp1y: -0.25, cp2x: 0.15, cp2y: -0.25, x: 0.25, y: -0.25 },
        { op: "curveTo", cp1x: 0.4, cp1y: -0.25, cp2x: 0.4, cp2y: 0, x: 0.5, y: 0 },
        { op: "curveTo", cp1x: 0.6, cp1y: 0, cp2x: 0.6, cp2y: 0.25, x: 0.75, y: 0.25 },
        { op: "curveTo", cp1x: 0.9, cp1y: 0.25, cp2x: 0.9, cp2y: 0, x: 1, y: 0 },
      ],
    });

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 0.5, -0.4, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Analog fuse — variable-resistance element with I²t thermal model.\n" +
      "Blows permanently when accumulated I²t energy exceeds the rating."
    );
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const ANALOG_FUSE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "rCold",
    type: PropertyType.FLOAT,
    label: "Cold Resistance (Ω)",
    defaultValue: 0.01,
    min: 1e-12,
    description: "Resistance when fuse is intact",
  },
  {
    key: "rBlown",
    type: PropertyType.FLOAT,
    label: "Blown Resistance (Ω)",
    defaultValue: 1e9,
    min: 1,
    description: "Resistance when fuse has blown (effectively open circuit)",
  },
  {
    key: "currentRating",
    type: PropertyType.FLOAT,
    label: "Current Rating (A)",
    defaultValue: 1.0,
    min: 1e-6,
    description: "Continuous current rating in amperes",
  },
  {
    key: "i2tRating",
    type: PropertyType.FLOAT,
    label: "I²t Rating (A²·s)",
    defaultValue: 1.0,
    min: 1e-12,
    description: "Energy rating: fuse blows when accumulated I²·t exceeds this value",
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

export const ANALOG_FUSE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "rCold", propertyKey: "rCold", convert: (v) => parseFloat(v) },
  { xmlName: "rBlown", propertyKey: "rBlown", convert: (v) => parseFloat(v) },
  { xmlName: "currentRating", propertyKey: "currentRating", convert: (v) => parseFloat(v) },
  { xmlName: "i2tRating", propertyKey: "i2tRating", convert: (v) => parseFloat(v) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// AnalogFuseDefinition
// ---------------------------------------------------------------------------

function analogFuseCircuitFactory(props: PropertyBag): AnalogFuseCircuitElement {
  return new AnalogFuseCircuitElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const AnalogFuseDefinition: ComponentDefinition = {
  name: "AnalogFuse",
  typeId: -1,
  engineType: "analog",
  factory: analogFuseCircuitFactory,
  executeFn: () => {},
  pinLayout: buildAnalogFusePinDeclarations(),
  propertyDefs: ANALOG_FUSE_PROPERTY_DEFS,
  attributeMap: ANALOG_FUSE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Analog fuse — variable-resistance element with I²t thermal model. " +
    "Blows permanently when accumulated I²t energy exceeds the rating.",
  analogFactory: createAnalogFuseElement,
  requiresBranchRow: false,
};
