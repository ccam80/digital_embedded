/**
 * DipSwitch component — multi-bit toggle switch array.
 *
 * Each bit of the output is independently toggled by the user.
 * The executeFn is a no-op; each bit's value is set externally
 * via engine.setSignalValue() when the user clicks a bit toggle.
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

const BIT_WIDTH_PX = 1;
const COMP_HEIGHT = 2;

function componentWidth(bitCount: number): number {
  return Math.max(bitCount * BIT_WIDTH_PX, 2);
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildDipSwitchPinDeclarations(bitCount: number): PinDeclaration[] {
  const w = componentWidth(bitCount);
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: bitCount,
      position: { x: w, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// DipSwitchElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DipSwitchElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("DipSwitch", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitCount = this._properties.getOrDefault<number>("bitCount", 1);
    const decls = buildDipSwitchPinDeclarations(bitCount);
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    const bitCount = this._properties.getOrDefault<number>("bitCount", 1);
    const w = componentWidth(bitCount);
    return {
      x: this.position.x,
      y: this.position.y - COMP_HEIGHT / 2,
      width: w,
      height: COMP_HEIGHT,
    };
  }

  get bitCount(): number {
    return this._properties.getOrDefault<number>("bitCount", 1);
  }

  get defaultValue(): number {
    return this._properties.getOrDefault<number>("defaultValue", 0);
  }

  draw(ctx: RenderContext): void {
    const bitCount = this._properties.getOrDefault<number>("bitCount", 1);
    const defaultValue = this._properties.getOrDefault<number>("defaultValue", 0);
    const label = this._properties.getOrDefault<string>("label", "");
    const w = componentWidth(bitCount);
    const yOff = -COMP_HEIGHT / 2;

    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, yOff, w, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, yOff, w, COMP_HEIGHT, false);

    // Draw individual switch slots — one per bit
    for (let i = 0; i < bitCount; i++) {
      const slotX = i * BIT_WIDTH_PX + 0.15;
      const slotW = BIT_WIDTH_PX - 0.3;
      const bitOn = ((defaultValue >>> i) & 1) === 1;

      ctx.setColor("COMPONENT");
      ctx.drawRect(slotX, yOff + 0.2, slotW, COMP_HEIGHT - 0.4, false);

      if (bitOn) {
        // Switch paddle in upper position (ON)
        ctx.setColor("COMPONENT_FILL");
        ctx.drawRect(slotX + 0.05, yOff + 0.25, slotW - 0.1, (COMP_HEIGHT - 0.5) / 2, true);
        ctx.setColor("COMPONENT");
        ctx.drawRect(slotX + 0.05, yOff + 0.25, slotW - 0.1, (COMP_HEIGHT - 0.5) / 2, false);
      } else {
        // Switch paddle in lower position (OFF)
        const halfH = (COMP_HEIGHT - 0.5) / 2;
        ctx.setColor("COMPONENT_FILL");
        ctx.drawRect(slotX + 0.05, yOff + 0.25 + halfH, slotW - 0.1, halfH, true);
        ctx.setColor("COMPONENT");
        ctx.drawRect(slotX + 0.05, yOff + 0.25 + halfH, slotW - 0.1, halfH, false);
      }
    }

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, w / 2, yOff - 0.3, {
        horizontal: "center",
        vertical: "bottom",
      });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "DipSwitch — multi-bit toggle switch array.\n" +
      "Each bit is independently toggled by clicking the corresponding switch position.\n" +
      "The bitCount property controls how many individual switches are shown.\n" +
      "Interactive: the engine sets each bit's value when the user clicks."
    );
  }
}

// ---------------------------------------------------------------------------
// executeDipSwitch — no-op (value set externally per-bit by engine)
// ---------------------------------------------------------------------------

export function executeDipSwitch(
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {
  // Output value is set externally via engine.setSignalValue() on click events.
}

// ---------------------------------------------------------------------------
// DIP_SWITCH_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const DIP_SWITCH_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Bits",
    propertyKey: "bitCount",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Default",
    propertyKey: "defaultValue",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const DIP_SWITCH_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown above the switch array",
  },
  {
    key: "bitCount",
    type: PropertyType.INT,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Number of individual switches (bits)",
  },
  {
    key: "defaultValue",
    type: PropertyType.INT,
    label: "Default",
    defaultValue: 0,
    description: "Initial bit pattern when simulation starts",
  },
];

// ---------------------------------------------------------------------------
// DipSwitchDefinition
// ---------------------------------------------------------------------------

function dipSwitchFactory(props: PropertyBag): DipSwitchElement {
  return new DipSwitchElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DipSwitchDefinition: ComponentDefinition = {
  name: "DipSwitch",
  typeId: -1,
  factory: dipSwitchFactory,
  executeFn: executeDipSwitch,
  pinLayout: buildDipSwitchPinDeclarations(1),
  propertyDefs: DIP_SWITCH_PROPERTY_DEFS,
  attributeMap: DIP_SWITCH_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "DipSwitch — multi-bit toggle switch array.\n" +
    "Each bit is independently toggled by clicking the corresponding switch position.\n" +
    "The bitCount property controls how many individual switches are shown.\n" +
    "Interactive: the engine sets each bit's value when the user clicks.",
};
