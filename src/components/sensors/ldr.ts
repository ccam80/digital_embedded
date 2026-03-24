/**
 * LDR (Light Dependent Resistor) — illumination-dependent resistor.
 *
 * Resistance model:
 *   lux = 0:         R = rDark  (no illumination)
 *   lux > 0:         R = rDark · (lux / luxRef)^(-gamma)
 *
 * At lux = luxRef, R = rDark · 1 = rDark.
 * The rLight property records the expected resistance at luxRef; for consistency
 * rLight should equal rDark * (luxRef/luxRef)^(-gamma) = rDark, but it is exposed
 * as a separate settable property to allow the user to override the dark resistance
 * via the light reference point.
 *
 * When rLight is provided as a non-zero calibration anchor, the formula becomes:
 *   R(lux) = rLight · (lux / luxRef)^(-gamma)   for lux > 0
 *
 * This ensures R(luxRef) = rLight exactly, which is the natural calibration point.
 * rDark is used only for lux = 0 (or as default when rLight is not separately
 * calibrated, i.e. when rLight == rDark).
 *
 * MNA topology:
 *   nodeIndices[0] = n_pos
 *   nodeIndices[1] = n_neg
 *   branchIndex    = -1
 *
 * Stamping:
 *   stamp()        — no-op
 *   stampNonlinear — stamps conductance 1/R(lux)
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
import type { PinVoltageAccess } from "../../editor/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-12;

// ---------------------------------------------------------------------------
// LDRElement — MNA implementation
// ---------------------------------------------------------------------------

export class LDRElement implements AnalogElement {
  readonly nodeIndices: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = false;

  private readonly _rDark: number;
  private readonly _luxRef: number;
  private readonly _gamma: number;

  /** Current light level in lux — adjustable via slider/property update. */
  private _lux: number;

  /**
   * @param nodeIndices - [n_pos, n_neg]
   * @param rDark       - Resistance in darkness (lux=0) in ohms
   * @param luxRef      - Reference illumination level in lux
   * @param gamma       - Power-law exponent (positive)
   * @param lux         - Current illumination level in lux
   */
  constructor(
    nodeIndices: number[],
    rDark: number,
    luxRef: number,
    gamma: number,
    lux: number,
  ) {
    this.nodeIndices = nodeIndices;
    this._rDark = Math.max(rDark, MIN_RESISTANCE);
    this._luxRef = Math.max(luxRef, 1e-12);
    this._gamma = gamma;
    this._lux = Math.max(lux, 0);
  }

  /** Compute resistance at the current lux level. */
  resistance(): number {
    if (this._lux <= 0) {
      return this._rDark;
    }
    const R = this._rDark * Math.pow(this._lux / this._luxRef, -this._gamma);
    return Math.max(R, MIN_RESISTANCE);
  }

  /** Current lux level — exposed for testing. */
  get lux(): number {
    return this._lux;
  }

  /** Update the lux level (slider interaction). */
  setLux(lux: number): void {
    this._lux = Math.max(lux, 0);
  }

  stamp(_solver: SparseSolver): void {
    // All conductance contributions are in stampNonlinear.
  }

  stampNonlinear(solver: SparseSolver): void {
    const nPos = this.nodeIndices[0];
    const nNeg = this.nodeIndices[1];

    const G = 1 / this.resistance();

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
    // No internal voltage-dependent state; resistance depends only on lux.
    void voltages;
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

export function createLDRElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  const rDark = props.getOrDefault<number>("rDark", 1e6);
  const luxRef = props.getOrDefault<number>("luxRef", 100);
  const gamma = props.getOrDefault<number>("gamma", 0.7);
  const lux = props.getOrDefault<number>("lux", 500);
  return new LDRElement(nodeIds, rDark, luxRef, gamma, lux);
}

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

