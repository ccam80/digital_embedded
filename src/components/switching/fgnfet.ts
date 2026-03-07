/**
 * FGNFET — N-channel floating-gate MOSFET.
 *
 * Behaves like NFET (G=1 → conducting) except when the floating gate is
 * "programmed" (blown=true). A programmed FGNFET is permanently non-conducting
 * regardless of the gate input — it acts as a one-time programmable fuse-like
 * element used in PLD/ROM arrays.
 *
 * Pins:
 *   Input:         G  (gate, 1-bit)
 *   Bidirectional: D (drain), S (source)
 *
 * internalStateCount: 1 (closedFlag, read by bus resolver)
 *
 * Ported from:
 *   ref/Digital/src/main/java/de/neemann/digital/core/switching/FGNFET.java
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

const FGNFET_PIN_DECLARATIONS: PinDeclaration[] = [
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
    label: "D",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "S",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: COMP_HEIGHT },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// FGNFETElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class FGNFETElement extends AbstractCircuitElement {
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
    super("FGNFET", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._blown = props.getOrDefault<boolean>("blown", false);
    this._pins = resolvePins(
      FGNFET_PIN_DECLARATIONS,
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

    // Gate line and bar (same as NFET)
    ctx.drawLine(0, COMP_HEIGHT / 2, 1, COMP_HEIGHT / 2);
    ctx.drawLine(1, 0.5, 1, COMP_HEIGHT - 0.5);
    // Floating gate bar (second bar to indicate floating gate)
    ctx.drawLine(1.25, 0.5, 1.25, COMP_HEIGHT - 0.5);
    // Channel line
    ctx.drawLine(1.5, 0.5, 1.5, COMP_HEIGHT - 0.5);
    // Drain and source connections
    ctx.drawLine(1.5, 0.5, COMP_WIDTH, 0.5);
    ctx.drawLine(1.5, COMP_HEIGHT - 0.5, COMP_WIDTH, COMP_HEIGHT - 0.5);

    // N-channel arrow
    ctx.drawLine(1.5, COMP_HEIGHT / 2, 1.9, COMP_HEIGHT / 2 - 0.3);
    ctx.drawLine(1.5, COMP_HEIGHT / 2, 1.9, COMP_HEIGHT / 2 + 0.3);

    // Blown indicator: X mark
    if (this._blown) {
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
    return this._blown;
  }

  getHelpText(): string {
    return (
      "FGNFET — N-channel floating-gate MOSFET.\n" +
      "G=1: D and S connected (conducting), unless floating gate is programmed.\n" +
      "When blown=true: permanently non-conducting regardless of gate input.\n" +
      "Used in PLD arrays as a programmable switch."
    );
  }
}

// ---------------------------------------------------------------------------
// executeFGNFET — flat simulation function
//
// G=1 and not blown → closed=1; else closed=0
// The blown flag is baked into propertyDefs; not available here directly.
// The engine reads blown from component properties during compilation and
// writes it to state[stBase + 1]. We read it from there.
//
// State layout: [closedFlag=0, blownFlag=1]
// ---------------------------------------------------------------------------

export function executeFGNFET(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);

  const gate = state[wt[inBase]] & 1;
  const blown = state[stBase + 1] & 1;

  state[stBase] = blown ? 0 : gate;
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const FGNFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "blown", propertyKey: "blown", convert: (v) => v === "true" },
];

const FGNFET_PROPERTY_DEFS: PropertyDefinition[] = [
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

function fgnfetFactory(props: PropertyBag): FGNFETElement {
  return new FGNFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const FGNFETDefinition: ComponentDefinition = {
  name: "FGNFET",
  typeId: -1,
  factory: fgnfetFactory,
  executeFn: executeFGNFET,
  pinLayout: FGNFET_PIN_DECLARATIONS,
  propertyDefs: FGNFET_PROPERTY_DEFS,
  attributeMap: FGNFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "FGNFET — N-channel floating-gate MOSFET. Programmed (blown) gate permanently disables conduction.",
  stateSlotCount: 2,
  defaultDelay: 0,
};
