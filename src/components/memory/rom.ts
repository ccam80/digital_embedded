/**
 * ROM components — ROM and ROMDualPort.
 *
 * ROM: single-port read-only memory with chip-select.
 *   Inputs: A (addrBits), sel (1)
 *   Output: D (dataBits)
 *   Behaviour: if sel=1, D = memory[A]; else D = 0.
 *   Combinational (no clock). internalStateCount: 0.
 *
 * ROMDualPort: two independent read ports over the same backing store.
 *   Inputs: A1 (addrBits), s1 (1), A2 (addrBits), s2 (1)
 *   Outputs: D1 (dataBits), D2 (dataBits)
 *   Behaviour: D1 = sel1 ? memory[A1] : 0; D2 = sel2 ? memory[A2] : 0.
 *   Combinational. internalStateCount: 0.
 *
 * Both declare backingStoreType: 'datafield'. The engine populates the
 * module-level backing store registry before calling executeFn.
 *
 * isProgramMemory flag marks this ROM as a CPU instruction store so that
 * Phase 6 integration can load program binaries into it.
 *
 * autoReload flag causes the ROM to reload its contents from the
 * last-loaded data file whenever the simulation is reset.
 *
 * Ported from:
 *   ref/Digital/src/main/java/de/neemann/digital/core/memory/ROM.java
 *   ref/Digital/src/main/java/de/neemann/digital/core/memory/ROMDualPort.java
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
import {
  DataField,
  getBackingStore,
} from "./ram.js";

// Re-export DataField so tests can import from this module without also
// importing from ram.ts.
export { DataField, getBackingStore };
export { registerBackingStore, clearBackingStores } from "./ram.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
const COMP_HEIGHT = 3;         // ROM: Java rect height = 3 (y=-0.5 to 2.5)
const COMP_HEIGHT_DUAL = 4;    // ROMDualPort: max(4 inputs, 2 outputs) = 4

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

const AUTO_RELOAD_DEF: PropertyDefinition = {
  key: "autoReload",
  type: PropertyType.BOOLEAN,
  label: "Auto-reload",
  defaultValue: false,
  description: "Reload ROM contents from hex file on simulation reset",
};

const DATA_DEF: PropertyDefinition = {
  key: "data",
  type: PropertyType.HEX_DATA,
  label: "Data",
  defaultValue: [],
  description: "Memory contents as hex values (one word per entry)",
};

const SHARED_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "dataBits", convert: (v) => parseInt(v, 10) },
  { xmlName: "AddrBits", propertyKey: "addrBits", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "isProgramMemory", propertyKey: "isProgramMemory", convert: (v) => v === "true" },
  { xmlName: "AutoReloadRom", propertyKey: "autoReload", convert: (v) => v === "true" },
  { xmlName: "Data", propertyKey: "data", convert: (v) => {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(Number);
    } catch { /* ignore */ }
    if (v.trim() === '') return [];
    return v.trim().split(/[\s,]+/).map((s: string) => parseInt(s, 16));
  }},
];

// ---------------------------------------------------------------------------
// ROM
// ---------------------------------------------------------------------------
// Inputs:  A (addrBits), sel (1)
// Outputs: D (dataBits)
//
// Combinational: if sel=1, D = backing_store[A]; else D = 0.
// internalStateCount: 0
// ---------------------------------------------------------------------------

