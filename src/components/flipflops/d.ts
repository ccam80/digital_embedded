/**
 * D Flip-Flop component — edge-triggered data storage.
 *
 * Stores D input on rising clock edge. Q and ~Q outputs are complementary.
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/flipflops/FlipflopD.java
 *
 * Internal state layout (stateOffset):
 *   slot 0: stored Q value (0 or 1)
 *
 * Signal array layout per instance:
 *   inputs:  [D, C]
 *   outputs: [Q, ~Q]
 *   state:   [storedQ, prevClock]
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

const D_FF_PIN_DECLARATIONS: PinDeclaration[] = [
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
    position: { x: 0, y: 3 },
    isNegatable: false,
    isClockCapable: true,
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
// DElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("D_FF", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._pins = resolvePins(
      D_FF_PIN_DECLARATIONS,
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
    ctx.drawText("D", 0.6, 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("C", 0.6, 3, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Q", COMP_WIDTH - 0.6, 1, { horizontal: "right", vertical: "middle" });
    ctx.drawText("~Q", COMP_WIDTH - 0.6, 3, { horizontal: "right", vertical: "middle" });

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
      "D Flip-Flop — stores the D input on the rising clock edge.\n" +
      "Q is the stored value, ~Q is its complement.\n" +
      "Edge-triggered: only samples D when clock transitions from 0 to 1."
    );
  }
}

// ---------------------------------------------------------------------------
// executeD — flat simulation function
//
// State layout:
//   stateOffset(index) + 0: stored Q value
//   stateOffset(index) + 1: previous clock value (for edge detection)
//
// Input layout:  [D=0, C=1]
// Output layout: [Q=0, ~Q=1]
// ---------------------------------------------------------------------------

export function executeD(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const d = state[wt[inBase]];
  const clock = state[wt[inBase + 1]];
  const prevClock = state[stBase + 1];

  if (clock !== 0 && prevClock === 0) {
    state[stBase] = d;
  }
  state[stBase + 1] = clock;

  const q = state[stBase];
  state[wt[outBase]] = q;
  state[wt[outBase + 1]] = (~q) >>> 0;
}

// ---------------------------------------------------------------------------
// D_FF_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const D_FF_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const D_FF_PROPERTY_DEFS: PropertyDefinition[] = [
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
// DDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function dFactory(props: PropertyBag): DElement {
  return new DElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DDefinition: ComponentDefinition = {
  name: "D_FF",
  typeId: -1,
  factory: dFactory,
  executeFn: executeD,
  pinLayout: D_FF_PIN_DECLARATIONS,
  propertyDefs: D_FF_PROPERTY_DEFS,
  attributeMap: D_FF_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "D Flip-Flop — stores the D input on the rising clock edge.\n" +
    "Q is the stored value, ~Q is its complement.\n" +
    "Edge-triggered: only samples D when clock transitions from 0 to 1.",
  stateSlotCount: 2,
  defaultDelay: 10,
};
