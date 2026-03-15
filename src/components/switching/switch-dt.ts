/**
 * SwitchDT component — SPDT switch with mechanical symbol rendering.
 *
 * Double-throw switch: three terminals per pole (A=common, B=upper, C=lower).
 * When closed=true: A-B are connected, A-C are disconnected.
 * When closed=false: A-B are disconnected, A-C are connected.
 *
 * Differs from PlainSwitchDT only in visual rendering (uses the same
 * mechanical-symbol style as Switch for the contact lines, with the
 * additional DT stub shown by SwitchDTShape.java).
 *
 * Pattern follows the And gate exemplar exactly.
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
// Layout constants
// ---------------------------------------------------------------------------

/** Component width in grid units. */
const COMP_WIDTH = 2;

/** Vertical spacing between poles in grid units. */
const POLE_HEIGHT = 2;

/** Vertical offset for C pin (lower contact) relative to pole base. */
const C_OFFSET = 1;

function componentHeight(poles: number): number {
  return Math.max(poles * POLE_HEIGHT + C_OFFSET, 3);
}

// ---------------------------------------------------------------------------
// Pin layout helpers
// ---------------------------------------------------------------------------

function buildPinDeclarations(poles: number, bitWidth: number): PinDeclaration[] {
  const decls: PinDeclaration[] = [];
  for (let p = 0; p < poles; p++) {
    const yBase = p * POLE_HEIGHT;
    // A: common terminal (left)
    decls.push({
      direction: PinDirection.BIDIRECTIONAL,
      label: `A${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: 0, y: yBase },
      isNegatable: false,
      isClockCapable: false,
    });
    // B: upper-right contact
    decls.push({
      direction: PinDirection.BIDIRECTIONAL,
      label: `B${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: COMP_WIDTH, y: yBase },
      isNegatable: false,
      isClockCapable: false,
    });
    // C: lower-right contact (C_OFFSET below B)
    decls.push({
      direction: PinDirection.BIDIRECTIONAL,
      label: `C${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: COMP_WIDTH, y: yBase + C_OFFSET },
      isNegatable: false,
      isClockCapable: false,
    });
  }
  return decls;
}

// ---------------------------------------------------------------------------
// SwitchDTElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class SwitchDTElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SwitchDT", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const poles = this._properties.getOrDefault<number>("poles", 1);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(buildPinDeclarations(poles), []);
  }

  getBoundingBox(): Rect {
    const poles = this._properties.getOrDefault<number>("poles", 1);
    const h = componentHeight(poles);
    // Thin bar at (0.5,-0.75)→(1.5,-0.75); contact arm to (1.8,0.5); pole stub to (2,1).
    // MinX=0, MaxX=2, MinY=-0.75, MaxY=max(h, 1).
    return {
      x: this.position.x,
      y: this.position.y - 0.75,
      width: COMP_WIDTH,
      height: Math.max(h, 1) + 0.75,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Pole stub (open L): (2,1) → (1.75,1) → (1.75,0.6) — use drawPath so the
    // rasterizer treats it as an open polyline matching the Java fixture (closed=false).
    ctx.drawPath({ operations: [
      { op: "moveTo", x: 2, y: 1 },
      { op: "lineTo", x: 1.75, y: 1 },
      { op: "lineTo", x: 1.75, y: 0.6 },
    ] });

    // Contact arm line: (0,0) to (1.8,0.5)
    ctx.drawLine(0, 0, 1.8, 0.5);

    // Dashed linkage: (1,0.25) to (1,-0.75)
    ctx.setLineDash([0.2, 0.2]);
    ctx.drawLine(1, 0.25, 1, -0.75);
    ctx.setLineDash([]);

    // Thin bar: (0.5,-0.75) to (1.5,-0.75)
    ctx.setLineWidth(0.5);
    ctx.drawLine(0.5, -0.75, 1.5, -0.75);
    ctx.setLineWidth(1);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, 2, { horizontal: "center", vertical: "top" });
    }

    ctx.restore();
  }

  isClosed(): boolean {
    return this._properties.getOrDefault<boolean>("closed", false);
  }

  getHelpText(): string {
    return (
      "Switch DT (SPDT) — a manually controlled single-pole double-throw switch.\n" +
      "Common terminal A connects to B when closed, to C when open.\n" +
      "Net merging/splitting handled by bus resolution subsystem.\n" +
      "Click to toggle during simulation."
    );
  }
}

// ---------------------------------------------------------------------------
// executeSwitchDT — flat simulation function
//
// SPDT switches are handled by the bus resolution subsystem (Phase 3).
// The switch state is managed by the interactive engine layer.
// No computation needed here.
// ---------------------------------------------------------------------------

export function executeSwitchDT(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  void index;
  void state;
  void layout;
}

// ---------------------------------------------------------------------------
// SWITCH_DT_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const SWITCH_DT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Poles",
    propertyKey: "poles",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "closed",
    propertyKey: "closed",
    convert: (v) => v === "true",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SWITCH_DT_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "poles",
    type: PropertyType.INT,
    label: "Poles",
    defaultValue: 1,
    min: 1,
    max: 4,
    description: "Number of switch poles",
  },
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of each switched signal",
  },
  {
    key: "closed",
    type: PropertyType.BOOLEAN,
    label: "Closed",
    defaultValue: false,
    description: "Initial switch state (closed=true: A-B connected; false: A-C connected)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown near the component",
  },
];

// ---------------------------------------------------------------------------
// SwitchDTDefinition
// ---------------------------------------------------------------------------

function switchDTFactory(props: PropertyBag): SwitchDTElement {
  return new SwitchDTElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const SwitchDTDefinition: ComponentDefinition = {
  name: "SwitchDT",
  typeId: -1,
  factory: switchDTFactory,
  executeFn: executeSwitchDT,
  pinLayout: buildPinDeclarations(1, 1),
  propertyDefs: SWITCH_DT_PROPERTY_DEFS,
  attributeMap: SWITCH_DT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText:
    "Switch DT (SPDT) — a manually controlled single-pole double-throw switch.\n" +
    "Common terminal A connects to B when closed, to C when open.\n" +
    "Net merging/splitting handled by bus resolution subsystem.\n" +
    "Click to toggle during simulation.",
  defaultDelay: 0,
};
