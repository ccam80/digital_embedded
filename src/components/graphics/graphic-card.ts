/**
 * GraphicCard component — memory-mapped graphics framebuffer with double buffering.
 *
 * Inputs:
 *   - A: addrBits-wide — memory address
 *   - str: 1-bit — store strobe (write enable, sampled on rising clock)
 *   - C: 1-bit — clock (rising edge triggers write when str=1)
 *   - ld: 1-bit — load (read enable, output data at address)
 *   - B: 1-bit — bank select (selects which bank is displayed)
 *   - D: dataBits-wide — data input/output (bidirectional)
 *
 * Output:
 *   - D: dataBits-wide — data output (high-Z when ld=0)
 *
 * The framebuffer has two banks of (graphicWidth * graphicHeight) pixels.
 * On rising clock with str=1, data is written to memory[addr].
 * When ld=1, memory[addr] is output on D. Otherwise D is high-Z (0).
 * B selects which bank is visible in the display panel.
 *
 * Address bits are computed as ceil(log2(2 * width * height)).
 *
 * internalStateCount: 0 (framebuffer stored on the element, accessed via
 * engine post-step hook calling element.processInputs()).
 *
 * The executeFn packs A/str/C/ld/B/D into output slots for engine tracking.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import { drawGenericShape, genericShapeBounds } from "../generic-shape.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
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
// Java GraphicCard uses GenericShape: 5 inputs (A, str, C, ld, B), 1 output (D), width=3
// symmetric (1 output) → offs = floor(5/2) = 2
// Input positions: A@(0,0), str@(0,1), C@(0,2), ld@(0,3), B@(0,4)
// Output position: D@(3,2)  [offs=2]
// → COMP_WIDTH=3, COMP_HEIGHT=5
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;

const DEFAULT_DATA_BITS = 8;
const DEFAULT_GRAPHIC_WIDTH = 160;
const DEFAULT_GRAPHIC_HEIGHT = 100;

// ---------------------------------------------------------------------------
// Address bit computation
// ---------------------------------------------------------------------------

/**
 * Compute the number of address bits needed to address a memory of the
 * given size. size = 2 * graphicWidth * graphicHeight (double-buffered).
 */
function computeAddrBits(size: number): number {
  let bits = 1;
  while ((1 << bits) < size) bits++;
  return bits;
}

// ---------------------------------------------------------------------------
// Pin layout — Java GenericShape(5 inputs, 1 output, width=3, symmetric):
//   offs = floor(5/2) = 2
//   A   (input)  at (0, 0)
//   str (input)  at (0, 1)
//   C   (input)  at (0, 2)
//   ld  (input)  at (0, 3)
//   B   (input)  at (0, 4)
//   D   (output) at (3, 2)   [offs=2]
// ---------------------------------------------------------------------------

