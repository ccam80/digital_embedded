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

// Java FETShapeN: Gate at (0,SIZE*2)=(0,2), Drain at (SIZE,0)=(1,0), Source at (SIZE,SIZE*2)=(1,2)
const COMP_WIDTH = 1;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const FGNFET_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "G",
    defaultBitWidth: 1,
    position: { x: 0, y: 2 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "D",
    defaultBitWidth: 1,
    position: { x: 1, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "S",
    defaultBitWidth: 1,
    position: { x: 1, y: 2 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// FGNFETElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class FGNFETElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("FGNFET", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(FGNFET_PIN_DECLARATIONS, []);
  }

  getBoundingBox(): Rect {
    // Drawn geometry: oxide bar at x=0.05 (min), gate lead to x=1.15 (max).
    // Arrow tip at x=0.75, base at x=1.0. Drain/source leads at x=1.
    // Height: y=0 to y=2.
    return { x: this.position.x + 0.05, y: this.position.y, width: 1.1, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    const blown = this._properties.getOrDefault<boolean>("blown", false);

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Drain lead: (1,0) → (0.55,0) → (0.55,0.25)
    ctx.drawLine(1, 0, 0.55, 0);
    ctx.drawLine(0.55, 0, 0.55, 0.25);

    // Source lead: (1,2) → (0.55,2) → (0.55,1.75)
    ctx.drawLine(1, 2, 0.55, 2);
    ctx.drawLine(0.55, 2, 0.55, 1.75);

    // Channel gap line: (0.55,0.75) to (0.55,1.25)
    ctx.drawLine(0.55, 0.75, 0.55, 1.25);

    // Gate oxide bar: vertical line at x=0.05 from y=0 to y=2
    ctx.drawLine(0.05, 0, 0.05, 2);

    // Floating gate bar (THIN): (0.3,1.8) to (0.3,0.2)
    ctx.setLineWidth(0.5);
    ctx.drawLine(0.3, 1.8, 0.3, 0.2);

    // Gate lead (THIN): (0.9,1) to (1.15,1) — extends to x=1.15 per Java fixture
    ctx.drawLine(0.9, 1, 1.15, 1);

    // N-channel arrow (THIN_FILLED): tip at (0.75,1), base at (1,0.9)→(1,1.1)
    ctx.drawPolygon([
      { x: 0.75, y: 1 },
      { x: 1, y: 0.9 },
      { x: 1, y: 1.1 },
    ], true);
    ctx.setLineWidth(1);

    // Blown indicator: X mark
    if (blown) {
      ctx.setColor("WIRE_ERROR");
      ctx.drawLine(0.5, 0.5, 1.0, 1.0);
      ctx.drawLine(1.0, 0.5, 0.5, 1.0);
    }

    const label = this._visibleLabel();
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

export function executeFGNFET(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);

  const gate = state[wt[inBase]!]! & 1;
  const blown = state[stBase + 1]! & 1;
  const closed = blown ? 0 : gate;
  state[stBase] = closed;

  const classification = layout.getSwitchClassification?.(index) ?? 1;
  if (classification !== 2) {
    const drainNet = wt[outBase]!;
    const sourceNet = wt[outBase + 1]!;
    if (closed) {
      state[sourceNet] = state[drainNet]!;
      highZs[sourceNet] = 0;
    } else {
      highZs[sourceNet] = 0xffffffff;
    }
  }
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
  pinLayout: FGNFET_PIN_DECLARATIONS,
  propertyDefs: FGNFET_PROPERTY_DEFS,
  attributeMap: FGNFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "FGNFET — N-channel floating-gate MOSFET. Programmed (blown) gate permanently disables conduction.",
  models: {
    digital: {
      executeFn: executeFGNFET,
      inputSchema: ["G"],
      outputSchema: ["D", "S"],
      stateSlotCount: 2,
      switchPins: [1, 2],
      defaultDelay: 0,
    },
  },
};
