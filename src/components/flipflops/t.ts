/**
 * T Flip-Flop — toggles on rising clock edge when T=1 (or unconditionally if no T input).
 *
 * With T input (withEnable=true):
 *   T=1 → toggle Q on rising clock edge
 *   T=0 → hold Q on rising clock edge
 *
 * Without T input (withEnable=false):
 *   Toggles Q on every rising clock edge.
 *
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/flipflops/FlipflopT.java
 *
 * Input layout (withEnable=false): [C=0]
 * Input layout (withEnable=true):  [T=0, C=1]
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
const COMP_HEIGHT_NO_ENABLE = 3;
const COMP_HEIGHT_WITH_ENABLE = 4;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const T_FF_PINS_NO_ENABLE: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "C",
    defaultBitWidth: 1,
    position: { x: 0, y: 1 },
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
    position: { x: COMP_WIDTH, y: 2 },
    isNegatable: false,
    isClockCapable: false,
  },
];

const T_FF_PINS_WITH_ENABLE: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "T",
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
// TElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class TElement extends AbstractCircuitElement {
  private readonly _withEnable: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("T_FF", instanceId, position, rotation, mirror, props);
    this._withEnable = props.getOrDefault<boolean>("withEnable", false);
    const decls = this._withEnable ? T_FF_PINS_WITH_ENABLE : T_FF_PINS_NO_ENABLE;
    this._pins = resolvePins(
      decls,
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
    const h = this._withEnable ? COMP_HEIGHT_WITH_ENABLE : COMP_HEIGHT_NO_ENABLE;
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: h,
    };
  }

  draw(ctx: RenderContext): void {
    const h = this._withEnable ? COMP_HEIGHT_WITH_ENABLE : COMP_HEIGHT_NO_ENABLE;
    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, h, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, h, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0, weight: "bold" });

    if (this._withEnable) {
      ctx.drawText("T", 0.6, 1, { horizontal: "left", vertical: "middle" });
      ctx.drawText("C", 0.6, 2, { horizontal: "left", vertical: "middle" });
      ctx.drawText("Q", COMP_WIDTH - 0.6, 1, { horizontal: "right", vertical: "middle" });
      ctx.drawText("~Q", COMP_WIDTH - 0.6, 3, { horizontal: "right", vertical: "middle" });
      ctx.setColor("COMPONENT");
      ctx.drawLine(0, 1.5, 0.5, 2);
      ctx.drawLine(0.5, 2, 0, 2.5);
    } else {
      ctx.drawText("C", 0.6, 1, { horizontal: "left", vertical: "middle" });
      ctx.drawText("Q", COMP_WIDTH - 0.6, 1, { horizontal: "right", vertical: "middle" });
      ctx.drawText("~Q", COMP_WIDTH - 0.6, 2, { horizontal: "right", vertical: "middle" });
      ctx.setColor("COMPONENT");
      ctx.drawLine(0, 0.5, 0.5, 1);
      ctx.drawLine(0.5, 1, 0, 1.5);
    }

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText("T", COMP_WIDTH / 2, h / 2, { horizontal: "center", vertical: "middle" });

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 1.0 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.5, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "T Flip-Flop — toggles Q on rising clock edge.\n" +
      "With T input: toggles only when T=1.\n" +
      "Without T input: toggles on every rising clock edge.\n" +
      "Q and ~Q are always complementary."
    );
  }
}

// ---------------------------------------------------------------------------
// executeT — flat simulation function
//
// withEnable=false: inputs [C=0],     outputs [Q=0, ~Q=1], state [storedQ=0, prevClock=1]
// withEnable=true:  inputs [T=0, C=1], outputs [Q=0, ~Q=1], state [storedQ=0, prevClock=1]
//
// The withEnable flag is embedded in the component's input count at compile time.
// We detect it from inputCount via layout.inputCount(index).
// ---------------------------------------------------------------------------

export function executeT(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const inputCount = layout.inputCount(index);
  const withEnable = inputCount === 2;

  let clock: number;
  let t: number;

  if (withEnable) {
    t = state[inBase];
    clock = state[inBase + 1];
  } else {
    t = 1;
    clock = state[inBase];
  }

  const prevClock = state[stBase + 1];

  if (clock !== 0 && prevClock === 0) {
    if (t !== 0) {
      state[stBase] = state[stBase] !== 0 ? 0 : 1;
    }
  }
  state[stBase + 1] = clock;

  const q = state[stBase];
  state[outBase] = q;
  state[outBase + 1] = q !== 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// T_FF_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const T_FF_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "withEnable", propertyKey: "withEnable", convert: (v) => v === "true" },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const T_FF_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "withEnable",
    type: PropertyType.BOOLEAN,
    label: "With Enable",
    defaultValue: false,
    description: "Add T (toggle enable) input pin",
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
// TDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function tFactory(props: PropertyBag): TElement {
  return new TElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TDefinition: ComponentDefinition = {
  name: "T_FF",
  typeId: -1,
  factory: tFactory,
  executeFn: executeT,
  pinLayout: T_FF_PINS_NO_ENABLE,
  propertyDefs: T_FF_PROPERTY_DEFS,
  attributeMap: T_FF_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "T Flip-Flop — toggles Q on rising clock edge.\n" +
    "With T input: toggles only when T=1.\n" +
    "Without T input: toggles on every rising clock edge.\n" +
    "Q and ~Q are always complementary.",
  defaultDelay: 10,
};
