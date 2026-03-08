/**
 * RAM components — all variants in one file sharing common logic.
 *
 * Variants implemented:
 *   - RAMSinglePort    : single address bus, read/write on same port (clock-synchronous write)
 *   - RAMSinglePortSel : RAMSinglePort with chip-select (CS/WE/OE, combinational)
 *   - RAMDualPort      : separate read and write address buses (clock-synchronous write)
 *   - RAMDualAccess    : two independent ports (port 1 clock-sync, port 2 async read)
 *   - RAMAsync         : fully asynchronous (combinational read and write-enable)
 *   - BlockRAMDualPort : block RAM with synchronous read-before-write
 *
 * Backing store: a module-level DataField map keyed by component slot index.
 * The Phase 3 engine populates this map (via registerBackingStore) before
 * calling executeFn. Components declare backingStoreType: 'datafield' so the
 * compiler knows to allocate and register a DataField for each instance.
 *
 * All stateful variants use a RAMLayout that extends ComponentLayout with
 * stateOffset(). The executeFn casts layout to RAMLayout when accessing state.
 *
 * Signal layout per Java source:
 *
 * RAMSinglePort  inputs: A, str, C, ld      outputs: D (bidirectional)
 * RAMSinglePortSel inputs: A, CS, WE, OE    outputs: D (bidirectional)
 * RAMDualPort    inputs: A, Din, str, C, ld outputs: D
 * RAMDualAccess  inputs: str, C, ld, 1A, 1Din, 2A  outputs: 1D, 2D
 * RAMAsync       inputs: A, D, we           outputs: Q
 * BlockRAMDualPort inputs: A, Din, str, C   outputs: D
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

// ---------------------------------------------------------------------------
// RAMLayout — extends ComponentLayout with stateOffset for stateful RAM variants
// ---------------------------------------------------------------------------

export interface RAMLayout extends ComponentLayout {
  stateOffset(componentIndex: number): number;
}

// ---------------------------------------------------------------------------
// DataField — simple word-addressed memory array
// ---------------------------------------------------------------------------

/**
 * Word-addressed memory backing store for RAM components.
 * Each word is a 32-bit unsigned integer. Address wraps modulo size.
 * Size must be a power of two for address masking to work correctly.
 */
export class DataField {
  private readonly _data: Uint32Array;
  readonly size: number;

  constructor(size: number) {
    this.size = size;
    this._data = new Uint32Array(size);
  }

  read(addr: number): number {
    const safeAddr = (addr >>> 0) % this.size;
    return this._data[safeAddr] >>> 0;
  }

  write(addr: number, value: number): void {
    const safeAddr = (addr >>> 0) % this.size;
    this._data[safeAddr] = value >>> 0;
  }

  /**
   * Initialize from an array of values. Values beyond the field size are ignored.
   */
  initFrom(values: readonly number[]): void {
    const len = Math.min(values.length, this.size);
    for (let i = 0; i < len; i++) {
      this._data[i] = values[i] >>> 0;
    }
  }

  /**
   * Copy all data from another DataField into this one.
   */
  copyFrom(other: DataField): void {
    const len = Math.min(this.size, other.size);
    for (let i = 0; i < len; i++) {
      this._data[i] = other._data[i];
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level backing store registry
// Phase 3 engine populates this before calling executeFn for memory components.
// ---------------------------------------------------------------------------

const _backingStores: Map<number, DataField> = new Map();

/**
 * Register a DataField for a component instance.
 * Called by the Phase 3 engine during circuit compilation.
 */
export function registerBackingStore(componentIndex: number, field: DataField): void {
  _backingStores.set(componentIndex, field);
}

/**
 * Retrieve the DataField for a component instance.
 */
export function getBackingStore(componentIndex: number): DataField | undefined {
  return _backingStores.get(componentIndex);
}

/**
 * Remove all registered backing stores. Used for testing and engine reset.
 */
export function clearBackingStores(): void {
  _backingStores.clear();
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 5;
const COMP_HEIGHT = 8;

// ---------------------------------------------------------------------------
// Shared rendering helper
// ---------------------------------------------------------------------------

function drawMemoryBody(ctx: RenderContext, label: string, symbol: string): void {
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
// Shared property definitions and attribute mappings
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
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(Number);
    } catch { /* ignore */ }
    if (v.trim() === '') return [];
    return v.trim().split(/[\s,]+/).map((s: string) => parseInt(s, 16));
  }},
];

// ---------------------------------------------------------------------------
// RAMSinglePort
// ---------------------------------------------------------------------------
// Inputs:  A (addrBits), str (1), C (1 clock), ld (1)
// Outputs: D (dataBits, bidirectional)
//
// On rising clock edge: if str=1, writes the current D output value back to
// memory[A] (the D pin is bidirectional — data to write comes from the net
// driving the bidirectional D pin; we model this as state[wt[outBase]] at write time).
// If ld=1, output D = memory[A]; else D = 0.
//
// State slots (via stateOffset):
//   +0: lastClk (previous clock value for edge detection)
// ---------------------------------------------------------------------------

function buildRAMSinglePortPins(addrBits: number, dataBits: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 4, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    { direction: PinDirection.INPUT, label: "A", defaultBitWidth: addrBits, position: inputPositions[0], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "str", defaultBitWidth: 1, position: inputPositions[1], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "C", defaultBitWidth: 1, position: inputPositions[2], isNegatable: false, isClockCapable: true },
    { direction: PinDirection.INPUT, label: "ld", defaultBitWidth: 1, position: inputPositions[3], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "D", defaultBitWidth: dataBits, position: outputPositions[0], isNegatable: false, isClockCapable: false },
  ];
}

