/**
 * Resistor analog component.
 *
 * Stamps a conductance matrix: G = 1/R at four positions in the MNA matrix.
 * Two-terminal element with no branch variable (branchIndex = -1).
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  noOpAnalogExecuteFn,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Minimum resistance clamp — prevents G → ∞ for degenerate values
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-9;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildResistorPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "A",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// ResistorElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ResistorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("AnalogResistor", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildResistorPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.5,
      width: 4,
      height: 1,
    };
  }

  draw(ctx: RenderContext): void {
    const resistance = this._properties.getOrDefault<number>("resistance", 1000);
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Lead lines: left lead from x=0 to x=1, right lead from x=3 to x=4
    ctx.drawLine(0, 0, 1, 0);
    ctx.drawLine(3, 0, 4, 0);

    // IEEE zigzag body between x=1 and x=3, 6 segments at alternating ±0.5 y
    const zigX = [1, 1.333, 1.667, 2.0, 2.333, 2.667, 3];
    const zigY = [0, -0.5, 0.5, -0.5, 0.5, -0.5, 0];
    for (let i = 0; i < zigX.length - 1; i++) {
      ctx.drawLine(zigX[i], zigY[i], zigX[i + 1], zigY[i + 1]);
    }

    // Value label below body
    const displayLabel = label.length > 0 ? label : `${resistance}Ω`;
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText(displayLabel, 2, 0.75, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Resistor — stamps conductance G=1/R into the MNA matrix.\n" +
      "Minimum resistance is clamped to 1e-9 Ω."
    );
  }
}

// ---------------------------------------------------------------------------
// createResistorElement — AnalogElement factory
// ---------------------------------------------------------------------------

// Stamp helper — node 0 is ground (skipped), 1-based → 0-based solver index
function stampG(solver: SparseSolver, row: number, col: number, val: number): void {
  if (row !== 0 && col !== 0) {
    solver.stamp(row - 1, col - 1, val);
  }
}

function createResistorElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const rawR = props.getOrDefault<number>("resistance", 1000);
  const R = Math.max(rawR, MIN_RESISTANCE);
  const G = 1 / R;
  const n0 = nodeIds[0];
  const n1 = nodeIds[1];

  return {
    nodeIndices: [n0, n1],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,

    stamp(solver: SparseSolver): void {
      stampG(solver, n0, n0, G);
      stampG(solver, n0, n1, -G);
      stampG(solver, n1, n0, -G);
      stampG(solver, n1, n1, G);
    },
  };
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const RESISTOR_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "resistance",
    type: PropertyType.INT,
    label: "Resistance (Ω)",
    defaultValue: 1000,
    min: 1e-9,
    description: "Resistance in ohms. Minimum clamped to 1e-9 Ω.",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown below the component",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const RESISTOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "resistance",
    propertyKey: "resistance",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// ResistorDefinition
// ---------------------------------------------------------------------------

function resistorCircuitFactory(props: PropertyBag): ResistorElement {
  return new ResistorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ResistorDefinition: ComponentDefinition = {
  name: "AnalogResistor",
  typeId: -1,
  engineType: "analog",
  factory: resistorCircuitFactory,
  executeFn: noOpAnalogExecuteFn,
  pinLayout: buildResistorPinDeclarations(),
  propertyDefs: RESISTOR_PROPERTY_DEFS,
  attributeMap: RESISTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Resistor — stamps conductance G=1/R into the MNA matrix.\n" +
    "Minimum resistance is clamped to 1e-9 Ω.",
  analogFactory: createResistorElement,
};
