/**
 * EEPROM components — EEPROM and EEPROMDualPort.
 *
 * EEPROM: electrically-erasable programmable read-only memory.
 *   Inputs: A (addrBits), CS (1), WE (1 clock), OE (1), Din (dataBits)
 *   Output: D (dataBits, bidirectional)
 *   Behaviour:
 *     - CS=1 selects chip.
 *     - WE is clock-like: on the falling edge of WE (while CS=1), the data
 *       present on Din is written to memory[A] (the address captured on
 *       the rising edge of WE).
 *     - If CS=1 and OE=1 and WE=0: D = memory[A]; otherwise D = 0.
 *   internalStateCount: 2  (lastWE flag + captured write address)
 *
 * EEPROMDualPort: same write port as EEPROM but with a separate synchronous
 *   read port (identical to RAMDualPort's read port).
 *   Inputs: A (addrBits), Din (dataBits), str (1), C (1 clock), ld (1)
 *   Output: D (dataBits)
 *   Write: on rising clock edge, if str=1, write Din to memory[A].
 *   Read:  if ld=1, D = memory[A]; else D = 0.
 *   internalStateCount: 1  (lastClk)
 *
 * Both declare backingStoreType: 'datafield'. The Phase 3 engine populates
 * the backing store registry before calling executeFn.
 *
 * Ported from:
 *   ref/Digital/src/main/java/de/neemann/digital/core/memory/EEPROM.java
 *   ref/Digital/src/main/java/de/neemann/digital/core/memory/EEPROMDualPort.java
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

// Re-export so test files can import the layout type from this module.
export type { RAMLayout } from "./ram.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 5;
const COMP_HEIGHT = 7;

// ---------------------------------------------------------------------------
// Shared rendering helper
// ---------------------------------------------------------------------------

function drawEEPROMBody(ctx: RenderContext, label: string, symbol: string): void {
  ctx.setColor("COMPONENT_FILL");
  ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);
  ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

  ctx.setColor("TEXT");
  ctx.setFont({ family: "sans-serif", size: 1.0, weight: "bold" });
  ctx.drawText(symbol, COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });

  if (label.length > 0) {
    ctx.setFont({ family: "sans-serif", size: 0.9 });
    ctx.drawText(label, COMP_WIDTH / 2, -0.5, { horizontal: "center", vertical: "bottom" });
  }
}

// ---------------------------------------------------------------------------
// Shared property definitions
// ---------------------------------------------------------------------------

const ADDR_BITS_DEF: PropertyDefinition = {
  key: "addrBits",
  type: PropertyType.INT,
  label: "Address bits",
  defaultValue: 4,
  min: 1,
  max: 24,
  description: "Number of address bits (memory size = 2^addrBits words)",
};

const DATA_BITS_DEF: PropertyDefinition = {
  key: "dataBits",
  type: PropertyType.BIT_WIDTH,
  label: "Data bits",
  defaultValue: 8,
  min: 1,
  max: 32,
  description: "Bit width of each memory word",
};

const LABEL_DEF: PropertyDefinition = {
  key: "label",
  type: PropertyType.STRING,
  label: "Label",
  defaultValue: "",
  description: "Optional label shown above the component",
};

const IS_PROGRAM_MEMORY_DEF: PropertyDefinition = {
  key: "isProgramMemory",
  type: PropertyType.BOOLEAN,
  label: "Is program memory",
  defaultValue: false,
  description: "Mark as program memory for CPU instruction fetch integration",
};

const SHARED_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "dataBits", convert: (v) => parseInt(v, 10) },
  { xmlName: "AddrBits", propertyKey: "addrBits", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "isProgramMemory", propertyKey: "isProgramMemory", convert: (v) => v === "true" },
];

// ---------------------------------------------------------------------------
// EEPROM layout type (needs stateOffset)
// ---------------------------------------------------------------------------

export interface EEPROMLayout extends ComponentLayout {
  stateOffset(componentIndex: number): number;
}

// ---------------------------------------------------------------------------
// EEPROM
// ---------------------------------------------------------------------------
// Inputs:  A (addrBits), CS (1), WE (1 clock-like), OE (1), Din (dataBits)
// Outputs: D (dataBits)
//
// Write protocol (falling-edge triggered):
//   - On rising edge of WE (CS=1): capture write address from A.
//   - On falling edge of WE (CS=1): write Din to memory[capturedAddr].
// Read:
//   - If CS=1 && OE=1 && WE=0: D = memory[A]; else D = 0.
//
// State slots (via stateOffset):
//   +0: lastWE  (previous WE value for edge detection)
//   +1: writeAddr (address captured on WE rising edge)
// ---------------------------------------------------------------------------

function buildEEPROMPins(addrBits: number, dataBits: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 5, COMP_WIDTH, COMP_HEIGHT);
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
      label: "CS",
      defaultBitWidth: 1,
      position: inputPositions[1],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "WE",
      defaultBitWidth: 1,
      position: inputPositions[2],
      isNegatable: false,
      isClockCapable: true,
    },
    {
      direction: PinDirection.INPUT,
      label: "OE",
      defaultBitWidth: 1,
      position: inputPositions[3],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "Din",
      defaultBitWidth: dataBits,
      position: inputPositions[4],
      isNegatable: false,
      isClockCapable: false,
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

export class EEPROMElement extends AbstractCircuitElement {
  private readonly _addrBits: number;
  private readonly _dataBits: number;
  private readonly _isProgramMemory: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("EEPROM", instanceId, position, rotation, mirror, props);
    this._addrBits = props.getOrDefault<number>("addrBits", 4);
    this._dataBits = props.getOrDefault<number>("dataBits", 8);
    this._isProgramMemory = props.getOrDefault<boolean>("isProgramMemory", false);
    this._pins = resolvePins(
      buildEEPROMPins(this._addrBits, this._dataBits),
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set(["WE"]) },
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
    drawEEPROMBody(ctx, this._properties.getOrDefault<string>("label", ""), "EEPROM");
    ctx.restore();
  }

  get isProgramMemory(): boolean {
    return this._isProgramMemory;
  }

  getHelpText(): string {
    return (
      "EEPROM — electrically-erasable programmable read-only memory.\n" +
      "Write: CS=1, WE=1 captures the write address on WE rising edge;\n" +
      "on WE falling edge, Din is written to memory[capturedAddr].\n" +
      "Read: CS=1 and OE=1 and WE=0 outputs memory[A] on D.\n" +
      "Written data persists across simulation resets (saved to .dig file)."
    );
  }
}

export function executeEEPROM(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as EEPROMLayout).stateOffset(index);

  const A = state[inBase] >>> 0;
  const cs = state[inBase + 1] & 1;
  const we = state[inBase + 2] & 1;
  const oe = state[inBase + 3] & 1;
  const din = state[inBase + 4] >>> 0;

  const lastWE = state[stBase] & 1;
  const writeAddr = state[stBase + 1] >>> 0;

  if (cs) {
    // Rising edge of WE: capture address for upcoming write
    if (!lastWE && we) {
      state[stBase + 1] = A;
    }
    // Falling edge of WE: commit write using address captured on rising edge
    if (lastWE && !we) {
      const mem = getBackingStore(index);
      if (mem !== undefined) {
        mem.write(writeAddr, din);
      }
    }
  }

  // Read: CS=1, OE=1, WE=0
  if (cs && oe && !we) {
    const mem = getBackingStore(index);
    state[outBase] = mem !== undefined ? mem.read(A) : 0;
  } else {
    state[outBase] = 0;
  }

  state[stBase] = we;
}

export const EEPROM_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [...SHARED_ATTRIBUTE_MAPPINGS];

const EEPROM_PROPERTY_DEFS: PropertyDefinition[] = [
  ADDR_BITS_DEF,
  DATA_BITS_DEF,
  LABEL_DEF,
  IS_PROGRAM_MEMORY_DEF,
];

function eepromFactory(props: PropertyBag): EEPROMElement {
  return new EEPROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const EEPROMDefinition: ComponentDefinition = {
  name: "EEPROM",
  typeId: -1,
  factory: eepromFactory,
  executeFn: executeEEPROM,
  pinLayout: buildEEPROMPins(4, 8),
  propertyDefs: EEPROM_PROPERTY_DEFS,
  attributeMap: EEPROM_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "EEPROM — electrically-erasable ROM. WE-edge write, combinational read.",
  defaultDelay: 10,
};

// ---------------------------------------------------------------------------
// EEPROMDualPort
// ---------------------------------------------------------------------------
// Inputs:  A (addrBits), Din (dataBits), str (1), C (1 clock), ld (1)
// Outputs: D (dataBits)
//
// Identical port interface to RAMDualPort. Behaves like writable ROM:
// data written during simulation is preserved (saved back to .dig DATA attr).
//
// On rising clock edge: if str=1, write Din to memory[A].
// If ld=1, D = memory[A]; else D = 0.
//
// State slots (via stateOffset):
//   +0: lastClk
// ---------------------------------------------------------------------------

function buildEEPROMDualPortPins(addrBits: number, dataBits: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 5, COMP_WIDTH, COMP_HEIGHT);
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
      label: "Din",
      defaultBitWidth: dataBits,
      position: inputPositions[1],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "str",
      defaultBitWidth: 1,
      position: inputPositions[2],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "C",
      defaultBitWidth: 1,
      position: inputPositions[3],
      isNegatable: false,
      isClockCapable: true,
    },
    {
      direction: PinDirection.INPUT,
      label: "ld",
      defaultBitWidth: 1,
      position: inputPositions[4],
      isNegatable: false,
      isClockCapable: false,
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

export class EEPROMDualPortElement extends AbstractCircuitElement {
  private readonly _addrBits: number;
  private readonly _dataBits: number;
  private readonly _isProgramMemory: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("EEPROMDualPort", instanceId, position, rotation, mirror, props);
    this._addrBits = props.getOrDefault<number>("addrBits", 4);
    this._dataBits = props.getOrDefault<number>("dataBits", 8);
    this._isProgramMemory = props.getOrDefault<boolean>("isProgramMemory", false);
    this._pins = resolvePins(
      buildEEPROMDualPortPins(this._addrBits, this._dataBits),
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set(["C"]) },
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
    drawEEPROMBody(ctx, this._properties.getOrDefault<string>("label", ""), "EEPROM2");
    ctx.restore();
  }

  get isProgramMemory(): boolean {
    return this._isProgramMemory;
  }

  getHelpText(): string {
    return (
      "EEPROMDualPort — EEPROM with separate read/write port (like RAMDualPort).\n" +
      "On rising clock edge: if str=1, writes Din to memory[A].\n" +
      "If ld=1, output D = memory[A]; otherwise D is 0.\n" +
      "Written data persists across simulation resets (saved to .dig file)."
    );
  }
}

export function executeEEPROMDualPort(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as EEPROMLayout).stateOffset(index);

  const A = state[inBase] >>> 0;
  const din = state[inBase + 1] >>> 0;
  const str = state[inBase + 2] & 1;
  const clk = state[inBase + 3] & 1;
  const ld = state[inBase + 4] & 1;
  const lastClk = state[stBase] & 1;

  if (!lastClk && clk) {
    if (str) {
      const mem = getBackingStore(index);
      if (mem !== undefined) {
        mem.write(A, din);
      }
    }
  }

  if (ld) {
    const mem = getBackingStore(index);
    state[outBase] = mem !== undefined ? mem.read(A) : 0;
  } else {
    state[outBase] = 0;
  }

  state[stBase] = clk;
}

export const EEPROM_DUAL_PORT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [...SHARED_ATTRIBUTE_MAPPINGS];

const EEPROM_DUAL_PORT_PROPERTY_DEFS: PropertyDefinition[] = [
  ADDR_BITS_DEF,
  DATA_BITS_DEF,
  LABEL_DEF,
  IS_PROGRAM_MEMORY_DEF,
];

function eepromDualPortFactory(props: PropertyBag): EEPROMDualPortElement {
  return new EEPROMDualPortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const EEPROMDualPortDefinition: ComponentDefinition = {
  name: "EEPROMDualPort",
  typeId: -1,
  factory: eepromDualPortFactory,
  executeFn: executeEEPROMDualPort,
  pinLayout: buildEEPROMDualPortPins(4, 8),
  propertyDefs: EEPROM_DUAL_PORT_PROPERTY_DEFS,
  attributeMap: EEPROM_DUAL_PORT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "EEPROMDualPort — EEPROM with clock-synchronous write and combinational read.",
  defaultDelay: 10,
};
