/**
 * D Flip-Flop with async Set/Clear — edge-triggered with async preset/clear.
 *
 * Stores D on rising clock edge. Async Set (active-high) forces Q=1.
 * Async Clear (active-high) forces Q=0. Set/Clear take priority over clock.
 *
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/flipflops/FlipflopDAsync.java
 *
 * Input pin order: [Set, D, C, Clr]
 * Output pin order: [Q, ~Q]
 * State slots: [storedQ, prevClock]
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

const COMP_WIDTH = 3;
// 4 inputs, 2 outputs, symmetric=false: offs=0, no even correction
// inputs: Set@y=0, D@y=1, C@y=2, Clr@y=3; outputs: Q@y=0, ~Q@y=1
// max(4,2)=4, yBottom=(4-1)+0.5=3.5, height=3.5+0.5=4
const COMP_HEIGHT = 4;

// ---------------------------------------------------------------------------
// Pin declarations — GenericShape positions (symmetric=false, 4 inputs, 2 outputs)
// inputs: Set@y=0, D@y=1, C@y=2, Clr@y=3
// outputs: Q@y=0, ~Q@y=1
// ---------------------------------------------------------------------------

const D_FF_AS_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "Set",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "D",
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
    label: "Clr",
    defaultBitWidth: 1,
    position: { x: 0, y: 3 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "Q",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "~Q",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 1 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// DAsyncElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DAsyncElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("D_FF_AS", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._pins = resolvePins(
      D_FF_AS_PIN_DECLARATIONS,
      position,
      rotation,
      createInverterConfig([]),
      createClockConfig(["C"]),
      this._bitWidth,
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.5,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, -0.5, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, -0.5, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.9, weight: "bold" });
    ctx.drawText("Set", 0.5, 0, { horizontal: "left", vertical: "middle" });
    ctx.drawText("D", 0.5, 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("C", 0.5, 2, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Clr", 0.5, 3, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Q", COMP_WIDTH - 0.5, 0, { horizontal: "right", vertical: "middle" });
    ctx.drawText("~Q", COMP_WIDTH - 0.5, 1, { horizontal: "right", vertical: "middle" });

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
      "D Flip-Flop with async Set/Clear — edge-triggered with async preset/clear.\n" +
      "Set (active-high) forces Q=1 asynchronously.\n" +
      "Clr (active-high) forces Q=0 asynchronously.\n" +
      "When Set and Clr are both inactive, stores D on rising clock edge."
    );
  }
}

// ---------------------------------------------------------------------------
// executeDAsync — flat simulation function
//
// Input layout:  [Set=0, D=1, C=2, Clr=3]
// Output layout: [Q=0, ~Q=1]
// State layout:  [storedQ=0, prevClock=1]
// ---------------------------------------------------------------------------

export function executeDAsync(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const setIn = state[wt[inBase]];
  const d = state[wt[inBase + 1]];
  const clock = state[wt[inBase + 2]];
  const clr = state[wt[inBase + 3]];
  const prevClock = state[stBase + 1];

  if (clock !== 0 && prevClock === 0) {
    state[stBase] = d;
  }
  state[stBase + 1] = clock;

  if (setIn !== 0) {
    state[stBase] = 0xFFFFFFFF;
  } else if (clr !== 0) {
    state[stBase] = 0;
  }

  const q = state[stBase];
  state[wt[outBase]] = q;
  state[wt[outBase + 1]] = (~q) >>> 0;
}

// ---------------------------------------------------------------------------
// D_FF_AS_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const D_FF_AS_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const D_FF_AS_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of D and Q signals",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
];

// ---------------------------------------------------------------------------
// DAsyncDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function dAsyncFactory(props: PropertyBag): DAsyncElement {
  return new DAsyncElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DAsyncDefinition: ComponentDefinition = {
  name: "D_FF_AS",
  typeId: -1,
  factory: dAsyncFactory,
  executeFn: executeDAsync,
  pinLayout: D_FF_AS_PIN_DECLARATIONS,
  propertyDefs: D_FF_AS_PROPERTY_DEFS,
  attributeMap: D_FF_AS_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "D Flip-Flop with async Set/Clear — edge-triggered with async preset/clear.\n" +
    "Set (active-high) forces Q=1 asynchronously.\n" +
    "Clr (active-high) forces Q=0 asynchronously.\n" +
    "When Set and Clr are both inactive, stores D on rising clock edge.",
  stateSlotCount: 2,
  defaultDelay: 10,
};
