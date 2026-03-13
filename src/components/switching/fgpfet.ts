/**
 * FGPFET — P-channel floating-gate MOSFET.
 *
 * Behaves like PFET (G=0 → conducting) except when the floating gate is
 * "programmed" (blown=true). A programmed FGPFET is permanently non-conducting
 * regardless of gate input.
 *
 * Pins:
 *   Input:         G  (gate, 1-bit)
 *   Bidirectional: S (source), D (drain)
 *
 * internalStateCount: 2 (closedFlag=0, blownFlag=1)
 *
 * Ported from:
 *   ref/Digital/src/main/java/de/neemann/digital/core/switching/FGPFET.java
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
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

const FGPFET_PIN_DECLARATIONS: PinDeclaration[] = [
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
// FGPFETElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class FGPFETElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("FGPFET", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(FGPFET_PIN_DECLARATIONS, []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    const blown = this._properties.getOrDefault<boolean>("blown", false);

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Gate line and bars (same as PFET with floating gate indicator)
    ctx.drawLine(0, COMP_HEIGHT / 2, 0.65, COMP_HEIGHT / 2);
    // Inversion bubble on gate
    ctx.drawCircle(0.8, COMP_HEIGHT / 2, 0.15, false);
    ctx.drawLine(0.95, COMP_HEIGHT / 2, 1, COMP_HEIGHT / 2);
    // Gate bar
    ctx.drawLine(1, 0.5, 1, COMP_HEIGHT - 0.5);
    // Floating gate bar
    ctx.drawLine(1.25, 0.5, 1.25, COMP_HEIGHT - 0.5);
    // Channel line
    ctx.drawLine(1.5, 0.5, 1.5, COMP_HEIGHT - 0.5);
    // Source and drain connections
    ctx.drawLine(1.5, 0.5, COMP_WIDTH, 0.5);
    ctx.drawLine(1.5, COMP_HEIGHT - 0.5, COMP_WIDTH, COMP_HEIGHT - 0.5);

    // P-channel arrow (outward)
    ctx.drawLine(1.9, COMP_HEIGHT / 2, 1.5, COMP_HEIGHT / 2 - 0.3);
    ctx.drawLine(1.9, COMP_HEIGHT / 2, 1.5, COMP_HEIGHT / 2 + 0.3);

    // Blown indicator
    if (blown) {
      ctx.setColor("WIRE_ERROR");
      ctx.drawLine(0.5, 0.5, 1.0, 1.0);
      ctx.drawLine(1.0, 0.5, 0.5, 1.0);
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
    return this._properties.getOrDefault<boolean>("blown", false);
  }

  getHelpText(): string {
    return (
      "FGPFET — P-channel floating-gate MOSFET.\n" +
      "G=0: S and D connected (conducting), unless floating gate is programmed.\n" +
      "When blown=true: permanently non-conducting regardless of gate input.\n" +
      "Used in PLD arrays as a programmable switch."
    );
  }
}

// ---------------------------------------------------------------------------
// executeFGPFET — flat simulation function
//
// G=0 and not blown → closed=1; else closed=0
// State layout: [closedFlag=0, blownFlag=1]
// ---------------------------------------------------------------------------

export function executeFGPFET(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);

  const gate = state[wt[inBase]!]! & 1;
  const blown = state[stBase + 1]! & 1;
  const closed = blown ? 0 : (gate ^ 1);
  state[stBase] = closed;

  const classification = layout.getSwitchClassification?.(index) ?? 1;
  if (classification !== 2) {
    const sourceNet = wt[outBase]!;
    const drainNet = wt[outBase + 1]!;
    if (closed) {
      state[drainNet] = state[sourceNet]!;
      highZs[drainNet] = 0;
    } else {
      highZs[drainNet] = 0xffffffff;
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const FGPFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "blown", propertyKey: "blown", convert: (v) => v === "true" },
];

const FGPFET_PROPERTY_DEFS: PropertyDefinition[] = [
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
    description: "When true, floating gate is programmed — FET is permanently non-conducting",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label",
  },
];

function fgpfetFactory(props: PropertyBag): FGPFETElement {
  return new FGPFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const FGPFETDefinition: ComponentDefinition = {
  name: "FGPFET",
  typeId: -1,
  factory: fgpfetFactory,
  executeFn: executeFGPFET,
  pinLayout: FGPFET_PIN_DECLARATIONS,
  propertyDefs: FGPFET_PROPERTY_DEFS,
  attributeMap: FGPFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "FGPFET — P-channel floating-gate MOSFET. Programmed (blown) gate permanently disables conduction.",
  stateSlotCount: 2,
  defaultDelay: 0,
  switchPins: [1, 2],
};
