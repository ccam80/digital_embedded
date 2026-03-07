/**
 * RS Flip-Flop Async — level-sensitive (no clock), SR latch.
 *
 * Level-sensitive SR latch behavior (no clock):
 *   S=0, R=0 → hold (or recover from forbidden state)
 *   S=1, R=0 → Q=1, ~Q=0
 *   S=0, R=1 → Q=0, ~Q=1
 *   S=1, R=1 → forbidden (Q=0, ~Q=0 per Digital's implementation)
 *
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/flipflops/FlipflopRSAsync.java
 *
 * Input layout:  [S=0, R=1]
 * Output layout: [Q=0, ~Q=1]
 * State layout:  [storedQ=0, storedQn=1]
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

const RS_FF_AS_PIN_DECLARATIONS: PinDeclaration[] = [
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
// RSAsyncElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class RSAsyncElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("RS_FF_AS", instanceId, position, rotation, mirror, props);
    this._pins = resolvePins(
      RS_FF_AS_PIN_DECLARATIONS,
      position,
      rotation,
      createInverterConfig([]),
      createClockConfig([]),
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
    ctx.drawText("R", 0.6, 3, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Q", COMP_WIDTH - 0.6, 1, { horizontal: "right", vertical: "middle" });
    ctx.drawText("~Q", COMP_WIDTH - 0.6, 3, { horizontal: "right", vertical: "middle" });

    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText("SR", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 1.0 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.5, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "RS Flip-Flop Async — level-sensitive SR latch (no clock).\n" +
      "S=1, R=0 → Q=1; S=0, R=1 → Q=0; S=0, R=0 → hold; S=1, R=1 → forbidden (Q=~Q=0).\n" +
      "Changes propagate immediately without a clock edge."
    );
  }
}

// ---------------------------------------------------------------------------
// executeRSAsync — flat simulation function
//
// Level-sensitive SR latch: responds to S/R inputs directly without clock.
//
// Input layout:  [S=0, R=1]
// Output layout: [Q=0, ~Q=1]
// State layout:  [storedQ=0, storedQn=1]
//
// Matches Digital's FlipflopRSAsync: S=R=1 forces Q=0, ~Q=0 (forbidden state).
// S=R=0 after forbidden state: stays in undefined until driven.
// ---------------------------------------------------------------------------

export function executeRSAsync(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const s = state[inBase] !== 0;
  const r = state[inBase + 1] !== 0;

  if (s && r) {
    state[stBase] = 0;
    state[stBase + 1] = 0;
  } else if (s) {
    state[stBase] = 1;
    state[stBase + 1] = 0;
  } else if (r) {
    state[stBase] = 0;
    state[stBase + 1] = 1;
  }
  // S=0, R=0: hold current state (no update)

  state[outBase] = state[stBase];
  state[outBase + 1] = state[stBase + 1];
}

// ---------------------------------------------------------------------------
// RS_FF_AS_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const RS_FF_AS_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const RS_FF_AS_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
];

// ---------------------------------------------------------------------------
// RSAsyncDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function rsAsyncFactory(props: PropertyBag): RSAsyncElement {
  return new RSAsyncElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RSAsyncDefinition: ComponentDefinition = {
  name: "RS_FF_AS",
  typeId: -1,
  factory: rsAsyncFactory,
  executeFn: executeRSAsync,
  pinLayout: RS_FF_AS_PIN_DECLARATIONS,
  propertyDefs: RS_FF_AS_PROPERTY_DEFS,
  attributeMap: RS_FF_AS_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "RS Flip-Flop Async — level-sensitive SR latch (no clock).\n" +
    "S=1, R=0 → Q=1; S=0, R=1 → Q=0; S=0, R=0 → hold; S=1, R=1 → forbidden (Q=~Q=0).\n" +
    "Changes propagate immediately without a clock edge.",
  defaultDelay: 10,
};
