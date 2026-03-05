/**
 * JK Flip-Flop with async Set/Clear.
 *
 * JK logic on rising clock edge, with async Set/Clear inputs taking priority.
 * Set (active-high) forces Q=1. Clear (active-high) forces Q=0.
 *
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/flipflops/FlipflopJKAsync.java
 *
 * Input layout:  [Set=0, J=1, C=2, K=3, Clr=4]
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
const COMP_HEIGHT = 6;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const JK_FF_AS_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "Set",
    defaultBitWidth: 1,
    position: { x: 0, y: 1 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "J",
    defaultBitWidth: 1,
    position: { x: 0, y: 2 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "C",
    defaultBitWidth: 1,
    position: { x: 0, y: 3 },
    isNegatable: false,
    isClockCapable: true,
  },
  {
    direction: PinDirection.INPUT,
    label: "K",
    defaultBitWidth: 1,
    position: { x: 0, y: 4 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "Clr",
    defaultBitWidth: 1,
    position: { x: 0, y: 5 },
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
    position: { x: COMP_WIDTH, y: 5 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// JKAsyncElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class JKAsyncElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("JK_FF_AS", instanceId, position, rotation, mirror, props);
    this._pins = resolvePins(
      JK_FF_AS_PIN_DECLARATIONS,
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
    ctx.setFont({ family: "sans-serif", size: 0.9, weight: "bold" });
    ctx.drawText("Set", 0.5, 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("J", 0.5, 2, { horizontal: "left", vertical: "middle" });
    ctx.drawText("C", 0.5, 3, { horizontal: "left", vertical: "middle" });
    ctx.drawText("K", 0.5, 4, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Clr", 0.5, 5, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Q", COMP_WIDTH - 0.5, 1, { horizontal: "right", vertical: "middle" });
    ctx.drawText("~Q", COMP_WIDTH - 0.5, 5, { horizontal: "right", vertical: "middle" });

    ctx.setColor("COMPONENT");
    ctx.drawLine(0, 2.5, 0.5, 3);
    ctx.drawLine(0.5, 3, 0, 3.5);

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
      "JK Flip-Flop with async Set/Clear.\n" +
      "Set (active-high) forces Q=1 asynchronously.\n" +
      "Clr (active-high) forces Q=0 asynchronously.\n" +
      "On rising clock edge: J=0,K=0 → hold; J=1,K=0 → set; J=0,K=1 → reset; J=1,K=1 → toggle."
    );
  }
}

// ---------------------------------------------------------------------------
// executeJKAsync — flat simulation function
//
// Input layout:  [Set=0, J=1, C=2, K=3, Clr=4]
// Output layout: [Q=0, ~Q=1]
// State layout:  [storedQ=0, prevClock=1]
// ---------------------------------------------------------------------------

export function executeJKAsync(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const setIn = state[inBase];
  const j = state[inBase + 1];
  const clock = state[inBase + 2];
  const k = state[inBase + 3];
  const clr = state[inBase + 4];
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

  if (setIn !== 0) {
    state[stBase] = 1;
  } else if (clr !== 0) {
    state[stBase] = 0;
  }

  const q = state[stBase];
  state[outBase] = q;
  state[outBase + 1] = q !== 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// JK_FF_AS_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const JK_FF_AS_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const JK_FF_AS_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
];

// ---------------------------------------------------------------------------
// JKAsyncDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function jkAsyncFactory(props: PropertyBag): JKAsyncElement {
  return new JKAsyncElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const JKAsyncDefinition: ComponentDefinition = {
  name: "JK_FF_AS",
  typeId: -1,
  factory: jkAsyncFactory,
  executeFn: executeJKAsync,
  pinLayout: JK_FF_AS_PIN_DECLARATIONS,
  propertyDefs: JK_FF_AS_PROPERTY_DEFS,
  attributeMap: JK_FF_AS_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "JK Flip-Flop with async Set/Clear.\n" +
    "Set (active-high) forces Q=1 asynchronously.\n" +
    "Clr (active-high) forces Q=0 asynchronously.\n" +
    "On rising clock edge: J=0,K=0 → hold; J=1,K=0 → set; J=0,K=1 → reset; J=1,K=1 → toggle.",
  defaultDelay: 10,
};
