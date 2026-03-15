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
} from "../../core/pin.js";
import { drawGenericShape } from "../generic-shape.js";
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

// Java GenericShape: 3 inputs, 1 output, symmetric, width=3
const COMP_WIDTH = 3;

// ---------------------------------------------------------------------------
// Pin declarations — matches Java GenericShape.createPins() exactly
// 3 inputs (odd), symmetric: offs = floor(3/2) = 1
// ---------------------------------------------------------------------------

const REGISTER_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "D",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "C",
    defaultBitWidth: 1,
    position: { x: 0, y: 1 },
    isNegatable: false,
    isClockCapable: true,
  },
  {
    direction: PinDirection.INPUT,
    label: "en",
    defaultBitWidth: 1,
    position: { x: 0, y: 2 },
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
];

// ---------------------------------------------------------------------------
// RegisterElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class RegisterElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Register", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 8);
    // Override D and Q widths based on the bitWidth property
    const decls = REGISTER_PIN_DECLARATIONS.map((d) =>
      d.label === "D" || d.label === "Q"
        ? { ...d, defaultBitWidth: bitWidth }
        : d,
    );
    return this.derivePins(decls, ["C"]);
  }

  getBoundingBox(): Rect {
    // Java GenericShape: body from -topBorder to yBottom, 3 inputs odd → height=3
    const TOP = 0.5;
    return {
      x: this.position.x + 0.05,
      y: this.position.y - TOP,
      width: (COMP_WIDTH - 0.05) - 0.05,
      height: 3,
    };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["D", "C", "en"],
      outputLabels: ["Q"],
      clockInputIndices: [1],
      componentName: "Reg",
      width: 3,
      label: this._properties.getOrDefault<string>("label", ""),
    });
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

export function sampleRegister(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = layout.stateOffset(index);

  const d = state[wt[inBase]];
  const clock = state[wt[inBase + 1]];
  const en = state[wt[inBase + 2]];
  const prevClock = state[stBase + 1];

  if (clock !== 0 && prevClock === 0) {
    if (en !== 0) {
      state[stBase] = d;
    }
  }
  state[stBase + 1] = clock;
}

export function executeRegister(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const d = state[wt[inBase]];
  const clock = state[wt[inBase + 1]];
  const en = state[wt[inBase + 2]];
  const prevClock = state[stBase + 1];

  if (clock !== 0 && prevClock === 0) {
    if (en !== 0) {
      state[stBase] = d;
    }
  }
  state[stBase + 1] = clock;

  state[wt[outBase]] = state[stBase];
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
  sampleFn: sampleRegister,
  pinLayout: REGISTER_PIN_DECLARATIONS,
  propertyDefs: REGISTER_PROPERTY_DEFS,
  attributeMap: REGISTER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText:
    "Register — edge-triggered storage register with enable.\n" +
    "On rising clock edge: if en=1, captures D input into stored value.\n" +
    "Output Q always reflects the stored value.",
  stateSlotCount: 2,
  defaultDelay: 10,
};
