/**
 * Potentiometer analog component.
 *
 * A three-terminal linear element modelled as two series resistors sharing a
 * common wiper node. The wiper position (0.0–1.0) determines the resistance split:
 *   R_top = R × position
 *   R_bottom = R × (1 - position)
 *
 * Both resistances are clamped to a minimum to prevent division by zero.
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
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Minimum resistance clamp
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-9;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildPotentiometerPinDeclarations(): PinDeclaration[] {
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
      label: "W",
      defaultBitWidth: 1,
      position: { x: 2, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 2, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// PotentiometerElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PotentiometerElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("AnalogPotentiometer", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildPotentiometerPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.6,
      width: 2,
      height: 1.2,
    };
  }

  draw(ctx: RenderContext): void {
    const resistance = this._properties.getOrDefault<number>("resistance", 10000);
    const position = this._properties.getOrDefault<number>("position", 0.5);
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Lead lines: left lead from x=0 to x=0.4, right lead from x=1.6 to x=2
    ctx.drawLine(0, 0, 0.4, 0);
    ctx.drawLine(1.6, 0, 2, 0);

    // Resistor body (zigzag)
    const zigX = [0.4, 0.667, 0.933, 1.2, 1.467, 1.6];
    const zigY = [0, -0.3, 0.3, -0.3, 0.3, 0];
    for (let i = 0; i < zigX.length - 1; i++) {
      ctx.drawLine(zigX[i], zigY[i], zigX[i + 1], zigY[i + 1]);
    }

    // Wiper position line from center to wiper pin (right side)
    const wiperX = 0.4 + (1.6 - 0.4) * position;
    ctx.drawLine(wiperX, 0, 2, 0.5);

    // Value label below body
    const displayLabel = label.length > 0 ? label : `${resistance}Ω`;
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 1, 0.8, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Potentiometer — voltage divider with 3 terminals (A, wiper, B).\n" +
      "Position determines the voltage division between top and bottom resistances."
    );
  }
}

// ---------------------------------------------------------------------------
// AnalogPotentiometerElement — MNA implementation
// ---------------------------------------------------------------------------

class AnalogPotentiometerElement implements AnalogElement {
  readonly nodeIndices: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = false;

  private readonly R: number;
  private readonly position: number;
  private G_top: number;
  private G_bottom: number;

  constructor(nodeIndices: number[], resistance: number, position: number) {
    this.nodeIndices = nodeIndices;
    this.R = resistance;
    this.position = Math.max(0, Math.min(1, position));

    const R_top = Math.max(this.R * this.position, MIN_RESISTANCE);
    const R_bottom = Math.max(this.R * (1 - this.position), MIN_RESISTANCE);
    this.G_top = 1 / R_top;
    this.G_bottom = 1 / R_bottom;
  }

  stamp(solver: SparseSolver): void {
    const n_A = this.nodeIndices[0]; // top
    const n_W = this.nodeIndices[1]; // wiper
    const n_B = this.nodeIndices[2]; // bottom

    // Top resistor (R_top) stamps: G_top at (A,A), (W,W), (A,W), (W,A)
    solver.stamp(n_A, n_A, this.G_top);
    solver.stamp(n_W, n_W, this.G_top);
    solver.stamp(n_A, n_W, -this.G_top);
    solver.stamp(n_W, n_A, -this.G_top);

    // Bottom resistor (R_bottom) stamps: G_bottom at (W,W), (B,B), (W,B), (B,W)
    solver.stamp(n_W, n_W, this.G_bottom);
    solver.stamp(n_B, n_B, this.G_bottom);
    solver.stamp(n_W, n_B, -this.G_bottom);
    solver.stamp(n_B, n_W, -this.G_bottom);
  }
}

function createPotentiometerElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const R = props.getOrDefault<number>("resistance", 10000);
  const position = props.getOrDefault<number>("position", 0.5);
  return new AnalogPotentiometerElement(nodeIds, R, position);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const POTENTIOMETER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "resistance",
    type: PropertyType.INT,
    label: "Resistance (Ω)",
    defaultValue: 10000,
    min: 1e-9,
    description: "Total resistance in ohms",
  },
  {
    key: "position",
    type: PropertyType.FLOAT,
    label: "Position",
    defaultValue: 0.5,
    min: 0,
    max: 1,
    description: "Wiper position (0.0 = full bottom, 1.0 = full top)",
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

export const POTENTIOMETER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "resistance",
    propertyKey: "resistance",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "position",
    propertyKey: "position",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// PotentiometerDefinition
// ---------------------------------------------------------------------------

function potentiometerCircuitFactory(props: PropertyBag): PotentiometerElement {
  return new PotentiometerElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PotentiometerDefinition: ComponentDefinition = {
  name: "AnalogPotentiometer",
  typeId: -1,
  engineType: "analog",
  factory: potentiometerCircuitFactory,
  executeFn: () => {},
  pinLayout: buildPotentiometerPinDeclarations(),
  propertyDefs: POTENTIOMETER_PROPERTY_DEFS,
  attributeMap: POTENTIOMETER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Potentiometer — voltage divider with 3 terminals (A, wiper, B).\n" +
    "Position determines the voltage division between top and bottom resistances.",
  analogFactory: createPotentiometerElement,
};
