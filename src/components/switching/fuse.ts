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
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { createAnalogFuseElement } from "../passives/analog-fuse.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java FuseShape: out1(0,0), out2(SIZE,0)=(1,0); SIZE=1 grid unit
const COMP_WIDTH = 1;
const COMP_HEIGHT = 1;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const FUSE_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "out1",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "out2",
    defaultBitWidth: 1,
    position: { x: 1, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// FuseElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class FuseElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Fuse", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(FUSE_PIN_DECLARATIONS, []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 0.25, width: COMP_WIDTH, height: 0.5 };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Wavy S-curve from pin at (0,0) to pin at (1,0).
    // Java FuseShape: M(0,0) C(0.25,-0.25) C(0.5,0) C(0.75,0.25) C(1,0)
    // Each CurveTo in Java takes one control point and one end point (quadratic-style),
    // but Digital's Polygon.CurveTo maps to a cubic bezier with symmetric control points.
    // Translating the 4 cubic segments:
    //   Seg 1: (0,0) -> (0.25,-0.25): cp1=(0.1,-0.25) cp2=(0.15,-0.25)
    //   Seg 2: (0.25,-0.25) -> (0.5,0): cp1=(0.35,-0.25) cp2=(0.4,0)
    //   Seg 3: (0.5,0) -> (0.75,0.25): cp1=(0.6,0) cp2=(0.65,0.25)
    //   Seg 4: (0.75,0.25) -> (1,0): cp1=(0.85,0.25) cp2=(0.9,0)
    // Using the SVG path from Java fixture (pixel scale 20px = 1 grid unit):
    // "M 0,0 C 2,-5 3,-5 5,-5 C 8,-5 8,0 10,0 C 12,0 12,5 15,5 C 18,5 18,0 20,0"
    // Dividing by 20: cp1=(0.1,-0.25) cp2=(0.15,-0.25) end=(0.25,-0.25)
    //                 cp1=(0.4,-0.25) cp2=(0.4,0)       end=(0.5,0)
    //                 cp1=(0.6,0)     cp2=(0.6,0.25)    end=(0.75,0.25)
    //                 cp1=(0.9,0.25)  cp2=(0.9,0)       end=(1,0)
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0, y: 0 },
        { op: "curveTo", cp1x: 0.1, cp1y: -0.25, cp2x: 0.15, cp2y: -0.25, x: 0.25, y: -0.25 },
        { op: "curveTo", cp1x: 0.4, cp1y: -0.25, cp2x: 0.4,  cp2y: 0,     x: 0.5,  y: 0 },
        { op: "curveTo", cp1x: 0.6, cp1y: 0,     cp2x: 0.6,  cp2y: 0.25,  x: 0.75, y: 0.25 },
        { op: "curveTo", cp1x: 0.9, cp1y: 0.25,  cp2x: 0.9,  cp2y: 0,     x: 1,    y: 0 },
      ],
    });

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

export function executeFuse(_index: number, _state: Uint32Array, _highZs: Uint32Array, _layout: ComponentLayout): void {
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
  engineType: "both",
  factory: fuseFactory,
  executeFn: executeFuse,
  pinLayout: FUSE_PIN_DECLARATIONS,
  propertyDefs: FUSE_PROPERTY_DEFS,
  attributeMap: FUSE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "Fuse — one-time irreversible switch. blown=false → closed; blown=true → permanently open.",
  defaultDelay: 0,
  analogFactory: createAnalogFuseElement,
};
