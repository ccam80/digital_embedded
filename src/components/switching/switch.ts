/**
 * Switch component — SPST switch with mechanical symbol rendering.
 *
 * Like PlainSwitch but with the standard mechanical switch symbol:
 * a diagonal line for open state, straight line for closed state,
 * plus a dashed lever and grip indicator.
 *
 * Additional property: switchActsAsInput — when true and a label is set,
 * the switch can also be driven by an external digital signal (1=closed, 0=open).
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

/** Component width in grid units (SIZE*2 = 2 grid units). */
const COMP_WIDTH = 2;

/** Vertical spacing between poles in grid units (SIZE*2). */
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
// SwitchElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class SwitchElement extends AbstractCircuitElement {
  private readonly _poles: number;
  private readonly _bitWidth: number;
  private readonly _closed: boolean;
  private readonly _label: string;
  private readonly _switchActsAsInput: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Switch", instanceId, position, rotation, mirror, props);

    this._poles = props.getOrDefault<number>("poles", 1);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._closed = props.getOrDefault<boolean>("closed", false);
    this._label = props.getOrDefault<string>("label", "");
    this._switchActsAsInput = props.getOrDefault<boolean>("switchActsAsInput", false);

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

    // yOffs: vertical offset applied when open to show angled contact
    const yOffs = this._closed ? 0 : 0.5;

    if (this._closed) {
      // Closed state: straight horizontal line from A to B for each pole
      for (let p = 0; p < poles; p++) {
        ctx.drawLine(0, p * POLE_HEIGHT, COMP_WIDTH, p * POLE_HEIGHT);
      }
    } else {
      // Open state: angled line from A, not reaching B (classic knife-switch symbol)
      for (let p = 0; p < poles; p++) {
        ctx.drawLine(0, p * POLE_HEIGHT, COMP_WIDTH - 0.2, p * POLE_HEIGHT - yOffs * 2);
      }
    }

    // Lever indicator: dashed vertical line connecting all poles
    ctx.setLineDash([0.2, 0.2]);
    ctx.drawLine(
      COMP_WIDTH / 2,
      -yOffs + (poles - 1) * POLE_HEIGHT,
      COMP_WIDTH / 2,
      -yOffs - 1,
    );
    ctx.setLineDash([]);

    // Grip indicator: short horizontal bar
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

  switchActsAsInput(): boolean {
    return this._switchActsAsInput;
  }

  getHelpText(): string {
    return (
      "Switch (SPST) — a manually controlled single-pole single-throw switch.\n" +
      "When closed, terminals A and B are connected (bus nets merged).\n" +
      "When open, terminals are disconnected.\n" +
      "Click to toggle during simulation.\n" +
      "If 'switchActsAsInput' is set with a label, the switch can be driven by an external signal."
    );
  }
}

// ---------------------------------------------------------------------------
// executeSwitch — flat simulation function
//
// Switches are handled by the bus resolution subsystem (Phase 3 task 3.2.3).
// The closed/open state is managed by the interactive engine layer.
// No computation needed in this executeFn.
// ---------------------------------------------------------------------------

export function executeSwitch(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  void index;
  void state;
  void layout;
}

// ---------------------------------------------------------------------------
// SWITCH_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const SWITCH_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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
  {
    xmlName: "SwitchActsAsInput",
    propertyKey: "switchActsAsInput",
    convert: (v) => v === "true",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SWITCH_PROPERTY_DEFS: PropertyDefinition[] = [
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
  {
    key: "switchActsAsInput",
    type: PropertyType.BOOLEAN,
    label: "Acts as input",
    defaultValue: false,
    description: "When true, switch state can be driven by an external signal",
  },
];

// ---------------------------------------------------------------------------
// SwitchDefinition
// ---------------------------------------------------------------------------

function switchFactory(props: PropertyBag): SwitchElement {
  return new SwitchElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const SwitchDefinition: ComponentDefinition = {
  name: "Switch",
  typeId: -1,
  factory: switchFactory,
  executeFn: executeSwitch,
  pinLayout: buildPinDeclarations(1, 1),
  propertyDefs: SWITCH_PROPERTY_DEFS,
  attributeMap: SWITCH_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText:
    "Switch (SPST) — a manually controlled single-pole single-throw switch.\n" +
    "When closed, terminals A and B are connected (bus nets merged).\n" +
    "When open, terminals are disconnected.\n" +
    "Click to toggle during simulation.",
  defaultDelay: 0,
};
