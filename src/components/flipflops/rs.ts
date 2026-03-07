/**
 * RS Flip-Flop — edge-triggered with S/R control inputs.
 *
 * On rising clock edge:
 *   S=0, R=0 → no change (hold)
 *   S=1, R=0 → set (Q=1)
 *   S=0, R=1 → reset (Q=0)
 *   S=1, R=1 → undefined (random — per Digital's implementation)
 *
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/flipflops/FlipflopRS.java
 *
 * Input layout:  [S=0, C=1, R=2]
 * Output layout: [Q=0, ~Q=1]
 * State layout:  [storedQ=0, prevClock=1]
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  createClockConfig,
  resolvePins,
} from "../../core/pin.js";
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

const COMP_WIDTH = 4;
const COMP_HEIGHT = 4;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

export const RS_FF_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "S",
    defaultBitWidth: 1,
    position: { x: 0, y: 1 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "C",
    defaultBitWidth: 1,
    position: { x: 0, y: 2 },
    isNegatable: false,
    isClockCapable: true,
  },
  {
    direction: PinDirection.INPUT,
    label: "R",
    defaultBitWidth: 1,
    position: { x: 0, y: 3 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "Q",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 1 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "~Q",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 3 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// RSElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class RSElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("RS_FF", instanceId, position, rotation, mirror, props);
    this._pins = resolvePins(
      RS_FF_PIN_DECLARATIONS,
      position,
      rotation,
      createInverterConfig([]),
      createClockConfig(["C"]),
      1,
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0, weight: "bold" });
    ctx.drawText("S", 0.6, 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("C", 0.6, 2, { horizontal: "left", vertical: "middle" });
    ctx.drawText("R", 0.6, 3, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Q", COMP_WIDTH - 0.6, 1, { horizontal: "right", vertical: "middle" });
    ctx.drawText("~Q", COMP_WIDTH - 0.6, 3, { horizontal: "right", vertical: "middle" });

    ctx.setColor("COMPONENT");
    ctx.drawLine(0, 1.5, 0.5, 2);
    ctx.drawLine(0.5, 2, 0, 2.5);

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 1.0 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.5, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "RS Flip-Flop — edge-triggered with S/R control inputs.\n" +
      "On rising clock edge: S=0,R=0 → hold; S=1,R=0 → set; S=0,R=1 → reset; S=1,R=1 → undefined.\n" +
      "Q and ~Q outputs are always complementary (except on S=R=1)."
    );
  }
}

// ---------------------------------------------------------------------------
// executeRS — flat simulation function
//
// Input layout:  [S=0, C=1, R=2]
// Output layout: [Q=0, ~Q=1]
// State layout:  [storedQ=0, prevClock=1]
//
// S=1, R=1 on clock edge: undefined behavior — output remains unchanged
// (deterministic undefined: Digital uses random, we use hold for reproducibility in tests)
// ---------------------------------------------------------------------------

export function executeRS(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const s = state[inBase];
  const clock = state[inBase + 1];
  const r = state[inBase + 2];
  const prevClock = state[stBase + 1];

  if (clock !== 0 && prevClock === 0) {
    const sBit = s !== 0;
    const rBit = r !== 0;

    if (sBit && !rBit) {
      state[stBase] = 1;
    } else if (!sBit && rBit) {
      state[stBase] = 0;
    }
    // S=1, R=1: undefined — hold current state (deterministic for testing)
    // S=0, R=0: hold current state
  }
  state[stBase + 1] = clock;

  const q = state[stBase];
  state[outBase] = q;
  state[outBase + 1] = q !== 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// RS_FF_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const RS_FF_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const RS_FF_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
];

// ---------------------------------------------------------------------------
// RSDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function rsFactory(props: PropertyBag): RSElement {
  return new RSElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RSDefinition: ComponentDefinition = {
  name: "RS_FF",
  typeId: -1,
  factory: rsFactory,
  executeFn: executeRS,
  pinLayout: RS_FF_PIN_DECLARATIONS,
  propertyDefs: RS_FF_PROPERTY_DEFS,
  attributeMap: RS_FF_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "RS Flip-Flop — edge-triggered with S/R control inputs.\n" +
    "On rising clock edge: S=0,R=0 → hold; S=1,R=0 → set; S=0,R=1 → reset; S=1,R=1 → undefined.\n" +
    "Q and ~Q outputs are always complementary (except on S=R=1).",
  stateSlotCount: 2,
  defaultDelay: 10,
};
