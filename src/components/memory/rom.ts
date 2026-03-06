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

const COMP_WIDTH = 5;
const COMP_HEIGHT = 6;

// ---------------------------------------------------------------------------
// Shared rendering helper
// ---------------------------------------------------------------------------

function drawROMBody(ctx: RenderContext, label: string, symbol: string): void {
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

const AUTO_RELOAD_DEF: PropertyDefinition = {
  key: "autoReload",
  type: PropertyType.BOOLEAN,
  label: "Auto-reload",
  defaultValue: false,
  description: "Reload ROM contents from hex file on simulation reset",
};

const SHARED_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "dataBits", convert: (v) => parseInt(v, 10) },
  { xmlName: "AddrBits", propertyKey: "addrBits", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "isProgramMemory", propertyKey: "isProgramMemory", convert: (v) => v === "true" },
  { xmlName: "AutoReloadRom", propertyKey: "autoReload", convert: (v) => v === "true" },
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
  const inputPositions = layoutPinsOnFace("west", 2, COMP_WIDTH, COMP_HEIGHT);
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
      label: "sel",
      defaultBitWidth: 1,
      position: inputPositions[1],
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

export class ROMElement extends AbstractCircuitElement {
  private readonly _addrBits: number;
  private readonly _dataBits: number;
  private readonly _isProgramMemory: boolean;
  private readonly _autoReload: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("ROM", instanceId, position, rotation, mirror, props);
    this._addrBits = props.getOrDefault<number>("addrBits", 4);
    this._dataBits = props.getOrDefault<number>("dataBits", 8);
    this._isProgramMemory = props.getOrDefault<boolean>("isProgramMemory", false);
    this._autoReload = props.getOrDefault<boolean>("autoReload", false);
    this._pins = resolvePins(
      buildROMPins(this._addrBits, this._dataBits),
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
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
    drawROMBody(ctx, this._properties.getOrDefault<string>("label", ""), "ROM");
    ctx.restore();
  }

  get isProgramMemory(): boolean {
    return this._isProgramMemory;
  }

  get autoReload(): boolean {
    return this._autoReload;
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

export function executeROM(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const A = state[inBase] >>> 0;
  const sel = state[inBase + 1] & 1;

  if (sel) {
    const mem = getBackingStore(index);
    state[outBase] = mem !== undefined ? mem.read(A) : 0;
  } else {
    state[outBase] = 0;
  }
}

export const ROM_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [...SHARED_ATTRIBUTE_MAPPINGS];

const ROM_PROPERTY_DEFS: PropertyDefinition[] = [
  ADDR_BITS_DEF,
  DATA_BITS_DEF,
  LABEL_DEF,
  IS_PROGRAM_MEMORY_DEF,
  AUTO_RELOAD_DEF,
];

function romFactory(props: PropertyBag): ROMElement {
  return new ROMElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ROMDefinition: ComponentDefinition = {
  name: "ROM",
  typeId: -1,
  factory: romFactory,
  executeFn: executeROM,
  pinLayout: buildROMPins(4, 8),
  propertyDefs: ROM_PROPERTY_DEFS,
  attributeMap: ROM_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "ROM — read-only memory. If sel=1, output D = memory[A].",
  defaultDelay: 10,
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
  const inputPositions = layoutPinsOnFace("west", 4, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 2, COMP_WIDTH, COMP_HEIGHT);
  return [
    {
      direction: PinDirection.INPUT,
      label: "A1",
      defaultBitWidth: addrBits,
      position: inputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "s1",
      defaultBitWidth: 1,
      position: inputPositions[1],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "A2",
      defaultBitWidth: addrBits,
      position: inputPositions[2],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "s2",
      defaultBitWidth: 1,
      position: inputPositions[3],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "D1",
      defaultBitWidth: dataBits,
      position: outputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "D2",
      defaultBitWidth: dataBits,
      position: outputPositions[1],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

export class ROMDualPortElement extends AbstractCircuitElement {
  private readonly _addrBits: number;
  private readonly _dataBits: number;
  private readonly _isProgramMemory: boolean;
  private readonly _autoReload: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("ROMDualPort", instanceId, position, rotation, mirror, props);
    this._addrBits = props.getOrDefault<number>("addrBits", 4);
    this._dataBits = props.getOrDefault<number>("dataBits", 8);
    this._isProgramMemory = props.getOrDefault<boolean>("isProgramMemory", false);
    this._autoReload = props.getOrDefault<boolean>("autoReload", false);
    this._pins = resolvePins(
      buildROMDualPortPins(this._addrBits, this._dataBits),
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
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
    drawROMBody(ctx, this._properties.getOrDefault<string>("label", ""), "ROM2");
    ctx.restore();
  }

  get isProgramMemory(): boolean {
    return this._isProgramMemory;
  }

  get autoReload(): boolean {
    return this._autoReload;
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

export function executeROMDualPort(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const A1 = state[inBase] >>> 0;
  const s1 = state[inBase + 1] & 1;
  const A2 = state[inBase + 2] >>> 0;
  const s2 = state[inBase + 3] & 1;

  const mem = getBackingStore(index);
  state[outBase] = s1 ? (mem !== undefined ? mem.read(A1) : 0) : 0;
  state[outBase + 1] = s2 ? (mem !== undefined ? mem.read(A2) : 0) : 0;
}

export const ROM_DUAL_PORT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [...SHARED_ATTRIBUTE_MAPPINGS];

const ROM_DUAL_PORT_PROPERTY_DEFS: PropertyDefinition[] = [
  ADDR_BITS_DEF,
  DATA_BITS_DEF,
  LABEL_DEF,
  IS_PROGRAM_MEMORY_DEF,
  AUTO_RELOAD_DEF,
];

function romDualPortFactory(props: PropertyBag): ROMDualPortElement {
  return new ROMDualPortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ROMDualPortDefinition: ComponentDefinition = {
  name: "ROMDualPort",
  typeId: -1,
  factory: romDualPortFactory,
  executeFn: executeROMDualPort,
  pinLayout: buildROMDualPortPins(4, 8),
  propertyDefs: ROM_DUAL_PORT_PROPERTY_DEFS,
  attributeMap: ROM_DUAL_PORT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "ROMDualPort — dual-port read-only memory with two independent read ports.",
  defaultDelay: 10,
};