export class RAMSinglePortElement extends AbstractCircuitElement {
  private readonly _addrBits: number;
  private readonly _dataBits: number;
  private readonly _pins: readonly Pin[];

  constructor(instanceId: string, position: { x: number; y: number }, rotation: Rotation, mirror: boolean, props: PropertyBag) {
    super("RAMSinglePort", instanceId, position, rotation, mirror, props);
    this._addrBits = props.getOrDefault<number>("addrBits", 4);
    this._dataBits = props.getOrDefault<number>("dataBits", 8);
    this._pins = resolvePins(
      buildRAMSinglePortPins(this._addrBits, this._dataBits),
      position, rotation,
      createInverterConfig([]),
      { clockPins: new Set(["C"]) },
    );
  }

  getPins(): readonly Pin[] { return this._pins; }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    drawMemoryBody(ctx, this._properties.getOrDefault<string>("label", ""), "RAM");
    ctx.restore();
  }

  getHelpText(): string {
    return (
      "RAMSinglePort — synchronous RAM with a single read/write port.\n" +
      "On rising clock edge: if str=1, writes data to memory[A].\n" +
      "If ld=1, outputs memory[A] on D; otherwise D is 0."
    );
  }
}

export function sampleRAMSinglePort(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = (layout as RAMLayout).stateOffset(index);

  const A = state[wt[inBase]] >>> 0;
  const str = state[wt[inBase + 1]] & 1;
  const clk = state[wt[inBase + 2]] & 1;
  const lastClk = state[stBase] & 1;

  if (!lastClk && clk) {
    if (str) {
      const mem = _backingStores.get(index);
      if (mem !== undefined) {
        mem.write(A, state[wt[inBase + 1 + 3]]);
      }
    }
  }

  state[stBase] = clk;
}

export function executeRAMSinglePort(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const A = state[wt[inBase]] >>> 0;
  const ld = state[wt[inBase + 3]] & 1;

  if (ld) {
    const mem = _backingStores.get(index);
    state[wt[outBase]] = mem !== undefined ? mem.read(A) : 0;
  } else {
    state[wt[outBase]] = 0;
  }
}

export const RAM_SINGLE_PORT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [...SHARED_ATTRIBUTE_MAPPINGS];

const RAM_SINGLE_PORT_PROPERTY_DEFS: PropertyDefinition[] = [
  ADDR_BITS_DEF, DATA_BITS_DEF, LABEL_DEF, IS_PROGRAM_MEMORY_DEF, DATA_DEF,
];

