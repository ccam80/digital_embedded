/**
 * JK Flip-Flop — edge-triggered with J/K control inputs.
 *
 * On rising clock edge:
 *   J=0, K=0 → no change (hold)
 *   J=1, K=0 → set (Q=1)
 *   J=0, K=1 → reset (Q=0)
 *   J=1, K=1 → toggle (Q=~Q)
 *
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/flipflops/FlipflopJK.java
 *
 * Input layout:  [J=0, C=1, K=2]
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

export const JK_FF_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "J",
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
    label: "K",
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
// JKElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class JKElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("JK_FF", instanceId, position, rotation, mirror, props);
    this._pins = resolvePins(
      JK_FF_PIN_DECLARATIONS,
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
    const { x, y } = this.position;
    ctx.save();
    ctx.translate(x, y);

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0, weight: "bold" });
    ctx.drawText("J", 0.6, 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("C", 0.6, 2, { horizontal: "left", vertical: "middle" });
    ctx.drawText("K", 0.6, 3, { horizontal: "left", vertical: "middle" });
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
      "JK Flip-Flop — edge-triggered with J/K control inputs.\n" +
      "On rising clock edge: J=0,K=0 → hold; J=1,K=0 → set; J=0,K=1 → reset; J=1,K=1 → toggle.\n" +
      "Q and ~Q outputs are always complementary."
    );
  }
}

// ---------------------------------------------------------------------------
// executeJK — flat simulation function
//
// Input layout:  [J=0, C=1, K=2]
// Output layout: [Q=0, ~Q=1]
// State layout:  [storedQ=0, prevClock=1]
// ---------------------------------------------------------------------------

export function executeJK(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const j = state[inBase];
  const clock = state[inBase + 1];
  const k = state[inBase + 2];
  const prevClock = state[stBase + 1];

  if (clock !== 0 && prevClock === 0) {
    const jBit = j !== 0;
    const kBit = k !== 0;
    const qBit = state[stBase] !== 0;

    if (jBit && kBit) {
      state[stBase] = qBit ? 0 : 1;
    } else if (jBit) {
      state[stBase] = 1;
    } else if (kBit) {
      state[stBase] = 0;
    }
  }
  state[stBase + 1] = clock;

  const q = state[stBase];
  state[outBase] = q;
  state[outBase + 1] = q !== 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// JK_FF_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const JK_FF_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const JK_FF_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
];

// ---------------------------------------------------------------------------
// JKDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function jkFactory(props: PropertyBag): JKElement {
  return new JKElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const JKDefinition: ComponentDefinition = {
  name: "JK_FF",
  typeId: -1,
  factory: jkFactory,
  executeFn: executeJK,
  pinLayout: JK_FF_PIN_DECLARATIONS,
  propertyDefs: JK_FF_PROPERTY_DEFS,
  attributeMap: JK_FF_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "JK Flip-Flop — edge-triggered with J/K control inputs.\n" +
    "On rising clock edge: J=0,K=0 → hold; J=1,K=0 → set; J=0,K=1 → reset; J=1,K=1 → toggle.\n" +
    "Q and ~Q outputs are always complementary.",
  defaultDelay: 10,
};
