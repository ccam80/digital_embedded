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
  createInverterConfig,
  resolvePins,
  layoutPinsOnFace,
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
// ---------------------------------------------------------------------------

const COMP_WIDTH = 2;
const COMP_HEIGHT = 3;

// ---------------------------------------------------------------------------
// Pin layout — VDD on north face, GND on south face
// ---------------------------------------------------------------------------

function buildPowerSupplyPinDeclarations(): PinDeclaration[] {
  const vddPositions = layoutPinsOnFace("north", 1, COMP_WIDTH, COMP_HEIGHT);
  const gndPositions = layoutPinsOnFace("south", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    {
      direction: PinDirection.INPUT,
      label: "VDD",
      defaultBitWidth: 1,
      position: vddPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "GND",
      defaultBitWidth: 1,
      position: gndPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// PowerSupplyElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PowerSupplyElement extends AbstractCircuitElement {
  private readonly _label: string;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PowerSupply", instanceId, position, rotation, mirror, props);

    this._label = props.getOrDefault<string>("label", "");

    const decls = buildPowerSupplyPinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      1,
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    const { x, y } = this.position;

    ctx.save();
    ctx.translate(x, y);

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    // VCC symbol: upward-pointing symbol at top
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.65, weight: "bold" });
    ctx.drawText("VDD", COMP_WIDTH / 2, 0.7, {
      horizontal: "center",
      vertical: "middle",
    });

    // GND symbol: horizontal lines at bottom
    ctx.drawText("GND", COMP_WIDTH / 2, COMP_HEIGHT - 0.7, {
      horizontal: "center",
      vertical: "middle",
    });

    if (this._label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(this._label, COMP_WIDTH / 2, -0.3, {
        horizontal: "center",
        vertical: "bottom",
      });
    }

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
  index: number,
  state: Uint32Array,
  layout: ComponentLayout,
): void {
  const inputStart = layout.inputOffset(index);
  const vdd = state[inputStart];     // index 0: VDD
  const gnd = state[inputStart + 1]; // index 1: GND
  const outputIdx = layout.outputOffset(index);

  if (vdd !== 1) {
    state[outputIdx] = 1; // VDD error
  } else if (gnd !== 0) {
    state[outputIdx] = 2; // GND error
  } else {
    state[outputIdx] = 0; // OK
  }
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
