/**
 * Driver component — tri-state buffer.
 *
 * When enable is high: output = input.
 * When enable is low: output = high-Z (all bits set in the highZ output slot).
 *
 * The compiled engine uses two output slots: [value, highZ].
 * highZ = 0 means the output is driven; highZ = 0xFFFFFFFF means high-impedance.
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

const COMP_WIDTH = 3;
const COMP_HEIGHT = 3;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildDriverPinDeclarations(bitWidth: number): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "sel",
      defaultBitWidth: 1,
      position: { x: 1, y: COMP_HEIGHT },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: bitWidth,
      position: { x: COMP_WIDTH, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// DriverElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DriverElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Driver", instanceId, position, rotation, mirror, props);

    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);

    const decls = buildDriverPinDeclarations(this._bitWidth);
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      this._bitWidth,
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

    ctx.save();

    // Triangle body pointing right (buffer/driver symbol)
    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon(
      [
        { x: 0, y: 0 },
        { x: COMP_WIDTH, y: COMP_HEIGHT / 2 },
        { x: 0, y: COMP_HEIGHT },
      ],
      true,
    );
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon(
      [
        { x: 0, y: 0 },
        { x: COMP_WIDTH, y: COMP_HEIGHT / 2 },
        { x: 0, y: COMP_HEIGHT },
      ],
      false,
    );

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Driver — tri-state buffer.\n" +
      "When sel=1: output = input.\n" +
      "When sel=0: output is high-impedance (disconnected)."
    );
  }
}

// ---------------------------------------------------------------------------
// executeDriver — tri-state logic
//
// Signal layout (by convention with two output slots):
//   inputOffset(index) + 0 = data input
//   inputOffset(index) + 1 = sel (enable)
//   outputOffset(index) + 0 = output value
//   outputOffset(index) + 1 = highZ flag (0=driven, 0xFFFFFFFF=high-Z)
// ---------------------------------------------------------------------------

export function executeDriver(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const dataIn = state[inBase];
  const sel = state[inBase + 1];

  if (sel !== 0) {
    state[outBase] = dataIn;
    state[outBase + 1] = 0;
  } else {
    state[outBase] = 0;
    state[outBase + 1] = 0xFFFFFFFF;
  }
}

// ---------------------------------------------------------------------------
// DRIVER_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const DRIVER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const DRIVER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the data signal",
  },
];

// ---------------------------------------------------------------------------
// DriverDefinition
// ---------------------------------------------------------------------------

function driverFactory(props: PropertyBag): DriverElement {
  return new DriverElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DriverDefinition: ComponentDefinition = {
  name: "Driver",
  typeId: -1,
  factory: driverFactory,
  executeFn: executeDriver,
  pinLayout: buildDriverPinDeclarations(1),
  propertyDefs: DRIVER_PROPERTY_DEFS,
  attributeMap: DRIVER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Driver — tri-state buffer.\n" +
    "When sel=1: output = input.\n" +
    "When sel=0: output is high-impedance (disconnected).",
};
