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
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { createDriverAnalogElement } from "../../solver/analog/behavioral-remaining.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/**
 * Driver dimensions in grid units.
 *
 * Java SIZE = 20px = 1 grid unit.  SIZE2 = 10px = 0.5 grid units.
 * Pin layout: input at (-1, 0), sel at (0, ±1), output at (1, 0).
 * Triangle from roughly (-1, -0.6) → (1, 0) → (-1, 0.6).
 * Component origin is at the center (where the sel pin stem meets the triangle).
 */
const COMP_WIDTH = 2;   // from input pin x=-1 to output pin x=1
const COMP_HEIGHT = 2;  // from sel pin y=-1 to y=+1 (or 0 to 2 with bottom sel)

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

/**
 * Pin positions match Java DriverShape: origin at centre of component.
 *
 * Java coords (pixels):  input(-20,0), sel(0,±20), output(20,0)
 * Grid units (/20):      input(-1,0),  sel(0,±1),  output(1,0)
 *
 * flipSelPos controls whether sel is above (default, y=-1) or below (y=+1).
 */
function buildDriverPinDeclarations(bitWidth: number, flipSelPos = false, invertOutput = false): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: bitWidth,
      position: { x: -1, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "sel",
      defaultBitWidth: 1,
      position: { x: 0, y: flipSelPos ? 1 : -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: bitWidth,
      position: { x: invertOutput ? 2 : 1, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// DriverElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DriverElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Driver", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const flipSelPos = this._properties.getOrDefault<boolean>("flipSelPos", false);
    const invertOutput = this._properties.getOrDefault<boolean>("invertDriverOutput", false);
    return this.derivePins(buildDriverPinDeclarations(bitWidth, flipSelPos, invertOutput), []);
  }

  getBoundingBox(): Rect {
    const invertOutput = this._properties.getOrDefault<boolean>("invertDriverOutput", false);
    const flipSelPos = this._properties.getOrDefault<boolean>("flipSelPos", false);
    // Triangle: (-0.95,-0.6) to (0.95,0.6). Sel stem extends to y=-1 or y=+1.
    // For invertOutput: bubble at (1.2,0) r=0.25 → maxX=1.45; output pin at x=2.
    const maxX = invertOutput ? 2 : 0.95;
    const selMinY = flipSelPos ? -0.6 : -1;
    const selMaxY = flipSelPos ? 1 : 0.6;
    const minY = Math.min(-0.6, selMinY);
    const maxY = Math.max(0.6, selMaxY);
    return {
      x: this.position.x - 0.95,
      y: this.position.y + minY,
      width: 0.95 + maxX,
      height: maxY - minY,
    };
  }

  draw(ctx: RenderContext): void {
    const flipSelPos = this._properties.getOrDefault<boolean>("flipSelPos", false);
    const invertOutput = this._properties.getOrDefault<boolean>("invertDriverOutput", false);

    ctx.save();

    // Triangle body pointing right, centred on origin.
    // Java: (-SIZE+1, -SIZE2-2) → (SIZE-1, 0) → (-SIZE+1, SIZE2+2)
    // Grid: (-0.95, -0.6)      → (0.95, 0)    → (-0.95, 0.6)
    const triLeft = -0.95;
    const triRight = 0.95;
    const triHalf = 0.6;

    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon(
      [
        { x: triLeft, y: -triHalf },
        { x: triRight, y: 0 },
        { x: triLeft, y: triHalf },
      ],
      true,
    );
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

    if (invertOutput) {
      ctx.setColor("COMPONENT");
      ctx.drawCircle(1.2, 0, 0.25, false);
    }

    // Sel pin stem: line from centre to sel pin
    const selY = flipSelPos ? 1 : -1;
    ctx.drawLine(0, selY, 0, selY > 0 ? 0.35 : -0.35);

    ctx.restore();
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

export function executeDriver(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const dataIn = state[wt[inBase]];
  const sel = state[wt[inBase + 1]];
  const outNet = wt[outBase];

  if (sel !== 0) {
    state[outNet] = dataIn;
    highZs[outNet] = 0;
  } else {
    state[outNet] = 0;
    highZs[outNet] = 0xFFFFFFFF;
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
  {
    xmlName: "flipSelPos",
    propertyKey: "flipSelPos",
    convert: (v) => v === "true",
  },
  {
    xmlName: "invertDriverOutput",
    propertyKey: "invertDriverOutput",
    convert: (v) => v === "true",
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
  {
    key: "flipSelPos",
    type: PropertyType.BOOLEAN,
    label: "Flip Sel Position",
    defaultValue: false,
    description: "When true, the select pin is below the triangle instead of above",
  },
  {
    key: "invertDriverOutput",
    type: PropertyType.BOOLEAN,
    label: "Invert Output",
    defaultValue: false,
    description: "When true, adds an inversion bubble and shifts output pin to x=2",
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
  pinLayout: buildDriverPinDeclarations(1),
  propertyDefs: DRIVER_PROPERTY_DEFS,
  attributeMap: DRIVER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Driver — tri-state buffer.\n" +
    "When sel=1: output = input.\n" +
    "When sel=0: output is high-impedance (disconnected).",
  models: {
    digital: {
      executeFn: executeDriver,
      inputSchema: ["in", "sel"],
      outputSchema: ["out"],
    },
  },
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createDriverAnalogElement,
      paramDefs: [],
      params: {},
    },
  },
  defaultModel: "digital",
};
