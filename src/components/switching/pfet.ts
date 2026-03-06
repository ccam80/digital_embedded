/**
 * PFET — P-channel MOSFET voltage-controlled switch.
 *
 * Gate input G controls source-drain connection (inverted logic vs NFET):
 *   G=0 → conducting (closed): S and D connected
 *   G=1 → non-conducting (open): S and D disconnected
 *
 * Pins:
 *   Input:         G  (gate, 1-bit)
 *   Bidirectional: S (source), D (drain)
 *
 * internalStateCount: 1 (closedFlag, read by bus resolver)
 *
 * Ported from:
 *   ref/Digital/src/main/java/de/neemann/digital/core/switching/PFET.java
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
import type { FETLayout } from "./nfet.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
const COMP_HEIGHT = 3;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const PFET_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "G",
    defaultBitWidth: 1,
    position: { x: 0, y: COMP_HEIGHT / 2 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "S",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "D",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: COMP_HEIGHT },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// PFETElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PFETElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PFET", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._pins = resolvePins(
      PFET_PIN_DECLARATIONS,
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

    // Gate line
    ctx.drawLine(0, COMP_HEIGHT / 2, 1, COMP_HEIGHT / 2);
    // Gate bar
    ctx.drawLine(1, 0.5, 1, COMP_HEIGHT - 0.5);
    // Channel line
    ctx.drawLine(1.5, 0.5, 1.5, COMP_HEIGHT - 0.5);
    // Source and drain connections
    ctx.drawLine(1.5, 0.5, COMP_WIDTH, 0.5);
    ctx.drawLine(1.5, COMP_HEIGHT - 0.5, COMP_WIDTH, COMP_HEIGHT - 0.5);

    // P-channel arrow pointing outward (away from channel)
    ctx.drawLine(1.9, COMP_HEIGHT / 2, 1.5, COMP_HEIGHT / 2 - 0.3);
    ctx.drawLine(1.9, COMP_HEIGHT / 2, 1.5, COMP_HEIGHT / 2 + 0.3);

    // Inversion bubble on gate (P-channel)
    ctx.drawCircle(0.8, COMP_HEIGHT / 2, 0.15, false);

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.4, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "PFET — P-channel MOSFET.\n" +
      "G=0: S and D are connected (conducting).\n" +
      "G=1: S and D are disconnected."
    );
  }
}

// ---------------------------------------------------------------------------
// executePFET — flat simulation function
//
// G=0 → closed=1; G=1 → closed=0 (inverted compared to NFET)
// ---------------------------------------------------------------------------

export function executePFET(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);
  state[stBase] = (state[inBase] & 1) ^ 1; // invert gate signal
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const PFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

const PFET_PROPERTY_DEFS: PropertyDefinition[] = [
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
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label",
  },
];

function pfetFactory(props: PropertyBag): PFETElement {
  return new PFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PFETDefinition: ComponentDefinition = {
  name: "PFET",
  typeId: -1,
  factory: pfetFactory,
  executeFn: executePFET,
  pinLayout: PFET_PIN_DECLARATIONS,
  propertyDefs: PFET_PROPERTY_DEFS,
  attributeMap: PFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "PFET — P-channel MOSFET. G=0 → conducting.",
  defaultDelay: 0,
};
