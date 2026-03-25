/**
 * NFET — N-channel MOSFET voltage-controlled switch.
 *
 * Gate input G controls source-drain connection:
 *   G=1 → conducting (closed): D and S connected
 *   G=0 → non-conducting (open): D and S disconnected
 *
 * Pins:
 *   Input:        G  (gate, 1-bit)
 *   Bidirectional: D (drain), S (source)
 *
 * internalStateCount: 1 (closedFlag, read by bus resolver)
 *
 * Ported from:
 *   ref/Digital/src/main/java/de/neemann/digital/core/switching/NFET.java
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

// ---------------------------------------------------------------------------
// Layout type with stateOffset
// ---------------------------------------------------------------------------

export interface FETLayout extends ComponentLayout {
  stateOffset(componentIndex: number): number;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java FETShapeN: Gate at (1,1) right-center, Drain at (1,0) top-right, Source at (1,2) bottom-right
// Component spans x:[0,1], y:[0,2]
const COMP_WIDTH = 1;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const NFET_PIN_DECLARATIONS: PinDeclaration[] = [
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
// NFETElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class NFETElement extends AbstractCircuitElement {
  protected readonly _bitWidth: number;

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NFET", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(NFET_PIN_DECLARATIONS, []);
  }

  getBoundingBox(): Rect {
    // Gate oxide bar at x=0.05; drain/source leads reach x=1.0.
    // Width = 1.0 - 0.05 = 0.95.
    return { x: this.position.x + 0.05, y: this.position.y, width: 0.95, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Drain lead: (1,0) → (0.4,0) → (0.4,0.25)
    ctx.drawLine(1, 0, 0.4, 0);
    ctx.drawLine(0.4, 0, 0.4, 0.25);

    // Source lead: (1,2) → (0.4,2) → (0.4,1.75)
    ctx.drawLine(1, 2, 0.4, 2);
    ctx.drawLine(0.4, 2, 0.4, 1.75);

    // Channel gap line: (0.4,0.75) to (0.4,1.25)
    ctx.drawLine(0.4, 0.75, 0.4, 1.25);

    // Gate oxide bar: vertical line at x=0.05 from y=0 to y=2
    ctx.drawLine(0.05, 0, 0.05, 2);

    // Gate lead (THIN): (0.75,1) to (1,1) — connects channel to G pin at (1,1)
    ctx.drawLine(0.75, 1, 1, 1);

    // N-channel arrow (filled triangle): (0.6,1) → (0.85,0.9) → (0.85,1.1)
    ctx.drawPolygon([
      { x: 0.6, y: 1 },
      { x: 0.85, y: 0.9 },
      { x: 0.85, y: 1.1 },
    ], true);

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
      "NFET — N-channel MOSFET.\n" +
      "G=1: D and S are connected (conducting).\n" +
      "G=0: D and S are disconnected."
    );
  }
}

// ---------------------------------------------------------------------------
// executeNFET — flat simulation function
//
// Input layout: [G=0]
// State layout: [closedFlag=0]
// G=1 → closed=1; G=0 → closed=0
// ---------------------------------------------------------------------------

export function executeNFET(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);

  const gate = state[wt[inBase]!]! & 1;
  const closed = gate;
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

export const NFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

const NFET_PROPERTY_DEFS: PropertyDefinition[] = [
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

function nfetFactory(props: PropertyBag): NFETElement {
  return new NFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const NFETDefinition: ComponentDefinition = {
  name: "NFET",
  typeId: -1,
  factory: nfetFactory,
  pinLayout: NFET_PIN_DECLARATIONS,
  propertyDefs: NFET_PROPERTY_DEFS,
  attributeMap: NFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "NFET — N-channel MOSFET. G=1 → conducting.",
  models: {
    digital: {
      executeFn: executeNFET,
      inputSchema: ["G"],
      outputSchema: ["D", "S"],
      stateSlotCount: 1,
      switchPins: [1, 2],
      defaultDelay: 0,
    },
  },
};
