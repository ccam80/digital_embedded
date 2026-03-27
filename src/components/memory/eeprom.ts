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
import { drawGenericShape } from "../generic-shape.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
} from "../../core/pin.js";
import { PropertyBag, PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
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

const COMP_WIDTH = 3;
// 5-input variants (odd, symmetric): offs=2; inputs y=0,1,2,3,4; output y=2; maxPinY=4; bodyHeight=5
const COMP_HEIGHT = 5;

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

const IS_PROGRAM_MEMORY_DEF: PropertyDefinition = {
  key: "isProgramMemory",
  type: PropertyType.BOOLEAN,
  label: "Is program memory",
  defaultValue: false,
  description: "Mark as program memory for CPU instruction fetch integration",
};

const DATA_DEF: PropertyDefinition = {
  key: "data",
  type: PropertyType.HEX_DATA,
  label: "Data",
  defaultValue: [],
  description: "Initial memory contents as hex values (one word per entry)",
};

const SHARED_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "dataBits", convert: (v) => parseInt(v, 10) },
  { xmlName: "AddrBits", propertyKey: "addrBits", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "isProgramMemory", propertyKey: "isProgramMemory", convert: (v) => v === "true" },
  { xmlName: "Data", propertyKey: "data", convert: (v) => {
    try { const p = JSON.parse(v); if (Array.isArray(p)) return p.map(Number); } catch { /* ignore */ }
    if (v.trim() === '') return [];
    return v.trim().split(/[\s,]+/).map((s: string) => parseInt(s, 16));
  }},
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

// EEPROM: 5 inputs (odd, symmetric): offs=2; A@y=0,CS@y=1,WE@y=2,OE@y=3,Din@y=4; D@y=2
function buildEEPROMPins(addrBits: number, dataBits: number): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "A", defaultBitWidth: addrBits, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "CS", defaultBitWidth: 1, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "WE", defaultBitWidth: 1, position: { x: 0, y: 2 }, isNegatable: false, isClockCapable: true },
    { direction: PinDirection.INPUT, label: "OE", defaultBitWidth: 1, position: { x: 0, y: 3 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "Din", defaultBitWidth: dataBits, position: { x: 0, y: 4 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "D", defaultBitWidth: dataBits, position: { x: COMP_WIDTH, y: 2 }, isNegatable: false, isClockCapable: false },
  ];
}

