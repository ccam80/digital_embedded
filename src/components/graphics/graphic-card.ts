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
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 4;
const COMP_HEIGHT = 6;

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
// Pin layout — 6 inputs on west face: A, str, C, ld, B, D(in)
//             1 output on east face: D(out)
// ---------------------------------------------------------------------------

function buildGraphicCardPinDeclarations(
  dataBits: number,
  graphicWidth: number,
  graphicHeight: number,
): PinDeclaration[] {
  const bankSize = graphicWidth * graphicHeight;
  const size = bankSize * 2;
  const addrBits = computeAddrBits(size);

  const inPositions = layoutPinsOnFace("west", 6, COMP_WIDTH, COMP_HEIGHT);
  const outPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);

  return [
    {
      direction: PinDirection.INPUT,
      label: "A",
      defaultBitWidth: addrBits,
      position: inPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "str",
      defaultBitWidth: 1,
      position: inPositions[1],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "C",
      defaultBitWidth: 1,
      position: inPositions[2],
      isNegatable: false,
      isClockCapable: true,
    },
    {
      direction: PinDirection.INPUT,
      label: "ld",
      defaultBitWidth: 1,
      position: inPositions[3],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: 1,
      position: inPositions[4],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "D",
      defaultBitWidth: dataBits,
      position: inPositions[5],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "D",
      defaultBitWidth: dataBits,
      position: outPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// GraphicCardElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class GraphicCardElement extends AbstractCircuitElement {
  private readonly _dataBits: number;
  private readonly _graphicWidth: number;
  private readonly _graphicHeight: number;
  private readonly _bankSize: number;
  private readonly _addrBits: number;
  private readonly _pins: readonly Pin[];

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

    this._dataBits = props.getOrDefault<number>("dataBits", DEFAULT_DATA_BITS);
    this._graphicWidth = props.getOrDefault<number>("graphicWidth", DEFAULT_GRAPHIC_WIDTH);
    this._graphicHeight = props.getOrDefault<number>("graphicHeight", DEFAULT_GRAPHIC_HEIGHT);
    this._bankSize = this._graphicWidth * this._graphicHeight;
    this._addrBits = computeAddrBits(this._bankSize * 2);

    this._memory = new Uint32Array(this._bankSize * 2);
    this._lastClk = false;
    this._dataOut = 0;

    const decls = buildGraphicCardPinDeclarations(
      this._dataBits,
      this._graphicWidth,
      this._graphicHeight,
    );
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>(["C"]) },
    );
  }

  get dataBits(): number {
    return this._dataBits;
  }

  get graphicWidth(): number {
    return this._graphicWidth;
  }

  get graphicHeight(): number {
    return this._graphicHeight;
  }

  get bankSize(): number {
    return this._bankSize;
  }

  get addrBits(): number {
    return this._addrBits;
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
      const memSize = this._bankSize * 2;
      const safeAddr = addr % memSize;
      this._memory[safeAddr] = dataIn >>> 0;
    }

    if (ld) {
      const memSize = this._bankSize * 2;
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
    const memSize = this._bankSize * 2;
    if (addr < 0 || addr >= memSize) return 0;
    return this._memory[addr] >>> 0;
  }

  /**
   * Write a word to the framebuffer memory directly.
   * Used for testing and pre-loading.
   */
  writeMemory(addr: number, value: number): void {
    const memSize = this._bankSize * 2;
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
    const offset = bank ? this._bankSize : 0;
    return new Uint32Array(this._memory.buffer, offset * 4, this._bankSize);
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

    ctx.save();

    // Component body
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    // Screen icon — small rectangle representing a display
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0.5, 0.8, COMP_WIDTH - 1, COMP_HEIGHT - 2.0, false);

    // Pixel grid icon (2x2 dot pattern)
    const dotRadius = 0.12;
    const gridOffsets = [0.9, 1.7];
    ctx.setColor("COMPONENT");
    for (const gy of gridOffsets) {
      for (const gx of [0.9, 1.7, 2.5]) {
        ctx.drawCircle(gx, gy, dotRadius, true);
      }
    }

    // Label
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.55 });
    ctx.drawText("Graphic", COMP_WIDTH / 2, COMP_HEIGHT - 1.0, {
      horizontal: "center",
      vertical: "top",
    });
    ctx.drawText("Card", COMP_WIDTH / 2, COMP_HEIGHT - 0.4, {
      horizontal: "center",
      vertical: "top",
    });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "GraphicCard — memory-mapped graphics framebuffer with double buffering.\n" +
      "Inputs: A (address), str (store strobe), C (clock), ld (load/read), B (bank select), D (data in).\n" +
      "Output: D (data out, high-Z when ld=0).\n" +
      "On rising clock edge with str=1: data is written to memory[A].\n" +
      "When ld=1: memory[A] is output on D.\n" +
      "B selects which memory bank is shown in the display panel.\n" +
      "dataBits: bit width of data bus (default 8).\n" +
      "graphicWidth/graphicHeight: display resolution (default 160x100)."
    );
  }
}

// ---------------------------------------------------------------------------
// executeGraphicCard — read inputs, pack into output slot for engine tracking
// ---------------------------------------------------------------------------

export function executeGraphicCard(
  index: number,
  state: Uint32Array,
  layout: ComponentLayout,
): void {
  const inputStart = layout.inputOffset(index);
  // Inputs: [A=0, str=1, C=2, ld=3, B=4, D=5]
  const addr = state[inputStart] >>> 0;
  const str = state[inputStart + 1] & 1;
  const clk = state[inputStart + 2] & 1;
  const ld = state[inputStart + 3] & 1;
  const bank = state[inputStart + 4] & 1;
  const dataIn = state[inputStart + 5] >>> 0;

  // Pack control signals and low bits of addr/data into output slot
  // for change detection by the engine post-step hook
  const outputIdx = layout.outputOffset(index);
  state[outputIdx] =
    ((addr & 0xFFFF) << 0) |
    (str << 16) |
    (clk << 17) |
    (ld << 18) |
    (bank << 19) |
    ((dataIn & 0xFF) << 20);
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
  executeFn: executeGraphicCard,
  pinLayout: buildGraphicCardPinDeclarations(
    DEFAULT_DATA_BITS,
    DEFAULT_GRAPHIC_WIDTH,
    DEFAULT_GRAPHIC_HEIGHT,
  ),
  propertyDefs: GRAPHIC_CARD_PROPERTY_DEFS,
  attributeMap: GRAPHIC_CARD_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.GRAPHICS,
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
