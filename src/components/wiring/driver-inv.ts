/**
 * DriverInvSel component — tri-state buffer with inverted select (enable active-low).
 *
 * When sel=0 (enable active-low): output = input.
 * When sel=1: output = high-Z (all bits set in the highZ output slot).
 *
 * Dimensions match Java DriverShape (origin-centred, invertedInput=true).
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
import { createDriverInvAnalogElement } from "../../analog/behavioral-remaining.js";

// ---------------------------------------------------------------------------
// Layout constants — same as Driver (origin-centred)
// ---------------------------------------------------------------------------

const COMP_WIDTH = 2;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildDriverInvPinDeclarations(bitWidth: number, flipSelPos = false): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: bitWidth,
      position: { x: -1, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "sel",
      defaultBitWidth: 1,
      position: { x: 0, y: flipSelPos ? 1 : -1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: bitWidth,
      position: { x: 1, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// DriverInvSelElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DriverInvSelElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("DriverInvSel", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const flipSelPos = this._properties.getOrDefault<boolean>("flipSelPos", false);
    return resolvePins(
      buildDriverInvPinDeclarations(bitWidth, flipSelPos),
      { x: 0, y: 0 },
      0,
      createInverterConfig(["sel"]),
      { clockPins: new Set<string>() },
      bitWidth,
    );
  }

  getBoundingBox(): Rect {
    // Triangle: x:[-0.95,0.95], y:[-0.6,0.6]
    // Circle at (0,-0.7) r=0.3 → y:[-1.0,-0.4] (extends below triangle)
    return {
      x: this.position.x - 0.95,
      y: this.position.y - 1.0,
      width: 1.9,
      height: 1.6,
    };
  }

  draw(ctx: RenderContext): void {
    const flipSelPos = this._properties.getOrDefault<boolean>("flipSelPos", false);

    ctx.save();

    // Triangle body (NORMAL — outline only, no fill per Java fixture)
    const triLeft = -0.95;
    const triRight = 0.95;
    const triHalf = 0.6;

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon(
      [
        { x: triLeft, y: -triHalf },
        { x: triRight, y: 0 },
        { x: triLeft, y: triHalf },
      ],
      false,
    );

    // Inversion bubble at (0, -0.7) for sel above, (0, +0.7) for sel below
    // Java fixture: single circle at (0,-0.7), radius=0.3, style=NORMAL
    const bubbleCy = flipSelPos ? 0.7 : -0.7;
    ctx.drawCircle(0, bubbleCy, 0.3, false);

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
  highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const dataIn = state[wt[inBase]];
  const sel = state[wt[inBase + 1]];
  const outNet = wt[outBase];

  if (sel === 0) {
    state[outNet] = dataIn;
    highZs[outNet] = 0;
  } else {
    state[outNet] = 0;
    highZs[outNet] = 0xFFFFFFFF;
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
  {
    xmlName: "flipSelPos",
    propertyKey: "flipSelPos",
    convert: (v) => v === "true",
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
  {
    key: "flipSelPos",
    type: PropertyType.BOOLEAN,
    label: "Flip Sel Position",
    defaultValue: false,
    description: "When true, the select pin is below the triangle instead of above",
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
  engineType: "both",
  factory: driverInvFactory,
  executeFn: executeDriverInvSel,
  pinLayout: buildDriverInvPinDeclarations(1),
  propertyDefs: DRIVER_INV_PROPERTY_DEFS,
  attributeMap: DRIVER_INV_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  inputSchema: ["in", "sel"],
  outputSchema: ["out"],
  helpText:
    "DriverInvSel — tri-state buffer with active-low enable.\n" +
    "When sel=0 (active-low): output = input.\n" +
    "When sel=1: output is high-impedance (disconnected).",
  analogFactory: createDriverInvAnalogElement,
  simulationModes: ["logical", "analog-pins"],
};
