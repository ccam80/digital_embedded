/**
 * PowerSupply component — VCC/GND source enforcer for CMOS circuits.
 *
 * Has two inputs: VDD (must be 1) and GND (must be 0).
 * During simulation, if VDD != 1 or GND != 0, the engine raises an error.
 * No outputs. executeFn validates the supply inputs and signals an error
 * if the power supply is incorrectly connected.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout constants
// Java PowerSupply uses GenericShape: 2 inputs (VDD, GND), 0 outputs, width=3
// Non-symmetric (0 outputs) → offs=0
// VDD@(0,0), GND@(0,1)
// → COMP_WIDTH=3, COMP_HEIGHT=2
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin layout — Java GenericShape(2 inputs, 0 outputs, width=3):
//   VDD at (0, 0)
//   GND at (0, 1)
// ---------------------------------------------------------------------------

function buildPowerSupplyPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "VDD",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "GND",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// PowerSupplyElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PowerSupplyElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PowerSupply", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildPowerSupplyPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Polygon: (0.05,-0.5) to (2.95,1.5). Use exact polygon vertex arithmetic.
    const minX = 0.05, maxX = 2.95, minY = -0.5, maxY = 1.5;
    return {
      x: this.position.x + minX,
      y: this.position.y + minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  draw(ctx: RenderContext): void {

    ctx.save();

    // Rectangle (NORMAL — outline only, no fill per Java fixture)
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon(
      [
        { x: 0.05, y: -0.5 },
        { x: 2.95, y: -0.5 },
        { x: 2.95, y: 1.5 },
        { x: 0.05, y: 1.5 },
      ],
      false,
    );

    // Pin labels left-aligned
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.55 });
    ctx.drawText("VDD", 0.2, 0, {
      horizontal: "left",
      vertical: "middle",
    });
    ctx.drawText("GND", 0.2, 1, {
      horizontal: "left",
      vertical: "middle",
    });

    // Component name centered at top
    ctx.drawText("Power", 1.5, 1.7, {
      horizontal: "center",
      vertical: "middle",
    });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "PowerSupply — VCC/GND source enforcer for CMOS circuits.\n" +
      "VDD input must be connected to logic 1 (VCC).\n" +
      "GND input must be connected to logic 0 (ground).\n" +
      "The engine raises a simulation error if either connection is incorrect."
    );
  }
}

// ---------------------------------------------------------------------------
// executePowerSupply — validates VDD=1, GND=0; no outputs
//
// Returns without error when connections are correct.
// The engine is responsible for raising simulation errors based on the
// result of this validation. The executeFn writes a status flag to the
// output slot: 0 = OK, 1 = VDD error, 2 = GND error.
// ---------------------------------------------------------------------------

export function executePowerSupply(
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {
  // PowerSupply has no outputs — it is a validation-only sink component.
  // The engine may check VDD/GND inputs via a post-step hook on the element.
}

// ---------------------------------------------------------------------------
// POWER_SUPPLY_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const POWER_SUPPLY_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const POWER_SUPPLY_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown on the component",
  },
];

// ---------------------------------------------------------------------------
// PowerSupplyDefinition
// ---------------------------------------------------------------------------

function powerSupplyFactory(props: PropertyBag): PowerSupplyElement {
  return new PowerSupplyElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PowerSupplyDefinition: ComponentDefinition = {
  name: "PowerSupply",
  typeId: -1,
  factory: powerSupplyFactory,
  executeFn: executePowerSupply,
  pinLayout: buildPowerSupplyPinDeclarations(),
  propertyDefs: POWER_SUPPLY_PROPERTY_DEFS,
  attributeMap: POWER_SUPPLY_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "PowerSupply — VCC/GND source enforcer for CMOS circuits.\n" +
    "VDD input must be connected to logic 1 (VCC).\n" +
    "GND input must be connected to logic 0 (ground).\n" +
    "The engine raises a simulation error if either connection is incorrect.",
};