function ramSinglePortFactory(props: PropertyBag): RAMSinglePortElement {
  return new RAMSinglePortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RAMSinglePortDefinition: ComponentDefinition = {
  name: "RAMSinglePort",
  typeId: -1,
  factory: ramSinglePortFactory,
  executeFn: executeRAMSinglePort,
  sampleFn: sampleRAMSinglePort,
  pinLayout: buildRAMSinglePortPins(4, 8),
  propertyDefs: RAM_SINGLE_PORT_PROPERTY_DEFS,
  attributeMap: RAM_SINGLE_PORT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "RAMSinglePort — synchronous RAM with a single read/write port.",
  stateSlotCount: (props) => 1 + (1 << (props.getOrDefault<number>("addrBits", 4))),
  defaultDelay: 10,
};

// ---------------------------------------------------------------------------
// RAMSinglePortSel
// ---------------------------------------------------------------------------
// Inputs:  A (addrBits), CS (1), WE (1), OE (1)
// Outputs: D (dataBits, bidirectional)
//
// CS=1 selects chip. WE=1 writes D (from the bidirectional net) to memory[A].
// OE=1 && CS=1 && !WE → D = memory[A]; else D = 0.
// Fully combinational — no clock.
//
// internalStateCount: 0
// ---------------------------------------------------------------------------

function buildRAMSinglePortSelPins(addrBits: number, dataBits: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 4, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    { direction: PinDirection.INPUT, label: "A", defaultBitWidth: addrBits, position: inputPositions[0], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "CS", defaultBitWidth: 1, position: inputPositions[1], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "WE", defaultBitWidth: 1, position: inputPositions[2], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "OE", defaultBitWidth: 1, position: inputPositions[3], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "D", defaultBitWidth: dataBits, position: outputPositions[0], isNegatable: false, isClockCapable: false },
  ];
}

export class RAMSinglePortSelElement extends AbstractCircuitElement {
  private readonly _addrBits: number;
  private readonly _dataBits: number;
  private readonly _pins: readonly Pin[];

  constructor(instanceId: string, position: { x: number; y: number }, rotation: Rotation, mirror: boolean, props: PropertyBag) {
    super("RAMSinglePortSel", instanceId, position, rotation, mirror, props);
    this._addrBits = props.getOrDefault<number>("addrBits", 4);
    this._dataBits = props.getOrDefault<number>("dataBits", 8);
    this._pins = resolvePins(
      buildRAMSinglePortSelPins(this._addrBits, this._dataBits),
      position, rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getPins(): readonly Pin[] { return this._pins; }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    drawMemoryBody(ctx, this._properties.getOrDefault<string>("label", ""), "RAM");
    ctx.restore();
  }

  getHelpText(): string {
    return (
      "RAMSinglePortSel — combinational RAM with chip select.\n" +
      "CS=1 selects chip. WE=1 writes data to memory[A].\n" +
      "OE=1 and CS=1 and WE=0 outputs memory[A] on D."
    );
  }
}

export function executeRAMSinglePortSel(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const A = state[wt[inBase]] >>> 0;
  const cs = state[wt[inBase + 1]] & 1;
  const we = state[wt[inBase + 2]] & 1;
  const oe = state[wt[inBase + 3]] & 1;

  if (cs) {
    if (we) {
      const mem = _backingStores.get(index);
      if (mem !== undefined) {
        mem.write(A, state[wt[outBase]]);
      }
    }
    if (oe && !we) {
      const mem = _backingStores.get(index);
      state[wt[outBase]] = mem !== undefined ? mem.read(A) : 0;
    } else {
      state[wt[outBase]] = 0;
    }
  } else {
    state[wt[outBase]] = 0;
  }
}

export const RAM_SINGLE_PORT_SEL_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [...SHARED_ATTRIBUTE_MAPPINGS];

const RAM_SINGLE_PORT_SEL_PROPERTY_DEFS: PropertyDefinition[] = [
  ADDR_BITS_DEF, DATA_BITS_DEF, LABEL_DEF, IS_PROGRAM_MEMORY_DEF, DATA_DEF,
];

function ramSinglePortSelFactory(props: PropertyBag): RAMSinglePortSelElement {
  return new RAMSinglePortSelElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RAMSinglePortSelDefinition: ComponentDefinition = {
  name: "RAMSinglePortSel",
  typeId: -1,
  factory: ramSinglePortSelFactory,
  executeFn: executeRAMSinglePortSel,
  pinLayout: buildRAMSinglePortSelPins(4, 8),
  propertyDefs: RAM_SINGLE_PORT_SEL_PROPERTY_DEFS,
  attributeMap: RAM_SINGLE_PORT_SEL_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "RAMSinglePortSel — combinational RAM with chip select (CS/WE/OE).",
  stateSlotCount: 0,
  defaultDelay: 10,
};

// ---------------------------------------------------------------------------
// RAMDualPort
// ---------------------------------------------------------------------------
// Inputs:  A (addrBits), Din (dataBits), str (1), C (1 clock), ld (1)
// Outputs: D (dataBits)
//
// On rising clock edge: if str=1, write Din to memory[A].
// If ld=1, output D = memory[A]; else D = 0.
//
// State slots (via stateOffset):
//   +0: lastClk
// ---------------------------------------------------------------------------

function buildRAMDualPortPins(addrBits: number, dataBits: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 5, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    { direction: PinDirection.INPUT, label: "A", defaultBitWidth: addrBits, position: inputPositions[0], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "Din", defaultBitWidth: dataBits, position: inputPositions[1], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "str", defaultBitWidth: 1, position: inputPositions[2], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "C", defaultBitWidth: 1, position: inputPositions[3], isNegatable: false, isClockCapable: true },
    { direction: PinDirection.INPUT, label: "ld", defaultBitWidth: 1, position: inputPositions[4], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "D", defaultBitWidth: dataBits, position: outputPositions[0], isNegatable: false, isClockCapable: false },
  ];
}

export class RAMDualPortElement extends AbstractCircuitElement {
  private readonly _addrBits: number;
  private readonly _dataBits: number;
  private readonly _pins: readonly Pin[];

