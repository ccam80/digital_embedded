/**
 * DriverInvSel component — tri-state buffer with inverted select (enable active-low).
 *
 * When sel=0 (enable active-low): output = input.
 * When sel=1: output = high-Z (all bits set in the highZ output slot).
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
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

function buildDriverInvPinDeclarations(bitWidth: number): PinDeclaration[] {
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
      isNegatable: true,
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
// DriverInvSelElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DriverInvSelElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("DriverInvSel", instanceId, position, rotation, mirror, props);

    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);

    const decls = buildDriverInvPinDeclarations(this._bitWidth);
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig(["sel"]),
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

    // Inversion bubble on sel pin
    ctx.drawCircle(1, COMP_HEIGHT + 0.3, 0.3, false);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "DriverInvSel — tri-state buffer with active-low enable.\n" +
      "When sel=0 (active-low): output = input.\n" +
      "When sel=1: output is high-impedance (disconnected)."
    );
  }
}

// ---------------------------------------------------------------------------
// executeDriverInvSel — tri-state logic with inverted select
// ---------------------------------------------------------------------------

export function executeDriverInvSel(
  index: number,
  state: Uint32Array,
  layout: ComponentLayout,
): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const dataIn = state[inBase];
  const sel = state[inBase + 1];

  if (sel === 0) {
    state[outBase] = dataIn;
    state[outBase + 1] = 0;
  } else {
    state[outBase] = 0;
    state[outBase + 1] = 0xFFFFFFFF;
  }
}

// ---------------------------------------------------------------------------
// DRIVER_INV_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const DRIVER_INV_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const DRIVER_INV_PROPERTY_DEFS: PropertyDefinition[] = [
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
// DriverInvSelDefinition
// ---------------------------------------------------------------------------

function driverInvFactory(props: PropertyBag): DriverInvSelElement {
  return new DriverInvSelElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DriverInvSelDefinition: ComponentDefinition = {
  name: "DriverInvSel",
  typeId: -1,
  factory: driverInvFactory,
  executeFn: executeDriverInvSel,
  pinLayout: buildDriverInvPinDeclarations(1),
  propertyDefs: DRIVER_INV_PROPERTY_DEFS,
  attributeMap: DRIVER_INV_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "DriverInvSel — tri-state buffer with active-low enable.\n" +
    "When sel=0 (active-low): output = input.\n" +
    "When sel=1: output is high-impedance (disconnected).",
};
