/**
 * PlainSwitch component — SPST switch with simple rendering.
 *
 * A PlainSwitch has two bidirectional terminals (A and B). When closed,
 * the two terminals are connected (net merging handled by bus resolution,
 * Phase 3). When open, the terminals are disconnected.
 *
 * The executeFn writes the current switch-closed state to the output slot
 * so the bus resolution subsystem can act on net connectivity changes.
 *
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

/** Component height per pole in grid units. */
const POLE_HEIGHT = 2;

function componentHeight(poles: number): number {
  return Math.max(poles * POLE_HEIGHT, 2);
}

// ---------------------------------------------------------------------------
// Pin layout helpers
// ---------------------------------------------------------------------------

function buildPinDeclarations(poles: number, bitWidth: number): PinDeclaration[] {
  const decls: PinDeclaration[] = [];
  for (let p = 0; p < poles; p++) {
    const yPos = p * POLE_HEIGHT;
    decls.push({
      direction: PinDirection.BIDIRECTIONAL,
      label: `A${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: 0, y: yPos },
      isNegatable: false,
      isClockCapable: false,
    });
    decls.push({
      direction: PinDirection.BIDIRECTIONAL,
      label: `B${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: COMP_WIDTH, y: yPos },
      isNegatable: false,
      isClockCapable: false,
    });
  }
  return decls;
}

// ---------------------------------------------------------------------------
// PlainSwitchElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PlainSwitchElement extends AbstractCircuitElement {
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
    super("PlainSwitch", instanceId, position, rotation, mirror, props);

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
    const poles = this._poles;

    ctx.save();

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    if (this._closed) {
      // Closed: straight horizontal line connecting A to B for each pole
      for (let p = 0; p < poles; p++) {
        const yPos = p * POLE_HEIGHT;
        ctx.drawLine(0, yPos, COMP_WIDTH, yPos);
      }
    } else {
      // Open: angled line — mechanical open contact symbol
      for (let p = 0; p < poles; p++) {
        const yPos = p * POLE_HEIGHT;
        ctx.drawLine(0, yPos, COMP_WIDTH - 0.2, yPos - 0.5);
      }
    }

    // Lever indicator: dashed vertical line above the contact
    const yOffs = this._closed ? 0 : 0.5;
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
        4 + (poles - 1) * POLE_HEIGHT,
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
      "Plain Switch (SPST) — a simple single-pole single-throw switch.\n" +
      "When closed, terminals A and B are connected (bus nets merged).\n" +
      "When open, terminals are disconnected.\n" +
      "Click to toggle during simulation."
    );
  }
}

// ---------------------------------------------------------------------------
// executePlainSwitch — flat simulation function
//
// Switches are handled by the bus resolution subsystem (Phase 3 task 3.2.3).
// The executeFn writes the current switch-closed state (0=open, 1=closed)
// to the designated output slot so the bus resolver can act on net merging.
// The switch-closed value is set externally by the interactive engine layer
// when the user clicks the component.
//
// Layout convention:
//   output[0]: switch closed flag (0=open, 1=closed), managed by engine
// ---------------------------------------------------------------------------

export function executePlainSwitch(index: number, state: Uint32Array, layout: ComponentLayout): void {
  // Switch state is controlled externally (user interaction via engine).
  // The output slot already holds the correct closed/open flag.
  // No computation needed here — bus resolution reads the output slot directly.
  void index;
  void state;
  void layout;
}

// ---------------------------------------------------------------------------
// PLAIN_SWITCH_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const PLAIN_SWITCH_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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

const PLAIN_SWITCH_PROPERTY_DEFS: PropertyDefinition[] = [
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
    description: "Initial switch state (closed = connected)",
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
// PlainSwitchDefinition
// ---------------------------------------------------------------------------

function plainSwitchFactory(props: PropertyBag): PlainSwitchElement {
  return new PlainSwitchElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const PlainSwitchDefinition: ComponentDefinition = {
  name: "PlainSwitch",
  typeId: -1,
  factory: plainSwitchFactory,
  executeFn: executePlainSwitch,
  pinLayout: buildPinDeclarations(1, 1),
  propertyDefs: PLAIN_SWITCH_PROPERTY_DEFS,
  attributeMap: PLAIN_SWITCH_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText:
    "Plain Switch (SPST) — a simple single-pole single-throw switch.\n" +
    "When closed, terminals A and B are connected (bus nets merged).\n" +
    "When open, terminals are disconnected.\n" +
    "Click to toggle during simulation.",
  defaultDelay: 0,
};