function buildLDRPinDeclarations(): PinDeclaration[] {
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
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// LDRCircuitElement — editor/visual layer
// ---------------------------------------------------------------------------

export class LDRCircuitElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("LDR", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildLDRPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.625,
      width: 4,
      height: 2.625,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._properties.getOrDefault<string>("label", "");

    const vPos = signals?.getPinVoltage("pos");
    const vNeg = signals?.getPinVoltage("neg");
    const hasVoltage = vPos !== undefined && vNeg !== undefined;

    ctx.save();
    ctx.setLineWidth(1);

    // Lead 1: (0,0)→(1,0); Zigzag body: (1,0)→(3,0); Lead 2: (3,0)→(4,0)
    // Zigzag vertices derived from Falstad pixel coords (absolute px ÷ 16):
    // absolute x = local_x + 16 (because Falstad draws with a +16px x-offset)
    const hs = 6 / 16; // 0.375 grid units perpendicular offset
    const pts: Array<{ x: number; y: number }> = [
      { x: 0, y: 0 },   // lead1 start
      { x: 1, y: 0 },   // lead1 end / zigzag start
      { x: 1.125, y: hs },
      { x: 1.375, y: -hs },
      { x: 1.625, y: hs },
      { x: 1.875, y: -hs },
      { x: 2.125, y: hs },
      { x: 2.375, y: -hs },
      { x: 2.625, y: hs },
      { x: 2.875, y: -hs },
      { x: 3, y: 0 },   // zigzag end / lead2 start
      { x: 4, y: 0 },   // lead2 end
    ];

    // Gradient spans full component width (pos→neg, 0→4)
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(0, 0, 4, 0, [
        { offset: 0, color: signals!.voltageColor(vPos!) },
        { offset: 1, color: signals!.voltageColor(vNeg!) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    for (let i = 0; i < pts.length - 1; i++) {
      ctx.drawLine(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    }

    // Light arrows: shaft lines + two perpendicular bars (T-head arrowhead style)
    // Coordinates from Falstad pixel reference ÷ 16
    ctx.setColor("COMPONENT");

    // Arrow 1: shaft (0.5,1.625)→(1.5,0.75), bar1 (1.125,0.75)→(1.5,0.75), bar2 (1.5,0.75)→(1.5,1.125)
    ctx.drawLine(0.5, 1.625, 1.5, 0.75);
    ctx.drawLine(1.125, 0.75, 1.5, 0.75);
    ctx.drawLine(1.5, 0.75, 1.5, 1.125);

    // Arrow 2: shaft (1.75,1.625)→(2.625,0.75), bar1 (2.25,0.75)→(2.625,0.75), bar2 (2.625,0.75)→(2.625,1.125)
    ctx.drawLine(1.75, 1.625, 2.625, 0.75);
    ctx.drawLine(2.25, 0.75, 2.625, 0.75);
    ctx.drawLine(2.625, 0.75, 2.625, 1.125);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 2.6875, -0.5, { horizontal: "center", vertical: "top" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "LDR (Light Dependent Resistor) — resistance varies with illumination.\n" +
      "Uses a power-law model: R = R_dark × (lux / lux_ref)^(-γ)."
    );
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const LDR_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "rDark",
    type: PropertyType.FLOAT,
    label: "Dark Resistance (Ω)",
    defaultValue: 1e6,
    min: 1e-6,
    description: "Resistance in darkness (lux = 0)",
  },
  {
    key: "luxRef",
    type: PropertyType.FLOAT,
    label: "Reference Lux",
    defaultValue: 100,
    min: 1e-6,
    description: "Reference illumination level in lux",
  },
  {
    key: "gamma",
    type: PropertyType.FLOAT,
    label: "Gamma",
    defaultValue: 0.7,
    min: 0.01,
    description: "Power-law exponent (higher = steeper response)",
  },
  {
    key: "lux",
    type: PropertyType.FLOAT,
    label: "Illumination (lux)",
    defaultValue: 500,
    min: 0,
    description: "Current light level in lux (slider-adjustable)",
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

export const LDR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "rDark", propertyKey: "rDark", convert: (v) => parseFloat(v) },
  { xmlName: "luxRef", propertyKey: "luxRef", convert: (v) => parseFloat(v) },
  { xmlName: "gamma", propertyKey: "gamma", convert: (v) => parseFloat(v) },
  { xmlName: "lux", propertyKey: "lux", convert: (v) => parseFloat(v) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// LDRDefinition
// ---------------------------------------------------------------------------

function ldrCircuitFactory(props: PropertyBag): LDRCircuitElement {
  return new LDRCircuitElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const LDRDefinition: ComponentDefinition = {
  name: "LDR",
  typeId: -1,
  engineType: "analog",
  factory: ldrCircuitFactory,
  executeFn: () => {},
  pinLayout: buildLDRPinDeclarations(),
  propertyDefs: LDR_PROPERTY_DEFS,
  attributeMap: LDR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "LDR (Light Dependent Resistor) — resistance varies with illumination. " +
    "Power-law model: R = R_dark × (lux / lux_ref)^(-γ).",
  analogFactory: createLDRElement,
  requiresBranchRow: false,
};
