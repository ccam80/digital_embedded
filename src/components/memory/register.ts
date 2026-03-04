/**
 * Register — edge-triggered storage register with enable.
 *
 * On rising clock edge, if en=1: capture D input into stored value.
 * Output Q always reflects the stored value.
 *
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/memory/Register.java
 *
 * Input layout:  [D=0, C=1, en=2]
 * Output layout: [Q=0]
 * State layout:  [storedVal=0, prevClock=1]
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
const COMP_HEIGHT = 5;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const REGISTER_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "D",
    defaultBitWidth: 1,
    position: { x: 0, y: 1 },
    isNegatable: false,
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
    label: "en",
    defaultBitWidth: 1,
    position: { x: 0, y: 4 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "Q",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 2 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// RegisterElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class RegisterElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Register", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 8);
    this._pins = resolvePins(
      REGISTER_PIN_DECLARATIONS,
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
    ctx.drawText("D", 0.5, 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("C", 0.5, 2, { horizontal: "left", vertical: "middle" });
    ctx.drawText("en", 0.5, 4, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Q", COMP_WIDTH - 0.5, 2, { horizontal: "right", vertical: "middle" });

    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText("REG", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });

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
      "Register — edge-triggered storage register with enable.\n" +
      "On rising clock edge: if en=1, captures D input into stored value.\n" +
      "Output Q always reflects the stored value."
    );
  }
}

// ---------------------------------------------------------------------------
// executeRegister — flat simulation function
//
// Input layout:  [D=0, C=1, en=2]
// Output layout: [Q=0]
// State layout:  [storedVal=0, prevClock=1]
// ---------------------------------------------------------------------------

export function executeRegister(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const extLayout = layout as unknown as { stateOffset(i: number): number };
  const stBase = extLayout.stateOffset(index);

  const d = state[inBase];
  const clock = state[inBase + 1];
  const en = state[inBase + 2];
  const prevClock = state[stBase + 1];

  if (clock !== 0 && prevClock === 0) {
    if (en !== 0) {
      state[stBase] = d;
    }
  }
  state[stBase + 1] = clock;

  state[outBase] = state[stBase];
}

// ---------------------------------------------------------------------------
// REGISTER_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const REGISTER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const REGISTER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 8,
    min: 1,
    max: 32,
    description: "Bit width of the register",
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
// RegisterDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function registerFactory(props: PropertyBag): RegisterElement {
  return new RegisterElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RegisterDefinition: ComponentDefinition = {
  name: "Register",
  typeId: -1,
  factory: registerFactory,
  executeFn: executeRegister,
  pinLayout: REGISTER_PIN_DECLARATIONS,
  propertyDefs: REGISTER_PROPERTY_DEFS,
  attributeMap: REGISTER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText:
    "Register — edge-triggered storage register with enable.\n" +
    "On rising clock edge: if en=1, captures D input into stored value.\n" +
    "Output Q always reflects the stored value.",
  defaultDelay: 10,
};
