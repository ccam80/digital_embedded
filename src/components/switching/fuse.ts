/**
 * Fuse — one-time irreversible switch.
 *
 * Initially closed (conducting). When the blown property is set to true the
 * fuse is permanently open (non-conducting) regardless of any other state.
 * There are no gate inputs — the state is determined entirely by the blown
 * property, which the engine writes to state[stBase] at compile time.
 *
 * Pins:
 *   Bidirectional: out1, out2
 *
 * internalStateCount: 1 (closedFlag, read by bus resolver)
 *
 * Ported from:
 *   ref/Digital/src/main/java/de/neemann/digital/core/switching/Fuse.java
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection, resolvePins, createInverterConfig } from "../../core/pin.js";
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
const COMP_HEIGHT = 1;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const FUSE_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "out1",
    defaultBitWidth: 1,
    position: { x: 0, y: COMP_HEIGHT / 2 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "out2",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: COMP_HEIGHT / 2 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// FuseElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class FuseElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _blown: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Fuse", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._blown = props.getOrDefault<boolean>("blown", false);
    this._pins = resolvePins(
      FUSE_PIN_DECLARATIONS,
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
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    const cy = COMP_HEIGHT / 2;

    // Left wire
    ctx.drawLine(0, cy, 0.5, cy);
    // Right wire
    ctx.drawLine(2.5, cy, COMP_WIDTH, cy);
    // Fuse body rectangle
    ctx.drawRect(0.5, cy - 0.3, 2.0, 0.6, false);

    if (this._blown) {
      // Blown: X mark inside the body
      ctx.setColor("WIRE_ERROR");
      ctx.drawLine(0.7, cy - 0.2, 1.3, cy + 0.2);
      ctx.drawLine(1.3, cy - 0.2, 0.7, cy + 0.2);
    } else {
      // Intact: wire through the middle
      ctx.drawLine(0.5, cy, 2.5, cy);
    }

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.4, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  get blown(): boolean {
    return this._blown;
  }

  getHelpText(): string {
    return (
      "Fuse — one-time irreversible switch.\n" +
      "Initially closed (conducting). When blown=true, permanently open.\n" +
      "Used in PLD/ROM arrays as a programmable disconnect."
    );
  }
}

// ---------------------------------------------------------------------------
// executeFuse — flat simulation function
//
// No gate inputs. The blown property is baked into state[stBase] by the
// engine at compile time: blown=false → state[stBase]=1 (closed);
// blown=true → state[stBase]=0 (open).
//
// At runtime this function simply preserves the compiled-in state.
// It is a no-op because the engine initialises the state slot correctly
// from the blown property and no runtime input can change it.
// ---------------------------------------------------------------------------

export function executeFuse(_index: number, _state: Uint32Array, _layout: ComponentLayout): void {
  // Blown state is set by the engine from the blown property at compile time.
  // No inputs to read; state[stBase] is already correct.
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const FUSE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "blown", propertyKey: "blown", convert: (v) => v === "true" },
];

const FUSE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the switched signal",
  },
  {
    key: "blown",
    type: PropertyType.BOOLEAN,
    label: "Blown",
    defaultValue: false,
    description: "When true, fuse is permanently open (non-conducting)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label",
  },
];

function fuseFactory(props: PropertyBag): FuseElement {
  return new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const FuseDefinition: ComponentDefinition = {
  name: "Fuse",
  typeId: -1,
  factory: fuseFactory,
  executeFn: executeFuse,
  pinLayout: FUSE_PIN_DECLARATIONS,
  propertyDefs: FUSE_PROPERTY_DEFS,
  attributeMap: FUSE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "Fuse — one-time irreversible switch. blown=false → closed; blown=true → permanently open.",
  defaultDelay: 0,
};
