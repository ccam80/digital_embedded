/**
 * RegisterFile — edge-triggered register file with two read ports and one write port.
 *
 * Contains 2^addrBits registers, each of width bitWidth.
 * On rising clock edge, if we=1: write Din to register[Rw].
 * Read ports Da and Db always reflect register[Ra] and register[Rb] combinationally.
 *
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/memory/RegisterFile.java
 *
 * Input layout:  [Din=0, we=1, Rw=2, C=3, Ra=4, Rb=5]
 * Output layout: [Da=0, Db=1]
 * State layout:  [prevClock=0, reg[0]..reg[N-1]=1..N]
 *
 * The backing store for registers lives in state slots starting at stBase+1.
 * Number of registers N = 2^addrBits, accessed via getProperty("addrBits").
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import { drawGenericShape } from "../generic-shape.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
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
// GenericShape: 6 inputs, 2 outputs, width=4, symmetric=false (2 outputs)
// offs=0; Din@0,we@1,Rw@2,C@3,Ra@4,Rb@5; Da@(4,0),Db@(4,1)
// bodyHeight = max(6,2) = 6
const COMP_HEIGHT = 6;

// ---------------------------------------------------------------------------
// Pin declarations — y-positions shifted down by 1 from previous layout
// ---------------------------------------------------------------------------

const REGISTER_FILE_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "Din",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "we",
    defaultBitWidth: 1,
    position: { x: 0, y: 1 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "Rw",
    defaultBitWidth: 1,
    position: { x: 0, y: 2 },
    isNegatable: false,
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
    label: "Ra",
    defaultBitWidth: 1,
    position: { x: 0, y: 4 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "Rb",
    defaultBitWidth: 1,
    position: { x: 0, y: 5 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "Da",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "Db",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 1 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// RegisterFileElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class RegisterFileElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("RegisterFile", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(REGISTER_FILE_PIN_DECLARATIONS, ["C"]);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x + 0.05,
      y: this.position.y - 0.5,
      width: (COMP_WIDTH - 0.05) - 0.05,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["Din", "we", "Rw", "C", "Ra", "Rb"],
      outputLabels: ["Da", "Db"],
      clockInputIndices: [3],
      componentName: "Register",
      width: 4,
      label: this._properties.getOrDefault<string>("label", ""),
    });
  }

  getHelpText(): string {
    return (
      "RegisterFile — register file with 2 read ports and 1 write port.\n" +
      "On rising clock edge: if we=1, writes Din to register[Rw].\n" +
      "Da = register[Ra] and Db = register[Rb] always (combinational reads)."
    );
  }
}

// ---------------------------------------------------------------------------
// executeRegisterFile — flat simulation function
//
// Input layout:  [Din=0, we=1, Rw=2, C=3, Ra=4, Rb=5]
// Output layout: [Da=0, Db=1]
// State layout:  [prevClock=0, reg[0]..reg[N-1]=1..N]
//
// N = 2^addrBits; accessed via getProperty("addrBits").
// Registers are stored in state slots stBase+1 through stBase+N.
// Address inputs are masked to addrBits to prevent out-of-bounds access.
// ---------------------------------------------------------------------------

export function sampleRegisterFile(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const extLayout = layout as unknown as {
    stateOffset(i: number): number;
    getProperty?(i: number, key: string): number;
  };
  const stBase = extLayout.stateOffset(index);

  const din = state[wt[inBase]];
  const we = state[wt[inBase + 1]];
  const rw = state[wt[inBase + 2]];
  const clock = state[wt[inBase + 3]];
  const prevClock = state[stBase];

  const addrBits = extLayout.getProperty ? extLayout.getProperty(index, "addrBits") : 2;
  const numRegs = 1 << addrBits;
  const addrMask = numRegs - 1;

  if (clock !== 0 && prevClock === 0) {
    if (we !== 0) {
      const writeAddr = (rw >>> 0) & addrMask;
      state[stBase + 1 + writeAddr] = din;
    }
  }
  state[stBase] = clock;
}

export function executeRegisterFile(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const extLayout = layout as unknown as {
    stateOffset(i: number): number;
    getProperty?(i: number, key: string): number;
  };
  const stBase = extLayout.stateOffset(index);

  const din = state[wt[inBase]];
  const we = state[wt[inBase + 1]];
  const rw = state[wt[inBase + 2]];
  const clock = state[wt[inBase + 3]];
  const ra = state[wt[inBase + 4]];
  const rb = state[wt[inBase + 5]];
  const prevClock = state[stBase];

  const addrBits = extLayout.getProperty ? extLayout.getProperty(index, "addrBits") : 2;
  const numRegs = 1 << addrBits;
  const addrMask = numRegs - 1;

  if (clock !== 0 && prevClock === 0) {
    if (we !== 0) {
      const writeAddr = (rw >>> 0) & addrMask;
      state[stBase + 1 + writeAddr] = din;
    }
  }
  state[stBase] = clock;

  const readAddrA = (ra >>> 0) & addrMask;
  const readAddrB = (rb >>> 0) & addrMask;
  state[wt[outBase]] = state[stBase + 1 + readAddrA];
  state[wt[outBase + 1]] = state[stBase + 1 + readAddrB];
}

// ---------------------------------------------------------------------------
// REGISTER_FILE_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const REGISTER_FILE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "AddrBits", propertyKey: "addrBits", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const REGISTER_FILE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 8,
    min: 1,
    max: 32,
    description: "Bit width of each register",
  },
  {
    key: "addrBits",
    type: PropertyType.INT,
    label: "Address bits",
    defaultValue: 2,
    min: 1,
    max: 8,
    description: "Number of address bits (register count = 2^addrBits)",
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
// RegisterFileDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function registerFileFactory(props: PropertyBag): RegisterFileElement {
  return new RegisterFileElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RegisterFileDefinition: ComponentDefinition = {
  name: "RegisterFile",
  typeId: -1,
  factory: registerFileFactory,
  executeFn: executeRegisterFile,
  sampleFn: sampleRegisterFile,
  pinLayout: REGISTER_FILE_PIN_DECLARATIONS,
  propertyDefs: REGISTER_FILE_PROPERTY_DEFS,
  attributeMap: REGISTER_FILE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText:
    "RegisterFile — register file with 2 read ports and 1 write port.\n" +
    "On rising clock edge: if we=1, writes Din to register[Rw].\n" +
    "Da = register[Ra] and Db = register[Rb] always (combinational reads).",
  stateSlotCount: (props) => 1 + (1 << (props.getOrDefault<number>("addrBits", 2))),
  defaultDelay: 10,
};
