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
    super("SwitchDT", instanceId, position, rotation, mirror, props);

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

    // Draw the C-contact stub for each pole (shows DT nature, always visible)
    for (let p = 0; p < poles; p++) {
      const yBase = p * POLE_HEIGHT;
      // Stub: small polygon from C terminal position toward the contact area
      ctx.drawLine(COMP_WIDTH, yBase + C_OFFSET, COMP_WIDTH - 0.5, yBase + C_OFFSET);
      ctx.drawLine(COMP_WIDTH - 0.5, yBase + C_OFFSET, COMP_WIDTH - 0.5, yBase + 0.6);
    }

    // yOffs for open state
    const yOffs = this._closed ? 0 : -0.5;

    if (this._closed) {
      // Closed (A-B): straight horizontal line from A to B
      for (let p = 0; p < poles; p++) {
        ctx.drawLine(0, p * POLE_HEIGHT, COMP_WIDTH, p * POLE_HEIGHT);
      }
    } else {
      // Open (A-C): angled line from A toward C
      for (let p = 0; p < poles; p++) {
        ctx.drawLine(0, p * POLE_HEIGHT, COMP_WIDTH - 0.2, p * POLE_HEIGHT - yOffs * 2);
      }
    }

    // Lever indicator: dashed vertical line
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
