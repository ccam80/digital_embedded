/**
 * ProgramMemory — ROM with address auto-increment for instruction fetch.
 *
 * On each rising clock edge, the internal address register increments
 * (auto-increment for sequential instruction fetch). If ld=1, the address
 * is loaded from the external A input (jump/branch). The current memory word
 * at the internal address is always presented on the output D.
 *
 * This component allows a CPU's instruction fetch stage to be implemented
 * without a separate program counter: the memory itself tracks the PC.
 * For separate PC + ROM designs, use ProgramCounter + ROM instead.
 *
 * isProgramMemory flag allows Phase 6 to preload program binary data.
 *
 * internalStateCount: 2 (current address register, prevClock)
 * backingStoreType: 'datafield'
 *
 * Input layout:  [A=0, ld=1, C=2]
 * Output layout: [D=0]
 * State layout:  [addrReg=0, prevClock=1]
 *
 * Ported from the ProgramMemory concept in Digital's memory package.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
  layoutPinsOnFace,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { getBackingStore } from "./ram.js";

// Re-export so tests can import DataField from this module.
export { DataField, registerBackingStore, clearBackingStores } from "./ram.js";

// ---------------------------------------------------------------------------
// Layout type with stateOffset
// ---------------------------------------------------------------------------

export interface ProgramMemoryLayout extends ComponentLayout {
  stateOffset(componentIndex: number): number;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 5;
const COMP_HEIGHT = 6;

// ---------------------------------------------------------------------------
// Pin layout helper
// ---------------------------------------------------------------------------

function buildProgramMemoryPins(addrBits: number, dataBits: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 3, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    {
      direction: PinDirection.INPUT,
      label: "A",
      defaultBitWidth: addrBits,
      position: inputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "ld",
      defaultBitWidth: 1,
      position: inputPositions[1],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "C",
      defaultBitWidth: 1,
      position: inputPositions[2],
      isNegatable: false,
      isClockCapable: true,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "D",
      defaultBitWidth: dataBits,
      position: outputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// ProgramMemoryElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ProgramMemoryElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("ProgramMemory", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const addrBits = this._properties.getOrDefault<number>("addrBits", 8);
    const dataBits = this._properties.getOrDefault<number>("dataBits", 8);
    return resolvePins(
      buildProgramMemoryPins(addrBits, dataBits),
      { x: 0, y: 0 },
      0,
      createInverterConfig([]),
      { clockPins: new Set(["C"]) },
    );
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
    ctx.setFont({ family: "sans-serif", size: 0.9, weight: "bold" });
    ctx.drawText("PMEM", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 0.9 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.5, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  get isProgramMemory(): boolean {
    return this._properties.getOrDefault<boolean>("isProgramMemory", true);
  }

  getHelpText(): string {
    return (
      "ProgramMemory — ROM with built-in address auto-increment.\n" +
      "On rising clock edge: if ld=1, jumps to address A; else address increments by 1.\n" +
      "Output D always reflects memory[current_address].\n" +
      "Designed for instruction fetch in CPU circuits.\n" +
      "Set isProgramMemory=true to allow Phase 6 to preload a program binary."
    );
  }
}

// ---------------------------------------------------------------------------
// executeProgramMemory — flat simulation function
//
// Input layout:  [A=0, ld=1, C=2]
// Output layout: [D=0]
// State layout:  [addrReg=0, prevClock=1]
// ---------------------------------------------------------------------------

export function sampleProgramMemory(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = (layout as ProgramMemoryLayout).stateOffset(index);

  const A = state[wt[inBase]] >>> 0;
  const ld = state[wt[inBase + 1]] & 1;
  const clk = state[wt[inBase + 2]] & 1;
  const prevClock = state[stBase + 1] & 1;

  let addrReg = state[stBase] >>> 0;

  if (!prevClock && clk) {
    if (ld) {
      addrReg = A;
    } else {
      addrReg = (addrReg + 1) >>> 0;
    }
  }

  state[stBase] = addrReg;
  state[stBase + 1] = clk;
}

export function executeProgramMemory(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as ProgramMemoryLayout).stateOffset(index);

  const A = state[wt[inBase]] >>> 0;
  const ld = state[wt[inBase + 1]] & 1;
  const clk = state[wt[inBase + 2]] & 1;
  const prevClock = state[stBase + 1] & 1;

  let addrReg = state[stBase] >>> 0;

  if (!prevClock && clk) {
    if (ld) {
      addrReg = A;
    } else {
      addrReg = (addrReg + 1) >>> 0;
    }
  }

  state[stBase] = addrReg;
  state[stBase + 1] = clk;

  const mem = getBackingStore(index);
  state[wt[outBase]] = mem !== undefined ? mem.read(addrReg) : 0;
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const PROGRAM_MEMORY_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "dataBits", convert: (v) => parseInt(v, 10) },
  { xmlName: "AddrBits", propertyKey: "addrBits", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "isProgramMemory", propertyKey: "isProgramMemory", convert: (v) => v === "true" },
];

const PROGRAM_MEMORY_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "addrBits",
    type: PropertyType.INT,
    label: "Address bits",
    defaultValue: 8,
    min: 1,
    max: 24,
    description: "Address bit width (memory size = 2^addrBits words)",
  },
  {
    key: "dataBits",
    type: PropertyType.BIT_WIDTH,
    label: "Data bits",
    defaultValue: 8,
    min: 1,
    max: 32,
    description: "Bit width of each memory word (instruction width)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
  {
    key: "isProgramMemory",
    type: PropertyType.BOOLEAN,
    label: "Is program memory",
    defaultValue: true,
    description: "Allow Phase 6 to preload a program binary into this memory",
  },
];

function programMemoryFactory(props: PropertyBag): ProgramMemoryElement {
  return new ProgramMemoryElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ProgramMemoryDefinition: ComponentDefinition = {
  name: "ProgramMemory",
  typeId: -1,
  factory: programMemoryFactory,
  pinLayout: buildProgramMemoryPins(8, 8),
  propertyDefs: PROGRAM_MEMORY_PROPERTY_DEFS,
  attributeMap: PROGRAM_MEMORY_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "ProgramMemory — ROM with address auto-increment for CPU instruction fetch.",
  models: {
    digital: {
      executeFn: executeProgramMemory,
      sampleFn: sampleProgramMemory,
      inputSchema: ["A", "ld", "C"],
      outputSchema: ["D"],
      stateSlotCount: 2,
      defaultDelay: 10,
    },
  },
};