export class EEPROMElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("EEPROM", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const addrBits = this._properties.getOrDefault<number>("addrBits", 4);
    const dataBits = this._properties.getOrDefault<number>("dataBits", 8);
    return resolvePins(
      buildEEPROMPins(addrBits, dataBits),
      { x: 0, y: 0 },
      0,
      createInverterConfig([]),
      { clockPins: new Set(["WE"]) },
    );
  }

  getBoundingBox(): Rect {
    return { x: this.position.x + 0.05, y: this.position.y - 0.5, width: (COMP_WIDTH - 0.05) - 0.05, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["A", "CS", "WE", "OE"],
      outputLabels: ["D"],
      clockInputIndices: [2],
      componentName: "EEPROM",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
  }

  get isProgramMemory(): boolean {
    return this._properties.getOrDefault<boolean>("isProgramMemory", false);
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

export function sampleEEPROM(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = (layout as EEPROMLayout).stateOffset(index);

  const A = state[wt[inBase]] >>> 0;
  const cs = state[wt[inBase + 1]] & 1;
  const we = state[wt[inBase + 2]] & 1;
  const din = state[wt[inBase + 4]] >>> 0;

  const lastWE = state[stBase] & 1;
  const writeAddr = state[stBase + 1] >>> 0;

  if (cs) {
    if (!lastWE && we) {
      state[stBase + 1] = A;
    }
    if (lastWE && !we) {
      const mem = getBackingStore(index);
      if (mem !== undefined) {
        mem.write(writeAddr, din);
      }
    }
  }

  state[stBase] = we;
}

export function executeEEPROM(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const A = state[wt[inBase]] >>> 0;
  const cs = state[wt[inBase + 1]] & 1;
  const we = state[wt[inBase + 2]] & 1;
  const oe = state[wt[inBase + 3]] & 1;

  if (cs && oe && !we) {
    const mem = getBackingStore(index);
    state[wt[outBase]] = mem !== undefined ? mem.read(A) : 0;
  } else {
    state[wt[outBase]] = 0;
  }
}

export const EEPROM_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [...SHARED_ATTRIBUTE_MAPPINGS];

const EEPROM_PROPERTY_DEFS: PropertyDefinition[] = [
  ADDR_BITS_DEF,
  DATA_BITS_DEF,
  LABEL_PROPERTY_DEF,
  IS_PROGRAM_MEMORY_DEF,
  DATA_DEF,
];

function eepromFactory(props: PropertyBag): EEPROMElement {
  return new EEPROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const EEPROMDefinition: ComponentDefinition = {
  name: "EEPROM",
  typeId: -1,
  factory: eepromFactory,
  pinLayout: buildEEPROMPins(4, 8),
  propertyDefs: EEPROM_PROPERTY_DEFS,
  attributeMap: EEPROM_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "EEPROM — electrically-erasable ROM. WE-edge write, combinational read.",
  models: {
    digital: {
      executeFn: executeEEPROM,
      sampleFn: sampleEEPROM,
      inputSchema: ["A", "CS", "WE", "OE", "Din"],
      outputSchema: ["D"],
      stateSlotCount: 2,
      defaultDelay: 10,
    },
  },
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

// EEPROMDualPort: 5 inputs (odd, symmetric): offs=2; A@y=0,Din@y=1,str@y=2,C@y=3,ld@y=4; D@y=2
function buildEEPROMDualPortPins(addrBits: number, dataBits: number): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "A", defaultBitWidth: addrBits, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "Din", defaultBitWidth: dataBits, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "str", defaultBitWidth: 1, position: { x: 0, y: 2 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "C", defaultBitWidth: 1, position: { x: 0, y: 3 }, isNegatable: false, isClockCapable: true },
    { direction: PinDirection.INPUT, label: "ld", defaultBitWidth: 1, position: { x: 0, y: 4 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "D", defaultBitWidth: dataBits, position: { x: COMP_WIDTH, y: 2 }, isNegatable: false, isClockCapable: false },
  ];
}

export class EEPROMDualPortElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("EEPROMDualPort", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const addrBits = this._properties.getOrDefault<number>("addrBits", 4);
    const dataBits = this._properties.getOrDefault<number>("dataBits", 8);
    return resolvePins(
      buildEEPROMDualPortPins(addrBits, dataBits),
      { x: 0, y: 0 },
      0,
      createInverterConfig([]),
      { clockPins: new Set(["C"]) },
    );
  }

  getBoundingBox(): Rect {
    return { x: this.position.x + 0.05, y: this.position.y - 0.5, width: (COMP_WIDTH - 0.05) - 0.05, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["A", "Din", "str", "C", "ld"],
      outputLabels: ["D"],
      clockInputIndices: [3],
      componentName: "EEPROM",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
  }

  get isProgramMemory(): boolean {
    return this._properties.getOrDefault<boolean>("isProgramMemory", false);
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

export function sampleEEPROMDualPort(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = (layout as EEPROMLayout).stateOffset(index);

  const A = state[wt[inBase]] >>> 0;
  const din = state[wt[inBase + 1]] >>> 0;
  const str = state[wt[inBase + 2]] & 1;
  const clk = state[wt[inBase + 3]] & 1;
  const lastClk = state[stBase] & 1;

  if (!lastClk && clk) {
    if (str) {
      const mem = getBackingStore(index);
      if (mem !== undefined) {
        mem.write(A, din);
      }
    }
  }

  state[stBase] = clk;
}

export function executeEEPROMDualPort(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const A = state[wt[inBase]] >>> 0;
  const ld = state[wt[inBase + 4]] & 1;

  if (ld) {
    const mem = getBackingStore(index);
    state[wt[outBase]] = mem !== undefined ? mem.read(A) : 0;
  } else {
    state[wt[outBase]] = 0;
  }
}

export const EEPROM_DUAL_PORT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [...SHARED_ATTRIBUTE_MAPPINGS];

const EEPROM_DUAL_PORT_PROPERTY_DEFS: PropertyDefinition[] = [
  ADDR_BITS_DEF,
  DATA_BITS_DEF,
  LABEL_PROPERTY_DEF,
  IS_PROGRAM_MEMORY_DEF,
  DATA_DEF,
];

function eepromDualPortFactory(props: PropertyBag): EEPROMDualPortElement {
  return new EEPROMDualPortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const EEPROMDualPortDefinition: ComponentDefinition = {
  name: "EEPROMDualPort",
  typeId: -1,
  factory: eepromDualPortFactory,
  pinLayout: buildEEPROMDualPortPins(4, 8),
  propertyDefs: EEPROM_DUAL_PORT_PROPERTY_DEFS,
  attributeMap: EEPROM_DUAL_PORT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "EEPROMDualPort — EEPROM with clock-synchronous write and combinational read.",
  models: {
    digital: {
      executeFn: executeEEPROMDualPort,
      sampleFn: sampleEEPROMDualPort,
      inputSchema: ["A", "Din", "str", "C", "ld"],
      outputSchema: ["D"],
      stateSlotCount: 1,
      defaultDelay: 10,
    },
  },
};