  constructor(instanceId: string, position: { x: number; y: number }, rotation: Rotation, mirror: boolean, props: PropertyBag) {
    super("RAMDualPort", instanceId, position, rotation, mirror, props);
    this._addrBits = props.getOrDefault<number>("addrBits", 4);
    this._dataBits = props.getOrDefault<number>("dataBits", 8);
    this._pins = resolvePins(
      buildRAMDualPortPins(this._addrBits, this._dataBits),
      position, rotation,
      createInverterConfig([]),
      { clockPins: new Set(["C"]) },
    );
  }

  getPins(): readonly Pin[] { return this._pins; }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    drawMemoryBody(ctx, this._properties.getOrDefault<string>("label", ""), "RAM");
    ctx.restore();
  }

  getHelpText(): string {
    return (
      "RAMDualPort — synchronous RAM with separate read/write ports.\n" +
      "On rising clock edge: if str=1, writes Din to memory[A].\n" +
      "If ld=1, outputs memory[A] on D; otherwise D is 0."
    );
  }
}

export function sampleRAMDualPort(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = (layout as RAMLayout).stateOffset(index);

  const A = state[wt[inBase]] >>> 0;
  const din = state[wt[inBase + 1]] >>> 0;
  const str = state[wt[inBase + 2]] & 1;
  const clk = state[wt[inBase + 3]] & 1;
  const lastClk = state[stBase] & 1;

  if (!lastClk && clk) {
    if (str) {
      const mem = _backingStores.get(index);
      if (mem !== undefined) {
        mem.write(A, din);
      }
    }
  }

  state[stBase] = clk;
}

export function executeRAMDualPort(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const A = state[wt[inBase]] >>> 0;
  const ld = state[wt[inBase + 4]] & 1;

  if (ld) {
    const mem = _backingStores.get(index);
    state[wt[outBase]] = mem !== undefined ? mem.read(A) : 0;
  } else {
    state[wt[outBase]] = 0;
  }
}

export const RAM_DUAL_PORT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [...SHARED_ATTRIBUTE_MAPPINGS];

const RAM_DUAL_PORT_PROPERTY_DEFS: PropertyDefinition[] = [
  ADDR_BITS_DEF, DATA_BITS_DEF, LABEL_DEF, IS_PROGRAM_MEMORY_DEF, DATA_DEF,
];

