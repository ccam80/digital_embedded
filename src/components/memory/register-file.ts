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

const COMP_WIDTH = 5;
const COMP_HEIGHT = 8;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const REGISTER_FILE_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "Din",
    defaultBitWidth: 1,
    position: { x: 0, y: 1 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "we",
    defaultBitWidth: 1,
    position: { x: 0, y: 2 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "Rw",
    defaultBitWidth: 1,
    position: { x: 0, y: 3 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "C",
    defaultBitWidth: 1,
    position: { x: 0, y: 4 },
    isNegatable: false,
    isClockCapable: true,
  },
  {
    direction: PinDirection.INPUT,
    label: "Ra",
    defaultBitWidth: 1,
    position: { x: 0, y: 5 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "Rb",
    defaultBitWidth: 1,
    position: { x: 0, y: 6 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "Da",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 2 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "Db",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 6 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// RegisterFileElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class RegisterFileElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _addrBits: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("RegisterFile", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 8);
    this._addrBits = props.getOrDefault<number>("addrBits", 2);
    this._pins = resolvePins(
      REGISTER_FILE_PIN_DECLARATIONS,
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
    ctx.drawText("Din", 0.5, 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("we", 0.5, 2, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Rw", 0.5, 3, { horizontal: "left", vertical: "middle" });
    ctx.drawText("C", 0.5, 4, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Ra", 0.5, 5, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Rb", 0.5, 6, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Da", COMP_WIDTH - 0.5, 2, { horizontal: "right", vertical: "middle" });
    ctx.drawText("Db", COMP_WIDTH - 0.5, 6, { horizontal: "right", vertical: "middle" });

    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText("RF", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });

    ctx.setColor("COMPONENT");
    ctx.drawLine(0, 3.5, 0.5, 4);
    ctx.drawLine(0.5, 4, 0, 4.5);

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

export function executeRegisterFile(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const extLayout = layout as unknown as {
    stateOffset(i: number): number;
    getProperty?(i: number, key: string): number;
  };
  const stBase = extLayout.stateOffset(index);

  const din = state[inBase];
  const we = state[inBase + 1];
  const rw = state[inBase + 2];
  const clock = state[inBase + 3];
  const ra = state[inBase + 4];
  const rb = state[inBase + 5];
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
  state[outBase] = state[stBase + 1 + readAddrA];
  state[outBase + 1] = state[stBase + 1 + readAddrB];
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
  pinLayout: REGISTER_FILE_PIN_DECLARATIONS,
  propertyDefs: REGISTER_FILE_PROPERTY_DEFS,
  attributeMap: REGISTER_FILE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText:
    "RegisterFile — register file with 2 read ports and 1 write port.\n" +
    "On rising clock edge: if we=1, writes Din to register[Rw].\n" +
    "Da = register[Ra] and Db = register[Rb] always (combinational reads).",
  defaultDelay: 10,
};
