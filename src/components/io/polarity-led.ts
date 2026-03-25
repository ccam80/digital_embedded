/**
 * PolarityAwareLED component — LED with anode/cathode orientation.
 *
 * Lights up when anode input is high AND cathode input is low.
 * Considers signal polarity: current flows from anode to cathode.
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
// ---------------------------------------------------------------------------

// Component spans x:[-0.5,0.5] (centered on x=0), y:[0,4]
// Pins: A at (0,0), K at (0,4)
const COMP_WIDTH = 1;
const COMP_HEIGHT = 4;

// ---------------------------------------------------------------------------
// Pin layout — anode on west, cathode on east
// ---------------------------------------------------------------------------

// Java PolarityAwareLEDShape: A(0,0), K(0,SIZE*4)=(0,4)
function buildPolarityLedPinDeclarations(): PinDeclaration[] {
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
      direction: PinDirection.INPUT,
      label: "K",
      defaultBitWidth: 1,
      position: { x: 0, y: 4 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// PolarityLedElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PolarityLedElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PolarityAwareLED", instanceId, position, rotation, mirror, props);
  }

  get color(): string {
    return this._properties.getOrDefault<string>("color", "red");
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildPolarityLedPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Light rays extend to x=1.35 on the right side.
    // Body spans x: -0.5 to 0.5, rays add to x=1.35, total width = 1.35 - (-0.5) = 1.85.
    return {
      x: this.position.x - 0.5,
      y: this.position.y,
      width: 1.85,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    // Java PolarityAwareLEDShape fixture (grid units, origin at pin A=(0,0)):
    // LED indicator box (closed): (-0.35,3.45)->(-0.35,2.2)->(0.35,2.2)->(0.35,3.45)
    // Lead to K:                  (0,3.5) to (0,4)   [3.45->3.5 gap then to pin]
    // Diode triangle (closed):    (-0.5,0.55)->(0.5,0.55)->(0,1.45)
    // Cathode bar:                (-0.5,1.45) to (0.5,1.45)
    // Stem:                       (0,1.45) to (0,2.2)
    // Lead from A:                (0,0) to (0,0.45)
    // Light rays (THIN): 6 short angled lines at top-right
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Lead from A pin down to diode
    ctx.drawLine(0, 0, 0, 0.45);
    // Diode triangle (filled), pointing down
    ctx.drawPolygon([{ x: -0.5, y: 0.55 }, { x: 0.5, y: 0.55 }, { x: 0, y: 1.45 }], true);
    // Cathode bar
    ctx.drawLine(-0.5, 1.45, 0.5, 1.45);
    // Stem from cathode bar to LED box
    ctx.drawLine(0, 1.45, 0, 2.2);
    // LED indicator box (outline only)
    ctx.drawPolygon(
      [{ x: -0.35, y: 2.2 }, { x: 0.35, y: 2.2 }, { x: 0.35, y: 3.45 }, { x: -0.35, y: 3.45 }],
      false
    );
    // Lead from LED box to K pin
    ctx.drawLine(0, 3.45, 0, 4);

    // Light ray lines (THIN style)
    ctx.setLineWidth(0.5);
    ctx.drawLine(1, 0.6, 0.55, 1.05);
    ctx.drawLine(0.9, 0.55, 1.05, 0.55);
    ctx.drawLine(1.05, 0.7, 1.05, 0.55);
    ctx.drawLine(1.3, 0.9, 0.85, 1.35);
    ctx.drawLine(1.2, 0.85, 1.35, 0.85);
    ctx.drawLine(1.35, 1, 1.35, 0.85);
    ctx.setLineWidth(1);

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 0, -0.3, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "PolarityAwareLED — LED that considers anode/cathode orientation.\n" +
      "Lights up when anode is high AND cathode is low (current flows anode→cathode).\n" +
      "Color is configurable."
    );
  }
}

// ---------------------------------------------------------------------------
// executePolarityLed — anode=1 and cathode=0 → lit
// ---------------------------------------------------------------------------

export function executePolarityLed(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const anode = state[wt[inputStart]];
  const cathode = state[wt[inputStart + 1]];
  // Lit when anode is high and cathode is low
  state[wt[layout.outputOffset(index)]] = anode !== 0 && cathode === 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// POLARITY_LED_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const POLARITY_LED_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Color",
    propertyKey: "color",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const POLARITY_LED_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown above the LED",
  },
  {
    key: "color",
    type: PropertyType.COLOR,
    label: "Color",
    defaultValue: "red",
    description: "LED color when lit",
  },
];

// ---------------------------------------------------------------------------
// PolarityLedDefinition
// ---------------------------------------------------------------------------

function polarityLedFactory(props: PropertyBag): PolarityLedElement {
  return new PolarityLedElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PolarityLedDefinition: ComponentDefinition = {
  name: "PolarityAwareLED",
  typeId: -1,
  factory: polarityLedFactory,
  pinLayout: buildPolarityLedPinDeclarations(),
  propertyDefs: POLARITY_LED_PROPERTY_DEFS,
  attributeMap: POLARITY_LED_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "PolarityAwareLED — LED that considers anode/cathode orientation.\n" +
    "Lights up when anode is high AND cathode is low (current flows anode→cathode).\n" +
    "Color is configurable.",
  models: {
    digital: { executeFn: executePolarityLed, inputSchema: ["A", "K"], outputSchema: [] },
  },
};