function ramDualPortFactory(props: PropertyBag): RAMDualPortElement {
  return new RAMDualPortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RAMDualPortDefinition: ComponentDefinition = {
  name: "RAMDualPort",
  typeId: -1,
  factory: ramDualPortFactory,
  executeFn: executeRAMDualPort,
  sampleFn: sampleRAMDualPort,
  pinLayout: buildRAMDualPortPins(4, 8),
  propertyDefs: RAM_DUAL_PORT_PROPERTY_DEFS,
  attributeMap: RAM_DUAL_PORT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "RAMDualPort — synchronous RAM with separate read/write address buses.",
  stateSlotCount: (props) => 1 + (1 << (props.getOrDefault<number>("addrBits", 4))),
  defaultDelay: 10,
};

// ---------------------------------------------------------------------------
// RAMDualAccess
// ---------------------------------------------------------------------------
// Inputs:  str (1), C (1 clock), ld (1), 1A (addrBits), 1Din (dataBits), 2A (addrBits)
// Outputs: 1D (dataBits), 2D (dataBits)
//
// Port 1 (synchronous): on rising clock edge, if str=1 write 1Din to mem[1A].
//   If ld=1, 1D = mem[1A]; else 1D = 0.
// Port 2 (async read): 2D = mem[2A] always, combinationally.
//
// State slots (via stateOffset):
//   +0: lastClk
// ---------------------------------------------------------------------------

function buildRAMDualAccessPins(addrBits: number, dataBits: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 6, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 2, COMP_WIDTH, COMP_HEIGHT);
  return [
    { direction: PinDirection.INPUT, label: "str", defaultBitWidth: 1, position: inputPositions[0], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "C", defaultBitWidth: 1, position: inputPositions[1], isNegatable: false, isClockCapable: true },
    { direction: PinDirection.INPUT, label: "ld", defaultBitWidth: 1, position: inputPositions[2], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "1A", defaultBitWidth: addrBits, position: inputPositions[3], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "1Din", defaultBitWidth: dataBits, position: inputPositions[4], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "2A", defaultBitWidth: addrBits, position: inputPositions[5], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "1D", defaultBitWidth: dataBits, position: outputPositions[0], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "2D", defaultBitWidth: dataBits, position: outputPositions[1], isNegatable: false, isClockCapable: false },
  ];
}

export class RAMDualAccessElement extends AbstractCircuitElement {
  private readonly _addrBits: number;
  private readonly _dataBits: number;
  private readonly _pins: readonly Pin[];

  constructor(instanceId: string, position: { x: number; y: number }, rotation: Rotation, mirror: boolean, props: PropertyBag) {
    super("RAMDualAccess", instanceId, position, rotation, mirror, props);
    this._addrBits = props.getOrDefault<number>("addrBits", 4);
    this._dataBits = props.getOrDefault<number>("dataBits", 8);
    this._pins = resolvePins(
      buildRAMDualAccessPins(this._addrBits, this._dataBits),
      position, rotation,
      createInverterConfig([]),
      { clockPins: new Set(["C"]) },
    );
  }

  getPins(): readonly Pin[] { return this._pins; }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    drawMemoryBody(ctx, this._properties.getOrDefault<string>("label", ""), "RAM");
    ctx.restore();
  }

  getHelpText(): string {
    return (
      "RAMDualAccess — RAM with two independent access ports.\n" +
      "Port 1 (synchronous): write 1Din to mem[1A] on clock edge if str=1; read with ld=1.\n" +
      "Port 2 (async read): 2D = mem[2A] combinationally."
    );
  }
}

export function sampleRAMDualAccess(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = (layout as RAMLayout).stateOffset(index);

  const str = state[wt[inBase]] & 1;
  const clk = state[wt[inBase + 1]] & 1;
  const addr1 = state[wt[inBase + 3]] >>> 0;
  const din1 = state[wt[inBase + 4]] >>> 0;
  const lastClk = state[stBase] & 1;

  if (!lastClk && clk) {
    if (str) {
      const mem = _backingStores.get(index);
      if (mem !== undefined) {
        mem.write(addr1, din1);
      }
    }
  }

  state[stBase] = clk;
}

export function executeRAMDualAccess(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const ld = state[wt[inBase + 2]] & 1;
  const addr1 = state[wt[inBase + 3]] >>> 0;
  const addr2 = state[wt[inBase + 5]] >>> 0;

  const mem = _backingStores.get(index);
  state[wt[outBase]] = ld ? (mem !== undefined ? mem.read(addr1) : 0) : 0;
  state[wt[outBase + 1]] = mem !== undefined ? mem.read(addr2) : 0;
}

export const RAM_DUAL_ACCESS_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [...SHARED_ATTRIBUTE_MAPPINGS];

const RAM_DUAL_ACCESS_PROPERTY_DEFS: PropertyDefinition[] = [
  ADDR_BITS_DEF, DATA_BITS_DEF, LABEL_DEF, IS_PROGRAM_MEMORY_DEF, DATA_DEF,
];

