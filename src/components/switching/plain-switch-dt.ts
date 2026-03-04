/**
 * PlainSwitchDT component — SPDT switch with simple rendering.
 *
 * A double-throw (DT) switch has three terminals per pole:
 *   A (common), B (normally-closed contact), C (normally-open contact).
 * When closed=true: A-B are connected, A-C are disconnected.
 * When closed=false: A-B are disconnected, A-C are connected.
 *
 * Net merging/splitting is handled by bus resolution (Phase 3).
 * Pattern follows the And gate exemplar exactly.
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

/** Component width in grid units. */
const COMP_WIDTH = 2;

/** Vertical spacing between poles in grid units. */
const POLE_HEIGHT = 2;

/** Vertical offset for the C (normally-open) contact below A. */
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
    // A: common terminal, left side
    decls.push({
      direction: PinDirection.BIDIRECTIONAL,
      label: `A${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: 0, y: yBase },
      isNegatable: false,
      isClockCapable: false,
    });
    // B: upper right (closed contact — A connects to B when closed=true)
    decls.push({
      direction: PinDirection.BIDIRECTIONAL,
      label: `B${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: COMP_WIDTH, y: yBase },
      isNegatable: false,
      isClockCapable: false,
    });
    // C: lower right (open contact — A connects to C when closed=false)
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
// PlainSwitchDTElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PlainSwitchDTElement extends AbstractCircuitElement {
  private readonly _poles: number;
  private readonly _bitWidth: number;
  private readonly _closed: boolean;
  private readonly _label: string;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PlainSwitchDT", instanceId, position, rotation, mirror, props);

    this._poles = props.getOrDefault<number>("poles", 1);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._closed = props.getOrDefault<boolean>("closed", false);
    this._label = props.getOrDefault<string>("label", "");

    const decls = buildPinDeclarations(this._poles, this._bitWidth);
    this._pins = resolvePins(
      decls,
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
    const h = componentHeight(this._poles);
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: h,
    };
  }

  draw(ctx: RenderContext): void {
    const { x, y } = this.position;
    const poles = this._poles;

    ctx.save();
    ctx.translate(x, y);

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Draw the C-contact stub (always visible — shows the DT nature)
    for (let p = 0; p < poles; p++) {
      const yBase = p * POLE_HEIGHT;
      // Stub connecting to C terminal (lower-right position)
      ctx.drawLine(COMP_WIDTH, yBase + C_OFFSET, COMP_WIDTH - 0.5, yBase + C_OFFSET);
      ctx.drawLine(COMP_WIDTH - 0.5, yBase + C_OFFSET, COMP_WIDTH - 0.5, yBase + 0.5 + 0.1);
    }

    if (this._closed) {
      // Closed (A-B connected): straight line from A to B
      for (let p = 0; p < poles; p++) {
        const yBase = p * POLE_HEIGHT;
        ctx.drawLine(0, yBase, COMP_WIDTH, yBase);
      }
    } else {
      // Open (A-C connected): angled line from A toward C contact
      for (let p = 0; p < poles; p++) {
        const yBase = p * POLE_HEIGHT;
        ctx.drawLine(0, yBase, COMP_WIDTH - 0.2, yBase + 0.5);
      }
    }

    // Lever indicator: dashed vertical line
    const yOffs = this._closed ? 0 : -0.5;
    ctx.setLineDash([0.2, 0.2]);
    ctx.drawLine(
      COMP_WIDTH / 2,
      -yOffs + (poles - 1) * POLE_HEIGHT,
      COMP_WIDTH / 2,
      -yOffs - 1,
    );
    ctx.setLineDash([]);

    // Grip: short horizontal bar at top of lever
    ctx.drawLine(COMP_WIDTH / 4, -yOffs - 1, (COMP_WIDTH * 3) / 4, -yOffs - 1);

    if (this._label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(
        this._label,
        COMP_WIDTH / 2,
        4 + (poles - 1) * POLE_HEIGHT + C_OFFSET,
        { horizontal: "center", vertical: "top" },
      );
    }

    ctx.restore();
  }

  isClosed(): boolean {
    return this._closed;
  }

  getHelpText(): string {
    return (
      "Plain Switch DT (SPDT) — single-pole double-throw switch.\n" +
      "Common terminal A connects to B when closed, to C when open.\n" +
      "Net merging/splitting handled by bus resolution subsystem.\n" +
      "Click to toggle during simulation."
    );
  }
}

// ---------------------------------------------------------------------------
// executePlainSwitchDT — flat simulation function
//
// SPDT switches are handled by the bus resolution subsystem (Phase 3).
// The switch state (closed=1, open=0) is written to the output slot by the
// interactive engine layer when the user clicks the component.
// No computation is needed in this executeFn.
// ---------------------------------------------------------------------------

export function executePlainSwitchDT(index: number, state: Uint32Array, layout: ComponentLayout): void {
  void index;
  void state;
  void layout;
}

// ---------------------------------------------------------------------------
// PLAIN_SWITCH_DT_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const PLAIN_SWITCH_DT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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

const PLAIN_SWITCH_DT_PROPERTY_DEFS: PropertyDefinition[] = [
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
// PlainSwitchDTDefinition
// ---------------------------------------------------------------------------

function plainSwitchDTFactory(props: PropertyBag): PlainSwitchDTElement {
  return new PlainSwitchDTElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const PlainSwitchDTDefinition: ComponentDefinition = {
  name: "PlainSwitchDT",
  typeId: -1,
  factory: plainSwitchDTFactory,
  executeFn: executePlainSwitchDT,
  pinLayout: buildPinDeclarations(1, 1),
  propertyDefs: PLAIN_SWITCH_DT_PROPERTY_DEFS,
  attributeMap: PLAIN_SWITCH_DT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText:
    "Plain Switch DT (SPDT) — single-pole double-throw switch.\n" +
    "Common terminal A connects to B when closed, to C when open.\n" +
    "Net merging/splitting handled by bus resolution subsystem.\n" +
    "Click to toggle during simulation.",
  defaultDelay: 0,
};
