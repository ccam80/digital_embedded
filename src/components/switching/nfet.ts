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
// Layout type with stateOffset
// ---------------------------------------------------------------------------

export interface FETLayout extends ComponentLayout {
  stateOffset(componentIndex: number): number;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
const COMP_HEIGHT = 3;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const NFET_PIN_DECLARATIONS: PinDeclaration[] = [
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
// NFETElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class NFETElement extends AbstractCircuitElement {
  protected readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NFET", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._pins = resolvePins(
      NFET_PIN_DECLARATIONS,
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

    // Gate line (horizontal from left)
    ctx.drawLine(0, COMP_HEIGHT / 2, 1, COMP_HEIGHT / 2);
    // Gate bar (vertical)
    ctx.drawLine(1, 0.5, 1, COMP_HEIGHT - 0.5);
    // Channel line (vertical, offset from gate bar)
    ctx.drawLine(1.5, 0.5, 1.5, COMP_HEIGHT - 0.5);
    // Drain and source connections
    ctx.drawLine(1.5, 0.5, COMP_WIDTH, 0.5);
    ctx.drawLine(1.5, COMP_HEIGHT - 0.5, COMP_WIDTH, COMP_HEIGHT - 0.5);

    // N-channel arrow pointing inward (toward channel)
    ctx.drawLine(1.5, COMP_HEIGHT / 2, 1.9, COMP_HEIGHT / 2 - 0.3);
    ctx.drawLine(1.5, COMP_HEIGHT / 2, 1.9, COMP_HEIGHT / 2 + 0.3);

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

export function executeNFET(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);
  state[stBase] = state[inBase] & 1;
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
  executeFn: executeNFET,
  pinLayout: NFET_PIN_DECLARATIONS,
  propertyDefs: NFET_PROPERTY_DEFS,
  attributeMap: NFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "NFET — N-channel MOSFET. G=1 → conducting.",
  defaultDelay: 0,
};
