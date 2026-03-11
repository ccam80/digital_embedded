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

/** Java FETShapeP: Gate at (0,0), Drain at (SIZE,0), Source at (SIZE, SIZE*2).
 *  SIZE = 20px = 1 grid unit. So width = 1, height = 2. */
const COMP_WIDTH = 1;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

/**
 * Java FETShapeP.getPins():
 *   Gate  at (0, 0)        — input[0]
 *   Drain at (SIZE, 0)     — output[0]  (1, 0) in grid
 *   Source at (SIZE, SIZE*2) — output[1]  (1, 2) in grid
 */
const PFET_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "G",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
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
    // Java FETShapeP: SIZE=1 grid, SIZE2=0.5 grid
    // Gate at (0, 0), vertical body from y=0 to y=2 (SIZE*2)
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Gate line: from gate pin (0,0) to gate bar
    ctx.drawLine(0, 0, 0.4, 0);
    // Gate bar (vertical insulator)
    ctx.drawLine(0.4, 0.4, 0.4, 1.6);
    // Channel line (parallel to gate bar, on drain/source side)
    ctx.drawLine(0.6, 0.4, 0.6, 1.6);
    // Drain connection: from channel to drain pin (1, 0)
    ctx.drawLine(0.6, 0.4, 1, 0.4);
    ctx.drawLine(1, 0.4, 1, 0);
    // Source connection: from channel to source pin (1, 2)
    ctx.drawLine(0.6, 1.6, 1, 1.6);
    ctx.drawLine(1, 1.6, 1, 2);

    // P-channel arrow (pointing from channel toward gate)
    ctx.drawLine(0.4, 1, 0.6, 1 - 0.15);
    ctx.drawLine(0.4, 1, 0.6, 1 + 0.15);

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.6 });
      ctx.drawText(label, 0.5, -0.3, { horizontal: "center", vertical: "bottom" });
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

export function executePFET(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);

  const gate = state[wt[inBase]!]! & 1;
  const closed = gate ^ 1;
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
  stateSlotCount: 1,
  defaultDelay: 0,
  switchPins: [1, 2],
};