function ramDualAccessFactory(props: PropertyBag): RAMDualAccessElement {
  return new RAMDualAccessElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RAMDualAccessDefinition: ComponentDefinition = {
  name: "RAMDualAccess",
  typeId: -1,
  factory: ramDualAccessFactory,
  executeFn: executeRAMDualAccess,
  sampleFn: sampleRAMDualAccess,
  pinLayout: buildRAMDualAccessPins(4, 8),
  propertyDefs: RAM_DUAL_ACCESS_PROPERTY_DEFS,
  attributeMap: RAM_DUAL_ACCESS_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "RAMDualAccess — RAM with two independent access ports (one sync, one async read).",
  stateSlotCount: (props) => 1 + (1 << (props.getOrDefault<number>("addrBits", 4))),
  defaultDelay: 10,
};

// ---------------------------------------------------------------------------
// RAMAsync
// ---------------------------------------------------------------------------
// Inputs:  A (addrBits), D (dataBits), we (1)
// Outputs: Q (dataBits)
//
// Fully asynchronous: if we=1, write D to mem[A]; output Q = mem[A] always.
//
// internalStateCount: 0
// ---------------------------------------------------------------------------

function buildRAMAsyncPins(addrBits: number, dataBits: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 3, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    { direction: PinDirection.INPUT, label: "A", defaultBitWidth: addrBits, position: inputPositions[0], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "D", defaultBitWidth: dataBits, position: inputPositions[1], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "we", defaultBitWidth: 1, position: inputPositions[2], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "Q", defaultBitWidth: dataBits, position: outputPositions[0], isNegatable: false, isClockCapable: false },
  ];
}

export class RAMAsyncElement extends AbstractCircuitElement {
  private readonly _addrBits: number;
  private readonly _dataBits: number;
  private readonly _pins: readonly Pin[];

  constructor(instanceId: string, position: { x: number; y: number }, rotation: Rotation, mirror: boolean, props: PropertyBag) {
    super("RAMAsync", instanceId, position, rotation, mirror, props);
    this._addrBits = props.getOrDefault<number>("addrBits", 4);
    this._dataBits = props.getOrDefault<number>("dataBits", 8);
    this._pins = resolvePins(
      buildRAMAsyncPins(this._addrBits, this._dataBits),
      position, rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getPins(): readonly Pin[] { return this._pins; }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    drawMemoryBody(ctx, this._properties.getOrDefault<string>("label", ""), "RAM");
    ctx.restore();
  }

  getHelpText(): string {
    return (
      "RAMAsync — asynchronous (combinational) RAM.\n" +
      "If we=1, writes D to memory[A] immediately.\n" +
      "Output Q always reflects memory[A]."
    );
  }
}

export function executeRAMAsync(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const A = state[wt[inBase]] >>> 0;
  const D = state[wt[inBase + 1]] >>> 0;
  const we = state[wt[inBase + 2]] & 1;

  const mem = _backingStores.get(index);
  if (we && mem !== undefined) {
    mem.write(A, D);
  }
  state[wt[outBase]] = mem !== undefined ? mem.read(A) : 0;
}

export const RAM_ASYNC_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [...SHARED_ATTRIBUTE_MAPPINGS];

const RAM_ASYNC_PROPERTY_DEFS: PropertyDefinition[] = [
  ADDR_BITS_DEF, DATA_BITS_DEF, LABEL_DEF, IS_PROGRAM_MEMORY_DEF, DATA_DEF,
];

function ramAsyncFactory(props: PropertyBag): RAMAsyncElement {
  return new RAMAsyncElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RAMAsyncDefinition: ComponentDefinition = {
  name: "RAMAsync",
  typeId: -1,
  factory: ramAsyncFactory,
  executeFn: executeRAMAsync,
  pinLayout: buildRAMAsyncPins(4, 8),
  propertyDefs: RAM_ASYNC_PROPERTY_DEFS,
  attributeMap: RAM_ASYNC_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "RAMAsync — fully asynchronous RAM. Combinational read, write-enable driven write.",
  stateSlotCount: 0,
  defaultDelay: 10,
};

// ---------------------------------------------------------------------------
// BlockRAMDualPort
// ---------------------------------------------------------------------------
// Inputs:  A (addrBits), Din (dataBits), str (1), C (1 clock)
// Outputs: D (dataBits)
//
// Synchronous read-before-write: on rising clock edge, capture memory[A]
// into the output register, then (if str=1) write Din to memory[A].
// Output D always reflects the captured value from the previous clock edge.
//
// State slots (via stateOffset):
//   +0: lastClk
//   +1: outputVal (registered output from last clock edge)
// ---------------------------------------------------------------------------

function buildBlockRAMDualPortPins(addrBits: number, dataBits: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 4, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    { direction: PinDirection.INPUT, label: "A", defaultBitWidth: addrBits, position: inputPositions[0], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "Din", defaultBitWidth: dataBits, position: inputPositions[1], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "str", defaultBitWidth: 1, position: inputPositions[2], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "C", defaultBitWidth: 1, position: inputPositions[3], isNegatable: false, isClockCapable: true },
    { direction: PinDirection.OUTPUT, label: "D", defaultBitWidth: dataBits, position: outputPositions[0], isNegatable: false, isClockCapable: false },
  ];
}

export class BlockRAMDualPortElement extends AbstractCircuitElement {
  private readonly _addrBits: number;
  private readonly _dataBits: number;
  private readonly _pins: readonly Pin[];