function buildROMPins(addrBits: number, dataBits: number): PinDeclaration[] {
  // GenericShape: 2 inputs, 1 output → symmetric=true, even=true
  // offs = 2/2 = 1; A at y=0, sel at y=2 (even gap), D at y=offs=1
  return [
    { direction: PinDirection.INPUT, label: "A", defaultBitWidth: addrBits, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "sel", defaultBitWidth: 1, position: { x: 0, y: 2 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "D", defaultBitWidth: dataBits, position: { x: COMP_WIDTH, y: 1 }, isNegatable: false, isClockCapable: false },
  ];
}

export class ROMElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("ROM", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const addrBits = this._properties.getOrDefault<number>("addrBits", 4);
    const dataBits = this._properties.getOrDefault<number>("dataBits", 8);
    return resolvePins(
      buildROMPins(addrBits, dataBits),
      { x: 0, y: 0 },
      0,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getBoundingBox(): Rect {
    return { x: this.position.x + 0.05, y: this.position.y - 0.5, width: (COMP_WIDTH - 0.05) - 0.05, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["A", "sel"],
      outputLabels: ["D"],
      clockInputIndices: [],
      componentName: "ROM",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
  }

  get isProgramMemory(): boolean {
    return this._properties.getOrDefault<boolean>("isProgramMemory", false);
  }

  get autoReload(): boolean {
    return this._properties.getOrDefault<boolean>("autoReload", false);
  }

  getHelpText(): string {
    return (
      "ROM — read-only memory with chip select.\n" +
      "If sel=1, output D = memory[A]; otherwise D is 0.\n" +
      "Contents are set at design time via the DATA attribute.\n" +
      "Set isProgramMemory=true for CPU instruction fetch integration.\n" +
      "Set autoReload=true to reload contents from hex file on reset."
    );
  }
}

export function executeROM(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const A = state[wt[inBase]] >>> 0;
  const sel = state[wt[inBase + 1]] & 1;

  if (sel) {
    const mem = getBackingStore(index);
    state[wt[outBase]] = mem !== undefined ? mem.read(A) : 0;
  } else {
    state[wt[outBase]] = 0;
  }
}

export const ROM_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [...SHARED_ATTRIBUTE_MAPPINGS];

const ROM_PROPERTY_DEFS: PropertyDefinition[] = [
  ADDR_BITS_DEF,
  DATA_BITS_DEF,
  LABEL_PROPERTY_DEF,
  IS_PROGRAM_MEMORY_DEF,
  AUTO_RELOAD_DEF,
  DATA_DEF,
];

function romFactory(props: PropertyBag): ROMElement {
  return new ROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ROMDefinition: ComponentDefinition = {
  name: "ROM",
  typeId: -1,
  factory: romFactory,
  pinLayout: buildROMPins(4, 8),
  propertyDefs: ROM_PROPERTY_DEFS,
  attributeMap: ROM_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "ROM — read-only memory. If sel=1, output D = memory[A].",
  models: {
    digital: {
      executeFn: executeROM,
      inputSchema: ["A", "sel"],
      outputSchema: ["D"],
      stateSlotCount: 0,
      defaultDelay: 10,
    },
  },
};

// ---------------------------------------------------------------------------
// ROMDualPort
// ---------------------------------------------------------------------------
// Inputs:  A1 (addrBits), s1 (1), A2 (addrBits), s2 (1)
// Outputs: D1 (dataBits), D2 (dataBits)
//
// Two independent read ports over the same backing store.
// D1 = s1 ? memory[A1] : 0; D2 = s2 ? memory[A2] : 0.
// Combinational. internalStateCount: 0.
// ---------------------------------------------------------------------------

function buildROMDualPortPins(addrBits: number, dataBits: number): PinDeclaration[] {
  // GenericShape: 4 inputs, 2 outputs → symmetric=false (outputs!=1)
  // No gap, no offset: inputs y=0,1,2,3; outputs y=0,1
  return [
    { direction: PinDirection.INPUT, label: "A1", defaultBitWidth: addrBits, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "s1", defaultBitWidth: 1, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "A2", defaultBitWidth: addrBits, position: { x: 0, y: 2 }, isNegatable: false, isClockCapable: false },
    {
      direction: PinDirection.INPUT,
      label: "s2",
      defaultBitWidth: 1,
      position: { x: 0, y: 3 },
      isNegatable: false,
      isClockCapable: false,
    },
    { direction: PinDirection.OUTPUT, label: "D1", defaultBitWidth: dataBits, position: { x: COMP_WIDTH, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "D2", defaultBitWidth: dataBits, position: { x: COMP_WIDTH, y: 1 }, isNegatable: false, isClockCapable: false },
  ];
}

export class ROMDualPortElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("ROMDualPort", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const addrBits = this._properties.getOrDefault<number>("addrBits", 4);
    const dataBits = this._properties.getOrDefault<number>("dataBits", 8);
    return resolvePins(
      buildROMDualPortPins(addrBits, dataBits),
      { x: 0, y: 0 },
      0,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getBoundingBox(): Rect {
    return { x: this.position.x + 0.05, y: this.position.y - 0.5, width: (COMP_WIDTH - 0.05) - 0.05, height: COMP_HEIGHT_DUAL };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["A1", "s1", "A2", "s2"],
      outputLabels: ["D1", "D2"],
      clockInputIndices: [],
      componentName: "ROM",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
  }

  get isProgramMemory(): boolean {
    return this._properties.getOrDefault<boolean>("isProgramMemory", false);
  }

  get autoReload(): boolean {
    return this._properties.getOrDefault<boolean>("autoReload", false);
  }

  getHelpText(): string {
    return (
      "ROMDualPort — dual-port read-only memory.\n" +
      "Port 1: D1 = s1 ? memory[A1] : 0.\n" +
      "Port 2: D2 = s2 ? memory[A2] : 0.\n" +
      "Both ports share the same backing store and are fully combinational."
    );
  }
}

export function executeROMDualPort(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const A1 = state[wt[inBase]] >>> 0;
  const s1 = state[wt[inBase + 1]] & 1;
  const A2 = state[wt[inBase + 2]] >>> 0;
  const s2 = state[wt[inBase + 3]] & 1;

  const mem = getBackingStore(index);
  state[wt[outBase]] = s1 ? (mem !== undefined ? mem.read(A1) : 0) : 0;
  state[wt[outBase + 1]] = s2 ? (mem !== undefined ? mem.read(A2) : 0) : 0;
}

export const ROM_DUAL_PORT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [...SHARED_ATTRIBUTE_MAPPINGS];

const ROM_DUAL_PORT_PROPERTY_DEFS: PropertyDefinition[] = [
  ADDR_BITS_DEF,
  DATA_BITS_DEF,
  LABEL_PROPERTY_DEF,
  IS_PROGRAM_MEMORY_DEF,
  AUTO_RELOAD_DEF,
  DATA_DEF,
];

function romDualPortFactory(props: PropertyBag): ROMDualPortElement {
  return new ROMDualPortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ROMDualPortDefinition: ComponentDefinition = {
  name: "ROMDualPort",
  typeId: -1,
  factory: romDualPortFactory,
  pinLayout: buildROMDualPortPins(4, 8),
  propertyDefs: ROM_DUAL_PORT_PROPERTY_DEFS,
  attributeMap: ROM_DUAL_PORT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "ROMDualPort — dual-port read-only memory with two independent read ports.",
  models: {
    digital: {
      executeFn: executeROMDualPort,
      inputSchema: ["A1", "s1", "A2", "s2"],
      outputSchema: ["D1", "D2"],
      stateSlotCount: 0,
      defaultDelay: 10,
    },
  },
};
