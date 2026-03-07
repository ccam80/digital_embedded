/**
 * ProgramCounter — edge-triggered counter with jump (load) support.
 *
 * Used as the instruction pointer in CPU circuits. On each rising clock edge:
 *   - If ld=1 (load): PC = D (jump to address)
 *   - Else if en=1 (enable): PC = PC + 1
 *
 * Outputs the current PC value on Q. Also outputs an overflow flag (ovf)
 * when PC wraps from maxValue back to 0.
 *
 * isProgramCounter flag identifies this component as the program counter for
 * Phase 6 debugger integration (breakpoints, step-over, etc.).
 *
 * internalStateCount: 2 (counter value, prevClock)
 *
 * Input layout:  [D=0, en=1, C=2, ld=3]
 * Output layout: [Q=0, ovf=1]
 * State layout:  [counter=0, prevClock=1]
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
// Layout type with stateOffset
// ---------------------------------------------------------------------------

export interface ProgramCounterLayout extends ComponentLayout {
  stateOffset(componentIndex: number): number;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 4;
const COMP_HEIGHT = 6;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const PROGRAM_COUNTER_PIN_DECLARATIONS: PinDeclaration[] = [
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
    label: "en",
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
    label: "ld",
    defaultBitWidth: 1,
    position: { x: 0, y: 4 },
    isNegatable: false,
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
  {
    direction: PinDirection.OUTPUT,
    label: "ovf",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 4 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// ProgramCounterElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ProgramCounterElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _isProgramCounter: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("ProgramCounter", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 8);
    this._isProgramCounter = props.getOrDefault<boolean>("isProgramCounter", true);
    this._pins = resolvePins(
      PROGRAM_COUNTER_PIN_DECLARATIONS,
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
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.85, weight: "bold" });
    ctx.drawText("PC", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });

    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText("D", 0.5, 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("en", 0.5, 2, { horizontal: "left", vertical: "middle" });
    ctx.drawText("C", 0.5, 3, { horizontal: "left", vertical: "middle" });
    ctx.drawText("ld", 0.5, 4, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Q", COMP_WIDTH - 0.5, 2, { horizontal: "right", vertical: "middle" });
    ctx.drawText("ovf", COMP_WIDTH - 0.5, 4, { horizontal: "right", vertical: "middle" });

    ctx.setColor("COMPONENT");
    ctx.drawLine(0, 2.5, 0.5, 3);
    ctx.drawLine(0.5, 3, 0, 3.5);

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.9 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.5, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  get isProgramCounter(): boolean {
    return this._isProgramCounter;
  }

  getHelpText(): string {
    return (
      "ProgramCounter — edge-triggered counter with jump support.\n" +
      "On rising clock edge: if ld=1, jumps to address D; else if en=1, PC increments.\n" +
      "Output Q holds the current program counter value.\n" +
      "Output ovf goes high when the counter wraps from maxValue to 0.\n" +
      "Set isProgramCounter=true to identify this as the CPU program counter."
    );
  }
}

// ---------------------------------------------------------------------------
// executeProgramCounter — flat simulation function
//
// Input layout:  [D=0, en=1, C=2, ld=3]
// Output layout: [Q=0, ovf=1]
// State layout:  [counter=0, prevClock=1]
// ---------------------------------------------------------------------------

export function sampleProgramCounter(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = (layout as ProgramCounterLayout).stateOffset(index);

  const D = state[wt[inBase]] >>> 0;
  const en = state[wt[inBase + 1]] & 1;
  const clk = state[wt[inBase + 2]] & 1;
  const ld = state[wt[inBase + 3]] & 1;
  const prevClock = state[stBase + 1] & 1;

  let counter = state[stBase] >>> 0;

  if (!prevClock && clk) {
    if (ld) {
      counter = D;
    } else if (en) {
      counter = (counter + 1) >>> 0;
    }
  }

  state[stBase] = counter;
  state[stBase + 1] = clk;
}

export function executeProgramCounter(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as ProgramCounterLayout).stateOffset(index);

  const D = state[wt[inBase]] >>> 0;
  const en = state[wt[inBase + 1]] & 1;
  const clk = state[wt[inBase + 2]] & 1;
  const ld = state[wt[inBase + 3]] & 1;
  const prevClock = state[stBase + 1] & 1;

  let counter = state[stBase] >>> 0;
  let ovf = 0;

  if (!prevClock && clk) {
    if (ld) {
      counter = D;
    } else if (en) {
      counter = (counter + 1) >>> 0;
      if (counter === 0) {
        ovf = 1;
      }
    }
  }

  state[stBase] = counter;
  state[stBase + 1] = clk;
  state[wt[outBase]] = counter;
  state[wt[outBase + 1]] = ovf;
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const PROGRAM_COUNTER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "isProgramCounter", propertyKey: "isProgramCounter", convert: (v) => v === "true" },
];

const PROGRAM_COUNTER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 8,
    min: 1,
    max: 32,
    description: "Bit width of the counter (address bus width)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
  {
    key: "isProgramCounter",
    type: PropertyType.BOOLEAN,
    label: "Is program counter",
    defaultValue: true,
    description: "Identifies this component as the CPU program counter for debugger integration",
  },
];

function programCounterFactory(props: PropertyBag): ProgramCounterElement {
  return new ProgramCounterElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ProgramCounterDefinition: ComponentDefinition = {
  name: "ProgramCounter",
  typeId: -1,
  factory: programCounterFactory,
  executeFn: executeProgramCounter,
  sampleFn: sampleProgramCounter,
  pinLayout: PROGRAM_COUNTER_PIN_DECLARATIONS,
  propertyDefs: PROGRAM_COUNTER_PROPERTY_DEFS,
  attributeMap: PROGRAM_COUNTER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "ProgramCounter — edge-triggered instruction pointer with jump support.",
  stateSlotCount: 2,
  defaultDelay: 10,
};