  constructor(instanceId: string, position: { x: number; y: number }, rotation: Rotation, mirror: boolean, props: PropertyBag) {
    super("BlockRAMDualPort", instanceId, position, rotation, mirror, props);
    this._addrBits = props.getOrDefault<number>("addrBits", 4);
    this._dataBits = props.getOrDefault<number>("dataBits", 8);
    this._pins = resolvePins(
      buildBlockRAMDualPortPins(this._addrBits, this._dataBits),
      position, rotation,
      createInverterConfig([]),
      { clockPins: new Set(["C"]) },
    );
  }

  getPins(): readonly Pin[] { return this._pins; }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    drawMemoryBody(ctx, this._properties.getOrDefault<string>("label", ""), "BRAM");
    ctx.restore();
  }

  getHelpText(): string {
    return (
      "BlockRAMDualPort — block RAM with synchronous read (read-before-write).\n" +
      "On rising clock edge: captures memory[A] into output register, then writes Din if str=1.\n" +
      "Output D reflects the value registered on the previous clock edge."
    );
  }
}

export function sampleBlockRAMDualPort(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = (layout as RAMLayout).stateOffset(index);

  const A = state[wt[inBase]] >>> 0;
  const din = state[wt[inBase + 1]] >>> 0;
  const str = state[wt[inBase + 2]] & 1;
  const clk = state[wt[inBase + 3]] & 1;
  const lastClk = state[stBase] & 1;

  if (!lastClk && clk) {
    const mem = _backingStores.get(index);
    const readVal = mem !== undefined ? mem.read(A) : 0;
    state[stBase + 1] = readVal;
    if (str && mem !== undefined) {
      mem.write(A, din);
    }
  }

  state[stBase] = clk;
}

export function executeBlockRAMDualPort(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const outBase = layout.outputOffset(index);
  const stBase = (layout as RAMLayout).stateOffset(index);
  const wt = layout.wiringTable;

  state[wt[outBase]] = state[stBase + 1];
}

export const BLOCK_RAM_DUAL_PORT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [...SHARED_ATTRIBUTE_MAPPINGS];

const BLOCK_RAM_DUAL_PORT_PROPERTY_DEFS: PropertyDefinition[] = [
  ADDR_BITS_DEF, DATA_BITS_DEF, LABEL_DEF, IS_PROGRAM_MEMORY_DEF, DATA_DEF,
];

function blockRAMDualPortFactory(props: PropertyBag): BlockRAMDualPortElement {
  return new BlockRAMDualPortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const BlockRAMDualPortDefinition: ComponentDefinition = {
  name: "BlockRAMDualPort",
  typeId: -1,
  factory: blockRAMDualPortFactory,
  executeFn: executeBlockRAMDualPort,
  sampleFn: sampleBlockRAMDualPort,
  pinLayout: buildBlockRAMDualPortPins(4, 8),
  propertyDefs: BLOCK_RAM_DUAL_PORT_PROPERTY_DEFS,
  attributeMap: BLOCK_RAM_DUAL_PORT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "BlockRAMDualPort — synchronous read block RAM suitable for FPGA block RAM inference.",
  stateSlotCount: (props) => 2 + (1 << (props.getOrDefault<number>("addrBits", 4))),
  defaultDelay: 10,
};