function buildGraphicCardPinDeclarations(
  dataBits: number,
  graphicWidth: number,
  graphicHeight: number,
): PinDeclaration[] {
  const bankSize = graphicWidth * graphicHeight;
  const size = bankSize * 2;
  const addrBits = computeAddrBits(size);

  return [
    {
      direction: PinDirection.INPUT,
      label: "A",
      defaultBitWidth: addrBits,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "str",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "C",
      defaultBitWidth: 1,
      position: { x: 0, y: 2 },
      isNegatable: false,
      isClockCapable: true,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "ld",
      defaultBitWidth: 1,
      position: { x: 0, y: 3 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 0, y: 4 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "D",
      defaultBitWidth: dataBits,
      position: { x: COMP_WIDTH, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// GraphicCardElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class GraphicCardElement extends AbstractCircuitElement {
  /**
   * Flat memory array holding both banks:
   *   bank 0: indices [0, bankSize)
   *   bank 1: indices [bankSize, 2*bankSize)
   */
  private readonly _memory: Uint32Array;

  /** Previous clock value for rising-edge detection. */
  private _lastClk: boolean;

  /** Current output value (driven on D when ld=1, else high-Z=0). */
  private _dataOut: number;

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("GraphicCard", instanceId, position, rotation, mirror, props);

    const graphicWidth = props.getOrDefault<number>("graphicWidth", DEFAULT_GRAPHIC_WIDTH);
    const graphicHeight = props.getOrDefault<number>("graphicHeight", DEFAULT_GRAPHIC_HEIGHT);
    const bankSize = graphicWidth * graphicHeight;

    this._memory = new Uint32Array(bankSize * 2);
    this._lastClk = false;
    this._dataOut = 0;
  }

  get dataBits(): number {
    return this._properties.getOrDefault<number>("dataBits", DEFAULT_DATA_BITS);
  }

  get graphicWidth(): number {
    return this._properties.getOrDefault<number>("graphicWidth", DEFAULT_GRAPHIC_WIDTH);
  }

  get graphicHeight(): number {
    return this._properties.getOrDefault<number>("graphicHeight", DEFAULT_GRAPHIC_HEIGHT);
  }

  get bankSize(): number {
    return this.graphicWidth * this.graphicHeight;
  }

  get addrBits(): number {
    return computeAddrBits(this.bankSize * 2);
  }

  /**
   * Process a simulation step with the given inputs.
   * Called by the engine post-step hook.
   *
   * On rising clock edge with str=1: write data to memory[addr].
   * When ld=1: output memory[addr] on D.
   */
  processInputs(
    addr: number,
    str: boolean,
    clk: boolean,
    ld: boolean,
    _bank: boolean,
    dataIn: number,
  ): void {
    const risingClk = clk && !this._lastClk;

    if (risingClk && str) {
      // Clamp addr to valid range
      const memSize = this.bankSize * 2;
      const safeAddr = addr % memSize;
      this._memory[safeAddr] = dataIn >>> 0;
    }

    if (ld) {
      const memSize = this.bankSize * 2;
      const safeAddr = addr % memSize;
      this._dataOut = this._memory[safeAddr] >>> 0;
    } else {
      this._dataOut = 0; // high-Z represented as 0
    }

    this._lastClk = clk;
  }

  /**
   * Read the current data output value.
   * Returns 0 when ld=0 (high-Z).
   */
  get dataOut(): number {
    return this._dataOut;
  }

  /**
   * Read a word from the framebuffer memory directly.
   * addr is a flat index into the double-buffered memory.
   */
  readMemory(addr: number): number {
    const memSize = this.bankSize * 2;
    if (addr < 0 || addr >= memSize) return 0;
    return this._memory[addr] >>> 0;
  }

  /**
   * Write a word to the framebuffer memory directly.
   * Used for testing and pre-loading.
   */
  writeMemory(addr: number, value: number): void {
    const memSize = this.bankSize * 2;
    if (addr >= 0 && addr < memSize) {
      this._memory[addr] = value >>> 0;
    }
  }

  /**
   * Returns a snapshot of the display bank's pixel data.
   * bank=false → bank 0 (indices 0..bankSize-1)
   * bank=true  → bank 1 (indices bankSize..2*bankSize-1)
   */
  getDisplayBank(bank: boolean): Uint32Array {
    const offset = bank ? this.bankSize : 0;
    return new Uint32Array(this._memory.buffer, offset * 4, this.bankSize);
  }

  /**
   * Returns a snapshot copy of the full memory array.
   */
  getMemorySnapshot(): Uint32Array {
    return new Uint32Array(this._memory);
  }

  /** Clear all memory and reset state (called on simulation reset). */
  clearMemory(): void {
    this._memory.fill(0);
    this._lastClk = false;
    this._dataOut = 0;
  }

  getPins(): readonly Pin[] {
    return resolvePins(
      buildGraphicCardPinDeclarations(this.dataBits, this.graphicWidth, this.graphicHeight),
      { x: 0, y: 0 },
      0,
      createInverterConfig([]),
      { clockPins: new Set<string>(["C"]) },
    );
  }

  getBoundingBox(): Rect {
    const b = genericShapeBounds(5, 1, COMP_WIDTH);
    return { x: this.position.x + b.localX, y: this.position.y + b.localY, width: b.width, height: b.height };
  }

  draw(ctx: RenderContext): void {
    const label = this._visibleLabel();
    drawGenericShape(ctx, {
      inputLabels: ["A", "str", "C", "ld", "B"],
      outputLabels: ["D"],
      clockInputIndices: [2],
      componentName: "Gr-RAM",
      width: COMP_WIDTH,
      ...(label.length > 0 ? { label } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// executeGraphicCard — read inputs, pack into output slot for engine tracking
// ---------------------------------------------------------------------------

export function executeGraphicCard(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  // Inputs: [A=0, str=1, C=2, ld=3, B=4]
  const addr = state[wt[inputStart]] >>> 0;
  const str = state[wt[inputStart + 1]] & 1;
  const clk = state[wt[inputStart + 2]] & 1;
  const ld = state[wt[inputStart + 3]] & 1;
  const bank = state[wt[inputStart + 4]] & 1;

  // Pack control signals and low bits of addr into output slot (D)
  // for change detection by the engine post-step hook
  const outputIdx = layout.outputOffset(index);
  state[wt[outputIdx]] =
    ((addr & 0xFFFF) << 0) |
    (str << 16) |
    (clk << 17) |
    (ld << 18) |
    (bank << 19);
}

// ---------------------------------------------------------------------------
// GRAPHIC_CARD_ATTRIBUTE_MAPPINGS — .dig XML attribute → PropertyBag
// ---------------------------------------------------------------------------

export const GRAPHIC_CARD_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Bits",
    propertyKey: "dataBits",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "graphicWidth",
    propertyKey: "graphicWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "graphicHeight",
    propertyKey: "graphicHeight",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const GRAPHIC_CARD_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label for the component",
  },
  {
    key: "dataBits",
    type: PropertyType.BIT_WIDTH,
    label: "Data bits",
    defaultValue: DEFAULT_DATA_BITS,
    min: 1,
    max: 32,
    description: "Bit width of the data bus",
  },
  {
    key: "graphicWidth",
    type: PropertyType.INT,
    label: "Graphic width",
    defaultValue: DEFAULT_GRAPHIC_WIDTH,
    min: 1,
    max: 1920,
    description: "Display width in pixels",
  },
  {
    key: "graphicHeight",
    type: PropertyType.INT,
    label: "Graphic height",
    defaultValue: DEFAULT_GRAPHIC_HEIGHT,
    min: 1,
    max: 1200,
    description: "Display height in pixels",
  },
];

// ---------------------------------------------------------------------------
// GraphicCardDefinition — ComponentDefinition for registry registration
// ---------------------------------------------------------------------------

function graphicCardFactory(props: PropertyBag): GraphicCardElement {
  return new GraphicCardElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const GraphicCardDefinition: ComponentDefinition = {
  name: "GraphicCard",
  typeId: -1,
  factory: graphicCardFactory,
  pinLayout: buildGraphicCardPinDeclarations(
    DEFAULT_DATA_BITS,
    DEFAULT_GRAPHIC_WIDTH,
    DEFAULT_GRAPHIC_HEIGHT,
  ),
  propertyDefs: GRAPHIC_CARD_PROPERTY_DEFS,
  attributeMap: GRAPHIC_CARD_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.GRAPHICS,
  models: {
    digital: {
      executeFn: executeGraphicCard,
      inputSchema: ["A", "str", "C", "ld", "B"],
      outputSchema: ["D"],
    },
  },
  helpText:
    "GraphicCard — memory-mapped graphics framebuffer with double buffering.\n" +
    "Inputs: A (address), str (store strobe), C (clock), ld (load/read), B (bank select), D (data in).\n" +
    "Output: D (data out, high-Z when ld=0).\n" +
    "On rising clock edge with str=1: data is written to memory[A].\n" +
    "When ld=1: memory[A] is output on D.\n" +
    "B selects which memory bank is shown in the display panel.\n" +
    "dataBits: bit width of data bus (default 8).\n" +
    "graphicWidth/graphicHeight: display resolution (default 160x100).",
};
